import { BrowserStorage } from './browser-storage.js';
import { decodeBase64, exportBrowserBackup, importBrowserBackup } from './browser-backup.js';
import { Review, ReviewError } from './review.js';
import { Twitch } from './twitch.js';
import { DeviceAuth } from './device-auth.js';
import { validImage } from './evidence.js';
import { importBrowserExport } from './browser-export.js';
import { bundledClientId } from './client-id.js';

export interface BrowserRuntime {
    ready: Promise<void>;
    request(path: string, body?: Record<string, unknown>, method?: string): Promise<unknown>;
    dispose(): void;
}

interface RuntimeOptions {
    storage?: BrowserStorage;
    locks?: Pick<LockManager, 'request'> | null;
    twitch?: Twitch;
    review?: Review;
    deviceAuth?: DeviceAuth;
}

function stringField(input: Record<string, unknown>, field: string, max = 1000): string {
    const value = input[field];
    if (typeof value !== 'string') throw new ReviewError(`Missing ${field}.`);
    if (value.length > max) throw new ReviewError(`Invalid ${field}.`);
    return value;
}

function idsField(input: Record<string, unknown>): string[] {
    if (!Array.isArray(input.ids) || input.ids.length > 10000 || input.ids.some(id => typeof id !== 'string' || id.length > 100)) throw new ReviewError('Invalid report selection.');
    return input.ids as string[];
}

export function createBrowserRuntime(options: RuntimeOptions = {}): BrowserRuntime {
    const storage = options.storage ?? new BrowserStorage();
    const twitch = options.twitch ?? new Twitch(storage, bundledClientId, '');
    const review = options.review ?? new Review(storage, twitch);
    const deviceAuth = options.deviceAuth ?? new DeviceAuth(bundledClientId);
    const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
    let readOnly = true;
    let startupError = '';
    let release = () => {};
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const ready = (async () => {
        try {
            if (!locks) throw new Error('This browser cannot safely lock the workspace. Open it in a current browser with Web Locks support.');
            const held = new Promise<void>(resolve => { release = resolve; });
            const acquired = new Promise<boolean>((resolve, reject) => {
                locks.request('crossban-review-workspace', { mode: 'exclusive', ifAvailable: true }, async lock => {
                    resolve(!!lock);
                    if (lock) await held;
                }).catch(reject);
            });
            if (!await acquired) {
                startupError = 'Another tab owns this workspace. Close it and reload this tab to make changes.';
                await storage.initialize(false);
                return;
            }
            if (disposed) return;
            await storage.initialize();
            if (disposed) return;
            await twitch.initialize();
            if (disposed) return;
            readOnly = false;
            timer = setInterval(() => {
                if (twitch.user && !review.busy) review.exclusive(() => twitch.validateConnection()).catch(() => {});
            }, 30 * 60000);
            timer.unref?.();
        } catch (error) {
            startupError = error instanceof Error ? error.message : 'Browser workspace could not start. Check browser storage access and reload.';
            release();
        }
    })();

    async function state() {
        const unavailable = readOnly || storage.failed;
        const error = startupError || (storage.failed ? storage.failureMessage : '');
        return { csrf: 'browser', configured: true, authMode: 'device', auth: twitch.user,
            reports: structuredClone(storage.database.reports), history: structuredClone(storage.database.history),
            importSummary: structuredClone(storage.database.importSummary), busy: unavailable || review.busy,
            environment: 'browser', readOnly: unavailable, ...(error ? { error } : {}),
            evidenceUrls: startupError && !storage.database.reports.length ? {} : await storage.evidenceUrls() };
    }

    async function request(path: string, input: Record<string, unknown> = {}, method = 'GET'): Promise<unknown> {
        await ready;
        if (disposed) throw new ReviewError('This browser workspace was closed. Reload to continue.', 409);
        if (path === '/api/state' && method === 'GET') return state();
        if (readOnly) throw new ReviewError(startupError || 'This workspace is read-only. Reload to continue.', 409);
        storage.assertWritable();
        if (path === '/api/channels' && method === 'GET') return review.exclusive(async () => ({ channels: await twitch.channels() }));
        if (path === '/api/backup' && method === 'GET') return review.exclusive(() => exportBrowserBackup(storage));
        if (!['POST', 'PATCH'].includes(method)) throw new ReviewError('Method not allowed.', 405);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReviewError('Invalid JSON request.');
        try {
            const value = await review.exclusive(async () => {
                if (path === '/api/auth/start' && method === 'POST') {
                    deviceAuth.cancel();
                    return { mode: 'device', login: await deviceAuth.start() };
                }
                if (path === '/api/auth/poll' && method === 'POST') {
                    const tokens = await deviceAuth.poll(stringField(input, 'loginId'));
                    if (!tokens) return { pending: true };
                    review.invalidate(); await twitch.connectTokens(tokens);
                } else if (path === '/api/auth/cancel' && method === 'POST') deviceAuth.cancel();
                else if (path === '/api/auth/disconnect' && method === 'POST') {
                    review.invalidate(); deviceAuth.cancel(); await twitch.disconnect();
                } else if (path === '/api/import' && method === 'POST') await review.import(stringField(input, 'text', 1000000));
                else if (path === '/api/import/export' && method === 'POST') {
                    if (!Array.isArray(input.files) || input.files.length > 100000 || input.files.some(file => !(file instanceof File))) throw new ReviewError('Choose a Discord export folder.');
                    await importBrowserExport(review, storage, input.files);
                } else if (path === '/api/backup/import' && method === 'POST') {
                    review.invalidate();
                    await importBrowserBackup(storage, input.backup);
                    deviceAuth.cancel(); await twitch.disconnect();
                } else if (path === '/api/resolve' && method === 'POST') await review.resolve(input.ids === undefined ? undefined : idsField(input));
                else if (path === '/api/prepare' && method === 'POST') return review.prepare(idsField(input), stringField(input, 'channelId'), input.reviewed === true);
                else if (path === '/api/execute' && method === 'POST') await review.execute(stringField(input, 'planId'), stringField(input, 'confirmation'));
                else if (path === '/api/unban' && method === 'POST') await review.unban(stringField(input, 'historyId'), stringField(input, 'confirmation'));
                else if (path === '/api/reconcile' && method === 'POST') await review.reconcile(stringField(input, 'historyId'), stringField(input, 'outcome'), input.reviewed === true);
                else {
                    const match = /^\/api\/reports\/([a-f0-9-]{1,100})(\/evidence)?$/.exec(path);
                    if (!match) throw new ReviewError('Not found.', 404);
                    if (match[2] && method === 'POST') {
                        const report = review.report(match[1]!);
                        const dataUrl = stringField(input, 'dataUrl', 12 * 1024 * 1024);
                        const image = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
                        if (!image) throw new ReviewError('Use a PNG, JPEG or WebP screenshot.');
                        const bytes = decodeBase64(image[2]!);
                        if (bytes.length > 8 * 1024 * 1024 || !validImage(bytes, image[1]!)) throw new ReviewError('Invalid screenshot or file exceeds 8 MB.');
                        if (report.evidence.length >= 20) throw new ReviewError('At most 20 screenshots per report.');
                        const extension = image[1] === 'image/png' ? 'png' : image[1] === 'image/jpeg' ? 'jpg' : 'webp';
                        const name = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
                        const path = `/evidence/${name}.${extension}`;
                        report.evidence.push(path);
                        if (report.decision === 'approved') report.decision = 'pending';
                        review.invalidate();
                        await storage.saveWithAssets(new Map([[path, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: image[1] })]]));
                    } else if (!match[2] && method === 'PATCH') await review.update(match[1]!, input);
                    else throw new ReviewError('Method not allowed.', 405);
                }
                return undefined;
            });
            return value ?? state();
        } catch (error) { review.invalidate(); throw error; }
    }

    return { ready, request, dispose() {
        disposed = true; if (timer) clearInterval(timer);
        deviceAuth.cancel(); review.invalidate();
        void ready.then(() => { storage.close(); release(); });
    } };
}

declare global { interface Window { crossbanRuntime?: BrowserRuntime } }
if (typeof window !== 'undefined') window.crossbanRuntime = createBrowserRuntime();
