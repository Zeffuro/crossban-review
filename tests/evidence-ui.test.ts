import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Result = { text: string; candidates: { login: string; kind: string }[] };
type Progress = { status: string; progress: number };
class Node {
    children: Node[] = [];
    handlers: Record<string, (event?: unknown) => unknown> = {};
    hidden = false;
    disabled = false;
    open = false;
    complete = true;
    naturalWidth = 800;
    naturalHeight = 600;
    clientWidth = 824;
    clientHeight = 624;
    width = 800;
    height = 600;
    scrollLeft = 0;
    scrollTop = 0;
    value = '';
    textContent = '';
    style = {};
    dataset = {};
    classList = { toggle: vi.fn() };
    focus = vi.fn();
    setAttribute = vi.fn();
    setPointerCapture = vi.fn();
    getContext() { return { drawImage: vi.fn() }; }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    addEventListener(name: string, handler: (event?: unknown) => unknown) { this.handlers[name] = handler; }
    append(...children: Node[]) { this.children.push(...children); }
    replaceChildren(...children: Node[]) { this.children = children; }
    showModal() { this.open = true; }
    close() { this.open = false; this.handlers.close?.(); }
    constructor(public tag = 'div') {}
}

async function viewer() {
    const nodes: Record<string, Node> = {};
    const node = (id: string) => nodes[id] ??= new Node();
    const jobs: { finish: (result: Result) => void; progress: (event: Progress) => void }[] = [];
    const cancel = vi.fn();
    const recognize = vi.fn((_canvas: Node, progress: (event: Progress) => void) => new Promise<Result>(finish => { jobs.push({ finish, progress }); }));
    const request = vi.fn();
    const notice = vi.fn();
    const context = createContext({ $: node, window: { CrossbanOcr: { recognize, cancel } },
        document: { createElement: (tag: string) => new Node(tag), addEventListener: vi.fn() },
        state: { environment: 'local', reports: [{ id: 'one', evidence: ['/first.png', '/second.png'] }, { id: 'two', evidence: ['/other.png'] }] },
        activeId: 'one', pending: false, request, notice, updateControls: vi.fn(), applyState: vi.fn(),
        t: (key: string, values: Record<string, unknown> = {}) => key.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name])),
        translateError: (text: string) => text, countLabel: vi.fn(),
        element: (tag: string, _className: string, content: string) => Object.assign(new Node(tag), { textContent: content ?? '' }),
        mutationButton: (text: string, action: () => unknown) => { const button = new Node('button'); button.textContent = text; button.handlers.click = action; return button; },
    });
    runInContext(await readFile(new URL('../public/evidence-ui.js', import.meta.url), 'utf8'), context);
    runInContext("openEvidenceViewer('one', '/first.png')", context);
    cancel.mockClear();
    const read = () => runInContext('readImageText()', context) as Promise<void>;
    const click = (id: string) => node(id).handlers.click?.();
    const draftButton = () => node('ocrCandidates').children[0]!.children.find(child => child.textContent === 'Use as draft')!;
    const result = (login = 'Candidate_Name'): Result => ({ text: `12:15 ${login}: hi`, candidates: [{ login, kind: 'sender' }] });
    return { context, node, jobs, cancel, recognize, request, notice, read, click, draftButton, result };
}

describe('evidence viewer OCR boundaries', () => {
    it('uses object progress and displays numeric recognition percentages', async () => {
        const h = await viewer();
        const reading = h.read();
        h.jobs[0]!.progress({ status: 'loading language traineddata', progress: 0.5 });
        expect(h.node('ocrStatus').textContent).toBe('Loading OCR…');
        h.jobs[0]!.progress({ status: 'recognizing text', progress: 0.375 });
        expect(h.node('ocrStatus').textContent).toBe('Reading text… 38%');
        expect(h.node('ocrStatus').textContent).not.toContain('NaN');
        h.jobs[0]!.finish(h.result()); await reading;
    });
    it.each(['selectOcrArea', 'clearOcrArea'])('cancels and clears results on %s, ignoring late completion', async control => {
        const h = await viewer();
        const reading = h.read();
        h.node('ocrText').value = 'Old recognized text';
        h.node('ocrCandidates').append(new Node('button'));
        h.node('ocrResult').hidden = false;
        h.click(control);
        expect(h.cancel).toHaveBeenCalledOnce();
        expect(h.node('ocrResult').hidden).toBe(true);
        expect(h.node('ocrText').value).toBe('');
        expect(h.node('ocrCandidates').children).toHaveLength(0);
        h.jobs[0]!.progress({ status: 'recognizing text', progress: 0.9 });
        h.jobs[0]!.finish(h.result('Stale_Name')); await reading;
        expect(h.node('ocrText').value).toBe('');
        expect(h.node('ocrCandidates').children).toHaveLength(0);
        expect(h.node('ocrStatus').textContent).toBe('');
    });
    it('invalidates OCR again when another crop gesture starts in selection mode', async () => {
        const h = await viewer();
        h.click('selectOcrArea'); h.cancel.mockClear();
        const reading = h.read();
        const event = { button: 0, pointerId: 1, clientX: 20, clientY: 30, preventDefault: vi.fn() };
        h.node('imageViewport').handlers.pointerdown!(event);
        h.node('imageViewport').handlers.pointermove!({ ...event, clientX: 120, clientY: 150 });
        h.node('imageViewport').handlers.pointerup!(event);
        expect(h.cancel).toHaveBeenCalledOnce();
        expect(h.node('ocrCrop').hidden).toBe(false);
        h.jobs[0]!.finish(h.result('Old_Crop')); await reading;
        expect(h.node('ocrResult').hidden).toBe(true);
        expect(h.node('ocrCandidates').children).toHaveLength(0);
    });
    it.each(["openEvidenceViewer('one', '/second.png')", 'closeEvidenceViewer()'])('ignores late OCR after %s', async action => {
        const h = await viewer();
        const reading = h.read();
        runInContext(action, h.context);
        h.jobs[0]!.finish(h.result('Old_Image')); await reading;
        expect(h.cancel).toHaveBeenCalled();
        expect(h.node('ocrCandidates').children).toHaveLength(0);
        expect(h.node('ocrText').value).toBe('');
        expect(h.node('ocrResult').hidden).toBe(true);
    });
    it('fills only the current report draft without issuing a save, lookup or moderation request', async () => {
        const h = await viewer();
        const reading = h.read(); h.jobs[0]!.finish(h.result()); await reading;
        h.draftButton().handlers.click!();
        expect(h.node('reportLogin').value).toBe('Candidate_Name');
        expect(h.node('reportLogin').focus).toHaveBeenCalledOnce();
        expect(h.node('evidenceDialog').open).toBe(false);
        expect(h.request).not.toHaveBeenCalled();
        expect(h.notice).toHaveBeenCalledWith(expect.stringContaining('draft'));
    });
    it.each(["activeId = 'two'", 'clearImageArea()', "openEvidenceViewer('one', '/second.png')"])
    ('rejects an old candidate action after %s', async action => {
        const h = await viewer();
        const reading = h.read(); h.jobs[0]!.finish(h.result()); await reading;
        const staleButton = h.draftButton();
        h.node('reportLogin').value = 'Unchanged';
        runInContext(action, h.context);
        staleButton.handlers.click!();
        expect(h.node('reportLogin').value).toBe('Unchanged');
        expect(h.request).not.toHaveBeenCalled();
        expect(h.notice).not.toHaveBeenCalled();
    });
});
