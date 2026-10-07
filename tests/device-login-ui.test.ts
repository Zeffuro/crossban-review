import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

async function screen() {
    vi.useFakeTimers();
    const handlers: Record<string, (event: unknown) => void> = {};
    const nodes: Record<string, { hidden?: boolean; textContent?: string; href?: string; addEventListener: (name: string, handler: (event: unknown) => void) => void }> = {};
    const request = vi.fn().mockResolvedValue({ pending: true });
    const applyState = vi.fn();
    const notice = vi.fn();
    const popup = { opener: {}, closed: false, location: { href: '' }, close: vi.fn(), focus: vi.fn() };
    const window = { open: vi.fn().mockReturnValue(popup), focus: vi.fn() };
    const context = createContext({
        $: (id: string) => nodes[id] ??= { addEventListener: (_name: string, handler: (event: unknown) => void) => { handlers[id] = handler; } }, request, applyState, notice, window,
        pending: false, loadingChannels: false, state: { busy: false }, URL, Date,
        setTimeout, clearTimeout, t: (key: string) => key, translateError: (key: string) => key,
        uiLocale: () => 'en-GB', document: { addEventListener: () => {} }, perform: vi.fn(),
    });
    runInContext(await readFile(new URL('../public/device-login.js', import.meta.url), 'utf8'), context);
    runInContext(`startDeviceLogin({id:'login',userCode:'ABCDEFGH',url:'https://www.twitch.tv/activate?device-code=ABCDEFGH',
        expiresAt:Date.now()+60000,interval:5})`, context);
    return { context, nodes, request, applyState, notice, popup, window, handlers };
}

describe('device login in the original review tab', () => {
    it('opens an isolated popup and closes it when authorization completes', async () => {
        const ui = await screen();
        const event = { button: 0, preventDefault: vi.fn() };
        ui.handlers.deviceLink!(event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(ui.popup.opener).toBeNull();
        expect(ui.popup.location.href).toBe('https://www.twitch.tv/activate?device-code=ABCDEFGH');
        ui.handlers.deviceLink!(event);
        expect(ui.window.open).toHaveBeenCalledOnce();
        expect(ui.popup.focus).toHaveBeenCalledOnce();
        ui.request.mockResolvedValueOnce({ auth: { id: 'moderator' }, reports: [] });
        await vi.advanceTimersByTimeAsync(5000);
        expect(ui.popup.close).toHaveBeenCalledOnce();
        expect(ui.window.focus).toHaveBeenCalledOnce();
        expect(ui.applyState).toHaveBeenCalledOnce();
    });

    it('retains the normal link when popups are blocked or a modifier requests another tab', async () => {
        const ui = await screen();
        const event = { button: 0, preventDefault: vi.fn() };
        ui.window.open.mockReturnValueOnce(null);
        ui.handlers.deviceLink!(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        ui.handlers.deviceLink!({ ...event, ctrlKey: true });
        expect(ui.window.open).toHaveBeenCalledOnce();
        ui.request.mockResolvedValueOnce({ auth: { id: 'moderator' }, reports: [] });
        await vi.advanceTimersByTimeAsync(5000);
        expect(ui.applyState).toHaveBeenCalledOnce();
        expect(ui.window.focus).not.toHaveBeenCalled();
    });

    it('closes the blank popup and retains the link if opener isolation fails', async () => {
        const ui = await screen();
        Object.defineProperty(ui.popup, 'opener', { set: () => { throw new Error('Cannot clear opener'); } });
        const event = { button: 0, preventDefault: vi.fn() };
        ui.handlers.deviceLink!(event);
        expect(ui.popup.close).toHaveBeenCalledOnce();
        expect(ui.popup.location.href).toBe('');
        expect(event.preventDefault).not.toHaveBeenCalled();
    });
    it('keeps polling while Twitch approval is pending, then connects without a callback or reload', async () => {
        const ui = await screen();
        await vi.advanceTimersByTimeAsync(5000);
        expect(ui.request).toHaveBeenCalledWith('/api/auth/poll', { loginId: 'login' });
        expect(ui.applyState).not.toHaveBeenCalled();
        const connected = { auth: { id: 'moderator', login: 'personal_mod' }, reports: [] };
        ui.request.mockResolvedValueOnce(connected);
        await vi.advanceTimersByTimeAsync(5000);
        expect(ui.applyState).toHaveBeenCalledWith(connected);
        expect(ui.nodes.deviceLogin?.hidden).toBe(true);
        expect(ui.notice).toHaveBeenCalledWith('Twitch connected.');
        await vi.advanceTimersByTimeAsync(15000);
        expect(ui.request).toHaveBeenCalledTimes(2);
    });

    it('ignores a late authorization result after cancelling the login', async () => {
        const ui = await screen();
        let complete!: (value: unknown) => void;
        ui.request.mockImplementation(() => new Promise(accept => { complete = accept; }));
        await vi.advanceTimersByTimeAsync(5000);
        runInContext('stopDeviceLogin()', ui.context);
        complete({ auth: { id: 'moderator' }, reports: [] });
        await Promise.resolve();
        expect(ui.applyState).not.toHaveBeenCalled();
        expect(ui.nodes.deviceLogin?.hidden).toBe(true);
    });
});
