import { afterEach, describe, expect, test } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];
afterEach(() => {
    for (const root of temporary.splice(0)) {
        const absolute = resolve(root);
        if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('crossban launcher ')) {
            throw new Error('Refusing to remove an unexpected launcher test directory.');
        }
        rmSync(absolute, { recursive: true, force: true });
    }
});

const windows = process.platform === 'win32';
describe.skipIf(!windows)('Windows release launcher', () => {
    function workspace() {
        const root = mkdtempSync(join(tmpdir(), 'crossban launcher '));
        temporary.push(root);
        mkdirSync(join(root, 'scripts'));
        mkdirSync(join(root, 'tools with spaces'));
        copyFileSync(resolve('scripts/Start-Review.ps1'), join(root, 'scripts/Start-Review.ps1'));
        copyFileSync(resolve('Start.cmd'), join(root, 'Start.cmd'));
        copyFileSync(resolve('.env.example'), join(root, '.env.example'));
        return root;
    }

    function stub(root: string, name: string, content: string) {
        writeFileSync(join(root, 'tools with spaces', `${name}.cmd`), `@echo off\r\n${content.replaceAll('\n', '\r\n')}\r\n`);
    }

    function prerequisites(root: string, pnpmVersion = '11.0.0') {
        stub(root, 'node', 'echo v22.16.0\nexit /b 0');
        stub(root, 'pnpm', `if "%~1"=="--version" (\n echo ${pnpmVersion}\n exit /b 0\n)\necho pnpm %* locale=%CROSSBAN_UI_LANGUAGE%>>"%LAUNCHER_TEST_LOG%"\nif "%~1"=="install" exit /b %LAUNCHER_TEST_INSTALL_EXIT%\nexit /b %LAUNCHER_TEST_SERVER_EXIT%`);
    }

    function run(root: string, answers: string[], extra: Record<string, string> = {}, wrapper = false) {
        const system = process.env.SystemRoot ?? 'C:\\Windows';
        const shell = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const env = {
            ...process.env,
            PATH: `${join(root, 'tools with spaces')};${join(system, 'System32')};${join(system, 'System32/WindowsPowerShell/v1.0')}`,
            LAUNCHER_TEST_LOG: join(root, 'commands.txt'),
            LAUNCHER_TEST_INSTALL_EXIT: '0',
            LAUNCHER_TEST_SERVER_EXIT: '0',
            ...extra,
        };
        const result = wrapper
            ? spawnSync(join(system, 'System32/cmd.exe'), ['/d', '/c', 'Start.cmd'], { cwd: root, env, input: `${answers.join('\n')}\n`, encoding: 'utf8', timeout: 15_000 })
            : spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/Start-Review.ps1')], {
                cwd: root, env, input: `${answers.join('\n')}\n`, encoding: 'utf8', timeout: 15_000,
            });
        expect(result.error).toBeUndefined();
        return { code: result.status, output: result.stdout + result.stderr, log: existsSync(join(root, 'commands.txt')) ? readFileSync(join(root, 'commands.txt'), 'utf8') : '' };
    }

    test('chooses Dutch first, installs locked dependencies every run, and forwards the browser locale', () => {
        const root = workspace();
        prerequisites(root);
        const result = run(root, ['2', '', '']);
        expect(result.code).toBe(0);
        expect(result.output.startsWith('Choose your language:')).toBe(true);
        expect(result.output).toContain('Druk op Enter om dit venster te sluiten');
        expect(result.log).toBe('pnpm install --frozen-lockfile locale=nl\r\npnpm start --open locale=nl\r\n');
        expect(readFileSync(join(root, 'data/launcher-language.txt'), 'utf8')).toBe('nl');
        expect(existsSync(join(root, '.env'))).toBe(false);
        const next = run(root, ['', '', '']);
        expect(next.output).toContain('Language / Taal [2]');
        expect(next.code).toBe(0);
    });

    test('Start.cmd handles an extracted path with spaces', () => {
        const root = workspace();
        prerequisites(root);
        expect(run(root, ['1', '', ''], {}, true).code).toBe(0);
    });

    test('missing Node without winget gives official manual download instructions in Dutch', () => {
        const root = workspace();
        const result = run(root, ['2', '']);
        expect(result.code).toBe(1);
        expect(result.output).toContain('https://nodejs.org/en/download');
        expect(result.output).toContain('Download het Windows');
        expect(result.log).toBe('');
    });

    test('declining an old Node installation never invokes winget', () => {
        const root = workspace();
        stub(root, 'node', 'echo v22.15.0\nexit /b 0');
        stub(root, 'winget', 'echo installer>>"%LAUNCHER_TEST_LOG%"\nexit /b 0');
        const result = run(root, ['1', 'n', '']);
        expect(result.code).toBe(1);
        expect(result.output).toContain('Setup stopped.');
        expect(result.log).toBe('');
    });

    test('failed winget uses the exact official package and does not accept agreements automatically', () => {
        const root = workspace();
        stub(root, 'winget', 'echo winget %*>>"%LAUNCHER_TEST_LOG%"\nexit /b 1');
        const result = run(root, ['1', 'y', '']);
        expect(result.code).toBe(1);
        expect(result.log).toBe('winget install --id OpenJS.NodeJS.LTS --exact --source winget\r\n');
        expect(result.output).toContain('https://nodejs.org/en/download');
    });

    test('declining pnpm leaves the workspace configuration untouched', () => {
        const root = workspace();
        stub(root, 'node', 'echo v24.0.0\nexit /b 0');
        const result = run(root, ['2', 'n', '']);
        expect(result.code).toBe(1);
        expect(result.output).toContain('De installatie is gestopt.');
        expect(existsSync(join(root, 'data/launcher-tools'))).toBe(false);
        expect(existsSync(join(root, '.env'))).toBe(false);
    });

    test('bootstraps local pnpm 11 while preserving incompatible global pnpm and an existing env file', () => {
        const root = workspace();
        prerequisites(root, '10.9.0');
        const globalBefore = readFileSync(join(root, 'tools with spaces/pnpm.cmd'), 'utf8');
        const envContents = 'TWITCH_CLIENT_ID=synthetic_client\nTWITCH_CLIENT_SECRET=synthetic_private_fixture\n';
        writeFileSync(join(root, '.env'), envContents);
        stub(root, 'npm', 'echo npm %*>>"%LAUNCHER_TEST_LOG%"\nmkdir "%~3\\node_modules\\.bin"\ncopy /y "%~dp0local-template.cmd" "%~3\\node_modules\\.bin\\pnpm.cmd" >nul\necho Download complete\nexit /b 0');
        stub(root, 'local-template', 'if "%~1"=="--version" (\n echo 11.3.0\n exit /b 0\n)\necho local-pnpm %* locale=%CROSSBAN_UI_LANGUAGE%>>"%LAUNCHER_TEST_LOG%"\nexit /b 0');
        const result = run(root, ['1', 'y', '']);
        expect(result.code).toBe(0);
        expect(result.log).toContain(`npm install --prefix "${join(root, 'data/launcher-tools')}" --no-audit --no-fund --no-package-lock pnpm@11`);
        expect(result.log).toContain('local-pnpm install --frozen-lockfile locale=en');
        expect(result.log).toContain('local-pnpm start --open locale=en');
        expect(readFileSync(join(root, 'tools with spaces/pnpm.cmd'), 'utf8')).toBe(globalBefore);
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe(envContents);
        expect(result.output).not.toContain('synthetic_private_fixture');
    });

    test('failed pnpm bootstrap stops before dependency installation', () => {
        const root = workspace();
        stub(root, 'node', 'echo v22.16.0\nexit /b 0');
        stub(root, 'npm', 'echo npm %*>>"%LAUNCHER_TEST_LOG%"\nexit /b 1');
        const result = run(root, ['1', 'y', '']);
        expect(result.code).toBe(1);
        expect(result.output).toContain('pnpm could not be installed.');
        expect(result.log).not.toContain('start');
    });

    test('missing npm offers the official Node installer after bootstrap consent', () => {
        const root = workspace();
        stub(root, 'node', 'echo v22.16.0\nexit /b 0');
        const result = run(root, ['2', 'j', '']);
        expect(result.code).toBe(1);
        expect(result.output).toContain('npm ontbreekt.');
        expect(result.output).toContain('https://nodejs.org/en/download');
        expect(result.log).toBe('');
    });

    test('a successful npm exit cannot substitute an incompatible pnpm version', () => {
        const root = workspace();
        stub(root, 'node', 'echo v22.16.0\nexit /b 0');
        stub(root, 'npm', 'mkdir "%~3\\node_modules\\.bin"\ncopy /y "%~dp0local-template.cmd" "%~3\\node_modules\\.bin\\pnpm.cmd" >nul\nexit /b 0');
        stub(root, 'local-template', 'echo 12.0.0\nexit /b 0');
        const result = run(root, ['1', 'y', '']);
        expect(result.code).toBe(1);
        expect(result.output).toContain('pnpm could not be installed.');
        expect(result.log).toBe('');
    });

    test('cached local pnpm takes precedence and skips further bootstrap prompts', () => {
        const root = workspace();
        prerequisites(root, '10.9.0');
        const localBin = join(root, 'data/launcher-tools/node_modules/.bin');
        mkdirSync(localBin, { recursive: true });
        stub(root, 'local-template', 'if "%~1"=="--version" (\n echo 11.0.0\n exit /b 0\n)\necho cached %*>>"%LAUNCHER_TEST_LOG%"\nexit /b 0');
        copyFileSync(join(root, 'tools with spaces/local-template.cmd'), join(localBin, 'pnpm.cmd'));
        const result = run(root, ['1', '', '']);
        expect(result.code).toBe(0);
        expect(result.output).not.toContain('Download pnpm');
        expect(result.log).toBe('cached install --frozen-lockfile\r\ncached start --open\r\n');
    });

    test('new env accepts only a client ID and retains an empty secret', () => {
        const root = workspace();
        prerequisites(root);
        const result = run(root, ['1', 'bad input!', 'syntheticpublicclientid12345', '']);
        expect(result.code).toBe(0);
        expect(result.output).toContain('Use an alphanumeric client ID');
        const saved = readFileSync(join(root, '.env'), 'utf8');
        expect(saved).toContain('TWITCH_CLIENT_ID=syntheticpublicclientid12345');
        expect(saved).toMatch(/^TWITCH_CLIENT_SECRET=\r?$/m);
        expect(saved.charCodeAt(0)).not.toBe(0xfeff);
    });

    test('failed locked install never starts the server and pauses in the selected language', () => {
        const root = workspace();
        prerequisites(root);
        const result = run(root, ['2', '', ''], { LAUNCHER_TEST_INSTALL_EXIT: '1' });
        expect(result.code).toBe(1);
        expect(result.log).not.toContain('start');
        expect(result.output).toContain('De app-afhankelijkheden konden niet');
        expect(result.output).toContain('Druk op Enter');
    });

    test('server errors retain a readable English failure and pause', () => {
        const root = workspace();
        prerequisites(root);
        const result = run(root, ['1', '', ''], { LAUNCHER_TEST_SERVER_EXIT: '1' });
        expect(result.code).toBe(1);
        expect(result.output).toContain('The app stopped with an error.');
        expect(result.output).toContain('Press Enter to close this window');
    });
});
