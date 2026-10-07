import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const publicFile = (name: string) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('English and Dutch interface catalog', () => {
    it('updates the URL when changing language so refreshing retains the new choice', async () => {
        let onReady!: () => void;
        let onChange!: (event: { target: { value: string } }) => void;
        let saved = 'nl';
        let href = 'http://localhost:4387/?lang=nl&keep=yes#reports';
        const context = createContext({
            document: { documentElement: {}, querySelectorAll: () => [], dispatchEvent: () => {},
                addEventListener: (_name: string, callback: () => void) => { onReady = callback; },
                getElementById: () => ({ addEventListener: (_name: string, callback: typeof onChange) => { onChange = callback; } }) },
            location: { search: '?lang=nl', href }, URL, URLSearchParams, Event,
            history: { state: null, replaceState: (_state: unknown, _title: string, url: URL) => { href = String(url); } },
            localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } },
        });
        runInContext(await publicFile('i18n.js'), context);
        onReady(); onChange({ target: { value: 'en' } });
        expect(saved).toBe('en');
        expect(href).toBe('http://localhost:4387/?lang=en&keep=yes#reports');
        expect(runInContext('uiLocale()', context)).toBe('en-GB');
    });
    it('applies the launcher language before rendering and remembers it', async () => {
        let saved = 'en';
        const context = createContext({
            document: { addEventListener: () => {} }, location: { search: '?lang=nl' }, URLSearchParams,
            localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } },
        });
        runInContext(await publicFile('i18n.js'), context);
        expect(runInContext('uiLocale()', context)).toBe('nl-NL');
        expect(saved).toBe('nl');
    });
    it('covers literal UI keys including public login and keeps interpolated user values unchanged', async () => {
        const context = createContext({ document: { addEventListener: () => {} }, localStorage: { getItem: () => 'nl' } });
        runInContext(await publicFile('i18n.js'), context);
        const known = new Set(runInContext('Object.keys(dutchMessages)', context) as string[]);
        const html = await publicFile('index.html');
        const keys = [...html.matchAll(/data-i18n(?:-html|-placeholder|-aria-label|-title)?="([^"]+)"/g)].map(match => decode(match[1]!));
        for (const name of ['app.js', 'device-login.js']) {
            const source = await publicFile(name);
            keys.push(...[...source.matchAll(/\bt\('((?:\\.|[^'\\])*)'/g)].map(match => match[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\')));
        }
        expect([...new Set(keys)].filter(key => !known.has(key))).toEqual([]);
        expect(runInContext('uiLocale()', context)).toBe('nl-NL');
        context.rawLogin = 'user_$&_with__underscores';
        expect(runInContext("t('Connected as {login}', { login: rawLogin })", context)).toBe('Verbonden als user_$&_with__underscores');
        expect(runInContext("translateError('Unknown original provider text')", context)).toBe('Unknown original provider text');
    });
});
