import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Review, ReviewError } from './review.js';
import { Storage } from './storage.js';
import { Twitch, ProviderError } from './twitch.js';
import { validImage } from './evidence.js';
import { importExportFolder } from './export-import.js';
import { DeviceAuth } from './device-auth.js';
import { twitchConfiguration } from './config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CROSSBAN_PORT ?? 4387);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
const origin = `http://localhost:${port}`;
const redirect = `${origin}/auth/twitch/callback`;
const csrf = randomBytes(32).toString('hex');
const storage = new Storage(process.env.CROSSBAN_DATA_DIR ? resolve(process.env.CROSSBAN_DATA_DIR) : resolve(root, 'data'));
const configuration = twitchConfiguration();
const twitch = new Twitch(storage, configuration.clientId, configuration.clientSecret);
const deviceAuth = new DeviceAuth(twitch.clientId);
const review = new Review(storage, twitch);
let ready = false;
let validationTimer: ReturnType<typeof setInterval> | undefined;
let oauth: { state: string; cookie: string; expires: number } | null = null;
let deviceCookie = '';

function state() {
    return { csrf, configured: twitch.configured, authMode: twitch.usesDeviceLogin ? 'device' : 'code', auth: twitch.user, reports: storage.database.reports,
        history: storage.database.history, importSummary: storage.database.importSummary, busy: review.busy };
}

function json(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}

function constantEqual(value: string, expected: string): boolean {
    const bytes = Buffer.from(value);
    const expectedBytes = Buffer.from(expected);
    return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new ReviewError('Use JSON requests.', 415);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) throw new ReviewError('Upload too large. Use an image below 8 MB.', 413);
        chunks.push(chunk);
    }
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
    } catch { throw new ReviewError('Invalid JSON request.'); }
}

function stringField(input: Record<string, unknown>, field: string): string {
    const value = input[field];
    if (typeof value !== 'string') throw new ReviewError(`Missing ${field}.`);
    return value;
}

function idsField(input: Record<string, unknown>): string[] {
    if (!Array.isArray(input.ids) || input.ids.some(id => typeof id !== 'string') || input.ids.length > 10000) throw new ReviewError('Invalid report selection.');
    return input.ids as string[];
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://static-cdn.jtvnw.net; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(req.headers.host ?? '')) throw new ReviewError('Invalid local host.', 403);
    if (req.headers.origin && ![origin, `http://127.0.0.1:${port}`].includes(req.headers.origin)) throw new ReviewError('Only the local review screen may call this tool.', 403);
    const url = new URL(req.url ?? '/', origin);
    if (req.headers['sec-fetch-site'] === 'cross-site' && url.pathname !== '/auth/twitch/callback') throw new ReviewError('Cross-site requests are blocked.', 403);

    if (req.method === 'GET' && url.pathname === '/auth/twitch/callback') {
        const pending = oauth;
        oauth = null;
        const cookies = req.headers.cookie ?? '';
        const cookie = cookies.split(';').map(part => part.trim()).find(part => part.startsWith('crossban_oauth='))?.slice('crossban_oauth='.length) ?? '';
        res.setHeader('Set-Cookie', 'crossban_oauth=; HttpOnly; SameSite=Lax; Path=/auth/twitch/callback; Max-Age=0');
        if (!pending || pending.expires < Date.now() || !constantEqual(url.searchParams.get('state') ?? '', pending.state)
            || !constantEqual(cookie, pending.cookie)) throw new ReviewError('Twitch connection link expired or belongs to another browser. Start again.', 403);
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.has('error')) throw new ReviewError('Twitch connection was cancelled. Return to the review screen and try again.');
        await review.exclusive(async () => { review.invalidate(); await twitch.connect(code, redirect); });
        res.writeHead(303, { Location: '/' });
        res.end();
        return;
    }
    if (req.method === 'GET') {
        if (url.pathname === '/api/state') return json(res, state());
        if (url.pathname === '/api/channels') return json(res, { channels: await review.exclusive(() => twitch.channels()) });
        const staticFiles: Record<string, [string, string]> = {
            '/': ['public/index.html', 'text/html; charset=utf-8'],
            '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
            '/i18n.js': ['public/i18n.js', 'text/javascript; charset=utf-8'],
            '/device-login.js': ['public/device-login.js', 'text/javascript; charset=utf-8'],
            '/browser-ui.js': ['public/browser-ui.js', 'text/javascript; charset=utf-8'],
            '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
            '/README.md': ['README.md', 'text/plain; charset=utf-8'],
        };
        const staticFile = staticFiles[url.pathname];
        if (staticFile) {
            const bytes = await readFile(resolve(root, staticFile[0]));
            res.writeHead(200, { 'Content-Type': staticFile[1] });
            res.end(bytes);
            return;
        }
        if (/^\/evidence\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(url.pathname)) {
            const bytes = await readFile(resolve(storage.directory, url.pathname.slice(1))).catch(() => { throw new ReviewError('Evidence not found.', 404); });
            const mime = url.pathname.endsWith('.png') ? 'image/png' : url.pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(bytes);
            return;
        }
        throw new ReviewError('Not found.', 404);
    }
    if (!['POST', 'PATCH'].includes(req.method ?? '')) throw new ReviewError('Method not allowed.', 405);
    if (!constantEqual(String(req.headers['x-csrf-token'] ?? ''), csrf)) throw new ReviewError('Refresh the local review screen before continuing.', 403);
    const input = await body(req);
    const result = await review.exclusive(async () => {
        if (url.pathname === '/api/auth/start' && req.method === 'POST') {
            deviceAuth.cancel(); oauth = null;
            if (twitch.usesDeviceLogin) {
                const login = await deviceAuth.start();
                deviceCookie = randomBytes(32).toString('hex');
                res.setHeader('Set-Cookie', `crossban_device=${deviceCookie}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=1800`);
                return { mode: 'device', login };
            }
            const pending = { state: randomBytes(32).toString('hex'), cookie: randomBytes(32).toString('hex'), expires: Date.now() + 10 * 60000 };
            const authUrl = twitch.authorizeUrl(pending.state, redirect);
            oauth = pending;
            res.setHeader('Set-Cookie', `crossban_oauth=${pending.cookie}; HttpOnly; SameSite=Lax; Path=/auth/twitch/callback; Max-Age=600`);
            return { url: authUrl };
        }
        if (url.pathname === '/api/auth/poll' && req.method === 'POST') {
            const cookie = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('crossban_device='))?.slice('crossban_device='.length) ?? '';
            if (!deviceCookie || !constantEqual(cookie, deviceCookie)) throw new ReviewError('Start Twitch login in this browser first.', 403);
            const tokens = await deviceAuth.poll(stringField(input, 'loginId'));
            if (!tokens) return { pending: true };
            deviceCookie = '';
            review.invalidate();
            await twitch.connectTokens(tokens);
            return state();
        }
        if (url.pathname === '/api/auth/cancel' && req.method === 'POST') {
            deviceAuth.cancel(); deviceCookie = ''; oauth = null;
            return state();
        }
        if (url.pathname === '/api/auth/disconnect' && req.method === 'POST') {
            review.invalidate(); oauth = null; deviceAuth.cancel(); deviceCookie = ''; await twitch.disconnect();
        } else if (url.pathname === '/api/import' && req.method === 'POST') {
            const text = stringField(input, 'text');
            if (text.length > 1000000) throw new ReviewError('Import fewer than one million characters at a time.');
            await review.import(text);
        } else if (url.pathname === '/api/import/export' && req.method === 'POST') {
            await importExportFolder(review, resolve(root, 'export'));
        } else if (url.pathname === '/api/resolve' && req.method === 'POST') await review.resolve(input.ids === undefined ? undefined : idsField(input));
        else if (url.pathname === '/api/prepare' && req.method === 'POST') return review.prepare(idsField(input), stringField(input, 'channelId'), input.reviewed === true);
        else if (url.pathname === '/api/execute' && req.method === 'POST') await review.execute(stringField(input, 'planId'), stringField(input, 'confirmation'));
        else if (url.pathname === '/api/unban' && req.method === 'POST') await review.unban(stringField(input, 'historyId'), stringField(input, 'confirmation'));
        else if (url.pathname === '/api/reconcile' && req.method === 'POST') await review.reconcile(stringField(input, 'historyId'), stringField(input, 'outcome'), input.reviewed === true);
        else {
            const match = /^\/api\/reports\/([a-f0-9-]+)(\/evidence)?$/.exec(url.pathname);
            if (!match) throw new ReviewError('Not found.', 404);
            const report = review.report(match[1]!);
            if (match[2] && req.method === 'POST') {
                const dataUrl = stringField(input, 'dataUrl');
                const image = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
                if (!image) throw new ReviewError('Use a PNG, JPEG or WebP screenshot.');
                const bytes = Buffer.from(image[2]!, 'base64');
                if (bytes.length > 8 * 1024 * 1024 || !validImage(bytes, image[1]!)) throw new ReviewError('Invalid screenshot or file exceeds 8 MB.');
                if (report.evidence.length >= 20) throw new ReviewError('At most 20 screenshots per report.');
                const extension = image[1] === 'image/png' ? 'png' : image[1] === 'image/jpeg' ? 'jpg' : 'webp';
                const filename = `${randomBytes(16).toString('hex')}.${extension}`;
                await writeFile(resolve(storage.directory, 'evidence', filename), bytes, { mode: 0o600 });
                report.evidence.push(`/evidence/${filename}`);
                if (report.decision === 'approved') report.decision = 'pending';
                review.invalidate();
                await storage.save();
            } else if (!match[2] && req.method === 'PATCH') await review.update(report.id, input);
            else throw new ReviewError('Method not allowed.', 405);
        }
        return undefined;
    });
    json(res, result ?? state());
}

const server = createServer((req, res) => {
    if (!ready) { json(res, { error: 'The local workspace is starting. Refresh in a moment.' }, 503); return; }
    route(req, res).catch(error => {
        if (res.headersSent) { res.end(); return; }
        if (error instanceof ReviewError || error instanceof ProviderError) json(res, { error: error.message }, error.status >= 500 ? 502 : error.status);
        else { console.error('Local operation failed. No provider request will be retried automatically.'); json(res, { error: 'Local operation failed. Check disk access; review history before retrying.' }, 500); }
    });
});
server.requestTimeout = 30000;
try {
    await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); accept(); });
    });
    await storage.initialize();
    await twitch.initialize();
    ready = true;
    validationTimer = setInterval(() => {
        if (twitch.user && !review.busy) {
            review.exclusive(() => twitch.validateConnection()).catch(() => console.log('Twitch connection could not be validated. Reconnect if actions report an authorization error.'));
        }
    }, 30 * 60000);
    validationTimer.unref();
    console.log(`Crossban Review: ${origin}\nLocal data: ${storage.directory}\nPress Ctrl+C to stop.`);
    if (process.platform === 'win32' && process.argv.includes('--open')) {
        const language = process.env.CROSSBAN_UI_LANGUAGE;
        const openUrl = language === 'en' || language === 'nl' ? `${origin}/?lang=${language}` : origin;
        const browser = spawn('explorer.exe', [openUrl], { detached: true, stdio: 'ignore', windowsHide: true });
        browser.on('error', () => console.log(`Open ${openUrl} in your browser.`));
        browser.unref();
    }
} catch (error) {
    console.error(`Cannot start local tool: ${(error as NodeJS.ErrnoException).code ?? 'check local workspace files'}. Another launcher may already be running.`);
    server.close();
    process.exitCode = 1;
}
server.on('error', error => { console.error(`Cannot start local tool: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`); process.exitCode = 1; });
server.on('close', () => { if (validationTimer) clearInterval(validationTimer); });
