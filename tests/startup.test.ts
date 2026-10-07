import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode !== null) continue;
        await new Promise<void>(accept => { child.once('exit', () => accept()); child.kill(); });
    }
    for (const directory of directories.splice(0)) {
        const absolute = resolve(directory);
        if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('crossban startup ')) {
            throw new Error('Refusing to remove an unexpected startup test directory.');
        }
        await rm(absolute, { recursive: true, force: true });
    }
});

async function workspace() {
    const directory = await mkdtemp(join(tmpdir(), 'crossban startup '));
    directories.push(directory);
    return directory;
}

async function start(language: string) {
    const probe = createServer();
    await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Missing local test port.');
    await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: resolve('.'), env: { ...process.env, CROSSBAN_PORT: String(address.port), CROSSBAN_DATA_DIR: await workspace(),
            CROSSBAN_UI_LANGUAGE: language, TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error('Local test server did not start.')), 10_000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local test server exited: ${code}.`)); });
        child.stdout?.on('data', chunk => {
            if (String(chunk).includes('Crossban Review:')) { clearTimeout(timeout); accept(); }
        });
    });
    return `http://localhost:${address.port}`;
}

describe('local startup language', { timeout: 15_000 }, () => {
    it.each(['en', 'nl'])('uses the selected %s language for manually opened URLs and preserves explicit choices', async language => {
        const origin = await start(language);
        const home = await fetch(`${origin}/?keep=yes`, { redirect: 'manual' });
        expect(home.status).toBe(303);
        expect(home.headers.get('location')).toBe(`/?keep=yes&lang=${language}`);
        const opposite = language === 'nl' ? 'en' : 'nl';
        const explicit = await fetch(`${origin}/?lang=${opposite}`, { redirect: 'manual' });
        expect(explicit.status).toBe(200);
        expect(await explicit.text()).toContain('id="language"');
        const api = await fetch(`${origin}/api/state`);
        expect(api.status).toBe(200);
        expect(await api.json()).toMatchObject({ reports: [], auth: null });
    });

    it('leaves manual startup without a valid launcher language to the browser preference', async () => {
        const origin = await start('invalid');
        expect((await fetch(`${origin}/`, { redirect: 'manual' })).status).toBe(200);
    });
});

describe.skipIf(process.platform !== 'win32')('Windows default browser dispatch', { timeout: 15_000 }, () => {
    it('passes the complete localized URL to the registered handler and reports handler failures', async () => {
        const directory = await workspace();
        const helper = join(directory, 'dispatch-test.ps1');
        await writeFile(helper, `param([string]$Script, [string]$Url, [string]$Log, [switch]$Fail)
function Start-Process {
    param([string]$FilePath)
    if ($Fail) { throw 'No default browser handler' }
    [IO.File]::WriteAllText($Log, $FilePath)
}
& $Script -Url $Url
`, 'utf8');
        const log = join(directory, 'opened-url.txt');
        const script = resolve('scripts/Open-Browser.ps1');
        const url = 'http://localhost:4387/?lang=nl';
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
            '-Script', script, '-Url', url, '-Log', log];
        const success = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
        expect(success.status, success.stderr).toBe(0);
        expect(await readFile(log, 'utf8')).toBe(url);
        expect(spawnSync('powershell.exe', [...args, '-Fail'], { encoding: 'utf8', windowsHide: true }).status).not.toBe(0);
    });
});
