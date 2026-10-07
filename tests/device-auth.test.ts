import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceAuth } from '../src/device-auth.js';
import { Twitch } from '../src/twitch.js';
import type { Storage } from '../src/storage.js';
import type { Tokens } from '../src/types.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const details = { device_code: 'private-device-code', user_code: 'ABCDEFGH', expires_in: 1800, interval: 5,
    verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' };
const tokens = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };

describe('public Twitch login', () => {
    afterEach(() => vi.useRealTimers());
    it('keeps the device code private, enforces provider intervals, and consumes authorization once', async () => {
        vi.useFakeTimers();
        const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(details))
            .mockResolvedValueOnce(response({ message: 'authorization_pending' }, 400)).mockResolvedValueOnce(response(tokens));
        const device = new DeviceAuth('public-client', request);
        const login = await device.start();
        expect(login).not.toHaveProperty('deviceCode');
        expect(JSON.stringify(login)).not.toContain('private-device-code');
        expect(await device.poll(login.id)).toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        expect(await device.poll(login.id)).toBeNull();
        expect(await device.poll(login.id)).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(5000);
        expect(await device.poll(login.id)).toMatchObject({ accessToken: 'test-access', refreshToken: 'test-refresh' });
        await expect(device.poll(login.id)).rejects.toThrow('expired or was replaced');
        const params = request.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)));
        expect(params.every(body => !body.has('client_secret'))).toBe(true);
        expect(params[1]!.get('device_code')).toBe('private-device-code');
    });
    it('honors slower provider polling, cancels stale sessions and does not replay failed exchanges', async () => {
        vi.useFakeTimers();
        const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...details, interval: 120 })).mockRejectedValueOnce(new Error('lost response'));
        const device = new DeviceAuth('public-client', request);
        const login = await device.start();
        vi.advanceTimersByTime(60000);
        expect(await device.poll(login.id)).toBeNull();
        vi.advanceTimersByTime(60000);
        await expect(device.poll(login.id)).rejects.toThrow('not retried');
        await expect(device.poll(login.id)).rejects.toThrow('expired or was replaced');
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('rejects untrusted verification links and expired, replaced or cancelled requests', async () => {
        vi.useFakeTimers();
        const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...details, verification_uri: 'https://example.com/login?device-code=ABCDEFGH' }))
            .mockImplementation(async () => response(details));
        const device = new DeviceAuth('public-client', request);
        await expect(device.start()).rejects.toThrow('unexpected login address');
        const first = await device.start();
        const second = await device.start();
        await expect(device.poll(first.id)).rejects.toThrow('replaced');
        device.cancel();
        await expect(device.poll(second.id)).rejects.toThrow('replaced');
        const third = await device.start();
        vi.advanceTimersByTime(1800000);
        await expect(device.poll(third.id)).rejects.toThrow('expired');
    });
    it('backs off slow_down and stops on denied or incomplete authorization', async () => {
        vi.useFakeTimers();
        const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(details))
            .mockResolvedValueOnce(response({ message: 'slow_down' }, 429))
            .mockResolvedValueOnce(response({ message: 'access_denied' }, 400));
        const device = new DeviceAuth('public-client', request);
        const login = await device.start();
        vi.advanceTimersByTime(5000);
        expect(await device.poll(login.id)).toBeNull();
        vi.advanceTimersByTime(5000);
        expect(await device.poll(login.id)).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(5000);
        await expect(device.poll(login.id)).rejects.toThrow('cancelled');
        await expect(device.poll(login.id)).rejects.toThrow('replaced');
    });
    it('validates personal account/client/scopes before persisting tokens and refreshes without a secret', async () => {
        let stored: Tokens | null = null;
        const storage = { readTokens: async () => stored, writeTokens: vi.fn(async (value: Tokens | null) => { stored = value; }) } as unknown as Storage;
        const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
            if (String(url).endsWith('/token')) {
                expect(new URLSearchParams(String(init?.body)).has('client_secret')).toBe(false);
                return response({ ...tokens, refresh_token: 'rotated-refresh' });
            }
            return response({ client_id: 'public-client', user_id: 'moderator', login: 'personal_mod', scopes: ['moderator:manage:banned_users', 'user:read:moderated_channels'] });
        });
        const twitch = new Twitch(storage, 'public-client', '', request);
        expect(twitch.configured).toBe(true);
        expect(twitch.usesDeviceLogin).toBe(true);
        await twitch.connectTokens({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 0 });
        expect(twitch.user).toEqual({ id: 'moderator', login: 'personal_mod' });
        await twitch.validateConnection();
        expect(storage.writeTokens).toHaveBeenLastCalledWith(expect.objectContaining({ refreshToken: 'rotated-refresh' }));
        request.mockResolvedValue(response({ client_id: 'wrong-client', user_id: 'moderator', login: 'personal_mod', scopes: [] }));
        await expect(twitch.connectTokens({ accessToken: 'other', refreshToken: 'other', expiresAt: Date.now() + 100000 })).rejects.toThrow('do not match');
        expect(twitch.user?.login).toBe('personal_mod');
    });
    it.each(['validation failure', 'lost response'])('never replays a public refresh after %s, including restart', async failure => {
        let stored: Tokens | null = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0, user: { id: 'mod', login: 'personal_mod' } };
        const storage = { readTokens: async () => stored, writeTokens: async (value: Tokens | null) => { stored = value; } } as Storage;
        const request = vi.fn<typeof fetch>().mockImplementation(async url => {
            if (String(url).endsWith('/token')) {
                expect(stored).toBeNull();
                if (failure === 'lost response') throw new Error('request response lost');
                return response(tokens);
            }
            return response({}, 503);
        });
        const twitch = new Twitch(storage, 'public-client', '', request);
        await twitch.initialize();
        await expect(twitch.validateConnection()).rejects.toThrow();
        await expect(twitch.validateConnection()).rejects.toThrow('Connect a Twitch account first');
        expect(twitch.user).toBeNull();
        const restarted = new Twitch(storage, 'public-client', '', request);
        await restarted.initialize();
        await expect(restarted.validateConnection()).rejects.toThrow('Connect a Twitch account first');
        expect(request.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
    });
});
