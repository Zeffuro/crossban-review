import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Candidate = { login: string; kind: 'sender' | 'mention' | 'other' };
type Ocr = {
    recognize: (input: Canvas, progress?: (event: unknown) => void) => Promise<{ text: string; candidates: Candidate[] }>;
    extractCandidates: (text: string) => Candidate[];
    cancel: () => void;
};
class Canvas {
    width = 800;
    height = 600;
    getContext() { return { drawImage: vi.fn() }; }
}
class NativeWorker {
    static instances: NativeWorker[] = [];
    terminate = vi.fn();
    addEventListener = vi.fn();
    constructor() { NativeWorker.instances.push(this); }
}
afterEach(() => { vi.useRealTimers(); NativeWorker.instances = []; });

async function helper() {
    const scripts: Record<string, unknown>[] = [];
    const worker = { recognize: vi.fn(async () => ({ data: { text: '12:15 user_name: Hello @Other_User.' } })), terminate: vi.fn(async () => {}) };
    const createWorker = vi.fn(() => {
        new window.Worker();
        return Promise.resolve(worker);
    });
    const window = { Worker: NativeWorker, Tesseract: { createWorker }, CrossbanOcr: null as unknown as Ocr };
    const revoke = vi.fn();
    const context = createContext({ window, HTMLCanvasElement: Canvas, setTimeout, clearTimeout,
        URL: { revokeObjectURL: revoke },
        document: { createElement: (tag: string) => tag === 'canvas' ? new Canvas() : { remove: vi.fn() },
            head: { append: (script: Record<string, unknown>) => scripts.push(script) } },
    });
    runInContext(await readFile(new URL('../public/ocr.js', import.meta.url), 'utf8'), context);
    const load = () => (scripts.at(-1)!.onload as () => void)();
    return { api: window.CrossbanOcr, scripts, load, worker, createWorker, window, revoke };
}

describe('conservative OCR candidate hints', () => {
    it('preserves spelling and underscores, and distinguishes sender, mention and labelled names', async () => {
        const { api } = await helper();
        expect(api.extractCandidates('[12:15:02] Sender_Name: hi (@Mention_2), @Sender_Name!\nLogin: Draft_User')).toEqual([
            { login: 'Sender_Name', kind: 'sender' }, { login: 'Mention_2', kind: 'mention' },
            { login: 'Sender_Name', kind: 'mention' }, { login: 'Draft_User', kind: 'other' },
        ]);
    });
    it('rejects prose, emails, system labels, Unicode confusables and partial oversized tokens', async () => {
        const { api } = await helper();
        expect(api.extractCandidates(`Ordinary prose about someone\nAutoMod: Twitch\n12:15 AutoMod: ok\n12:15 usеr: hi\n@usеr @abcé @${'x'.repeat(26)} foo@user.com\nUsername: Twitch\n12:15 name-with-hyphen: hi\n99:99 username: hi`)).toEqual([]);
    });
    it('deduplicates each role without collapsing a sender into a mention', async () => {
        const { api } = await helper();
        expect(api.extractCandidates('12:15 User_1: @User_1 @user_1\n12:16 user_1: hi')).toEqual([
            { login: 'User_1', kind: 'sender' }, { login: 'User_1', kind: 'mention' },
        ]);
    });
    it.each(['Example_Name_1', '\n  Example_Name_1 \n', 'Example_Name_1:', '| Example_Name_1:'])
    ('offers an exact cropped username as an unclassified hint: %s', async text => {
        const { api } = await helper();
        expect(api.extractCandidates(text)).toEqual([{ login: 'Example_Name_1', kind: 'other' }]);
    });
    it.each(['example sender _1', 'example sender _1:', 'example_name\nanother_word', 'Example_Namе_1',
        '| Example_Namе_1:', 'Example_Name_1: Test message', 'Some normal prose.', 'a'.repeat(26), `${'a'.repeat(26)}:`, 'user-name'])
    ('does not reconstruct cropped multiword, prose, Unicode or oversized text: %s', async text => {
        const { api } = await helper();
        expect(api.extractCandidates(text)).toEqual([]);
    });
});

describe('optional browser OCR lifecycle', () => {
    it('loads only on request with integrity and fixed remote paths, then cleans up', async () => {
        const h = await helper();
        expect(h.scripts).toHaveLength(0);
        const result = h.api.recognize(new Canvas());
        expect(h.scripts).toHaveLength(1);
        expect(h.scripts[0]).toMatchObject({ src: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
            integrity: 'sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM', crossOrigin: 'anonymous' });
        h.load();
        expect((await result).candidates).toHaveLength(2);
        expect(h.createWorker).toHaveBeenCalledWith('eng', 1, expect.objectContaining({
            workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
            corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
            langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int', cacheMethod: 'none',
        }));
        expect(h.window.Worker).toBe(NativeWorker);
        expect(h.worker.terminate).toHaveBeenCalledOnce();
        expect(NativeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    });
    it('rejects oversized inputs before fetching anything', async () => {
        const h = await helper();
        const canvas = new Canvas(); canvas.width = 4000; canvas.height = 2000;
        await expect(h.api.recognize(canvas)).rejects.toMatchObject({ code: 'OCR_TOO_LARGE' });
        expect(h.scripts).toHaveLength(0);
    });
    it('cancels a lazy load without starting a worker and permits retry', async () => {
        const h = await helper();
        const result = h.api.recognize(new Canvas());
        h.api.cancel();
        await expect(result).rejects.toMatchObject({ code: 'OCR_CANCELLED' });
        h.load();
        await Promise.resolve();
        expect(h.createWorker).not.toHaveBeenCalled();
        await expect(h.api.recognize(new Canvas())).resolves.toHaveProperty('text');
    });
    it('terminates the native worker when initialization never settles, then permits retry', async () => {
        const h = await helper();
        h.createWorker.mockImplementationOnce(() => { new h.window.Worker(); return new Promise(() => {}); });
        const result = h.api.recognize(new Canvas()); h.load();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        h.api.cancel();
        await expect(result).rejects.toMatchObject({ code: 'OCR_CANCELLED' });
        expect(NativeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
        expect(h.window.Worker).toBe(NativeWorker);
        await expect(h.api.recognize(new Canvas())).resolves.toHaveProperty('text');
    });
    it('handles upstream startup error callbacks even when initialization promise hangs', async () => {
        const h = await helper();
        h.createWorker.mockImplementationOnce((_lang?: unknown, _oem?: unknown, options?: unknown) => {
            new h.window.Worker();
            (options as { errorHandler: () => void }).errorHandler();
            return new Promise(() => {});
        });
        const result = h.api.recognize(new Canvas()); h.load();
        await expect(result).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
        expect(NativeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
        expect(h.window.Worker).toBe(NativeWorker);
        await expect(h.api.recognize(new Canvas())).resolves.toHaveProperty('text');
    });
    it('drops results arriving after cancellation of recognition', async () => {
        const h = await helper();
        let finish!: (result: { data: { text: string } }) => void;
        h.worker.recognize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const result = h.api.recognize(new Canvas()); h.load();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        h.api.cancel();
        await expect(result).rejects.toMatchObject({ code: 'OCR_CANCELLED' });
        finish({ data: { text: '12:15 stale_user: hi' } });
        expect(h.worker.terminate).toHaveBeenCalledOnce();
    });
    it('reports script network failure and loads a fresh pinned script on retry', async () => {
        const h = await helper();
        const result = h.api.recognize(new Canvas());
        (h.scripts[0]!.onerror as () => void)();
        await expect(result).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
        const retry = h.api.recognize(new Canvas()); h.load();
        await expect(retry).resolves.toHaveProperty('text');
        expect(h.scripts).toHaveLength(2);
    });
    it('bounds hung startup and does not start overlapping jobs', async () => {
        vi.useFakeTimers();
        const h = await helper();
        h.createWorker.mockImplementationOnce(() => { new h.window.Worker(); return new Promise(() => {}); });
        const result = h.api.recognize(new Canvas());
        const rejection = expect(result).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
        await expect(h.api.recognize(new Canvas())).rejects.toMatchObject({ code: 'OCR_BUSY' });
        h.load();
        await vi.advanceTimersByTimeAsync(90_000);
        await rejection;
        expect(NativeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
        await expect(h.api.recognize(new Canvas())).resolves.toHaveProperty('text');
    });
});
