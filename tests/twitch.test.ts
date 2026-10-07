import { describe, expect, it, vi } from 'vitest';
import { Twitch } from '../src/twitch.js';
import type { Storage } from '../src/storage.js';
import type { Tokens } from '../src/types.js';

function fixture(handler: (url: string, init?: RequestInit) => Promise<Response>, expiresAt = Date.now() + 3600000) {
    let stored: Tokens | null = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt, user: { id: 'actor', login: 'actor' } };
    const storage = { readTokens: async () => stored, writeTokens: async (tokens: Tokens | null) => { stored = tokens; } } as Storage;
    const request = vi.fn((input: string | URL | Request, init?: RequestInit) => String(input).endsWith('/validate')
        ? Promise.resolve(response({ client_id: 'test-client', user_id: 'actor', login: 'actor', scopes: ['moderator:manage:banned_users', 'user:read:moderated_channels'] }))
        : handler(String(input), init)) as unknown as typeof fetch;
    return { twitch: new Twitch(storage, 'test-client', 'test-secret', request), request };
}
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
describe('Twitch provider contracts', () => {
    it('uses immutable IDs for permanent bans and never replays an uncertain mutation', async () => {
        const { twitch, request } = fixture(async (url, init) => {
            expect(url).toContain('broadcaster_id=target');
            expect(url).toContain('moderator_id=actor');
            expect(JSON.parse(String(init?.body))).toEqual({ data: { user_id: 'offender', reason: 'Reviewed reason' } });
            throw new Error('connection lost after send');
        });
        await twitch.initialize();
        await expect(twitch.changeBan('target', 'offender', 'Reviewed reason')).rejects.toMatchObject({ uncertain: true });
        expect(vi.mocked(request).mock.calls.filter(([url]) => String(url).includes('/helix/'))).toHaveLength(1);
    });
    it('classifies existing bans separately and treats server errors as uncertain', async () => {
        const { twitch } = fixture(async () => response({ message: 'user is already banned' }, 400));
        await twitch.initialize();
        expect(await twitch.changeBan('target', 'offender', 'reason')).toBe('already_banned');
        const failed = fixture(async () => response({}, 503)).twitch;
        await failed.initialize();
        await expect(failed.changeBan('target', 'offender', 'reason')).rejects.toMatchObject({ uncertain: true });
    });
    it('checks permanent bans only with broadcaster authorization; timeouts remain eligible for review', async () => {
        const { twitch, request } = fixture(async () => response({ data: [{ user_id: 'banned', expires_at: '' }, { user_id: 'timed_out', expires_at: 'future' }] }));
        await twitch.initialize();
        expect(await twitch.banned('other-channel', ['banned'])).toBeNull();
        expect(request).not.toHaveBeenCalled();
        expect(await twitch.banned('actor', ['banned', 'timed_out'])).toEqual(new Set(['banned']));
    });
    it('rotates expired tokens once, validates identity and uses required scopes for channel lookup', async () => {
        const { twitch, request } = fixture(async url => {
            if (url.endsWith('/token')) return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
            if (url.endsWith('/validate')) return response({ client_id: 'test-client', user_id: 'actor', login: 'actor',
                scopes: ['moderator:manage:banned_users', 'user:read:moderated_channels'] });
            if (url.includes('moderation/channels')) return response({ data: [{ broadcaster_id: 'target', broadcaster_login: 'target_name', broadcaster_name: 'Target' }], pagination: {} });
            throw new Error('unexpected request');
        }, 0);
        await twitch.initialize();
        expect(await twitch.channels()).toContainEqual({ id: 'target', login: 'target_name', displayName: 'Target' });
        expect(vi.mocked(request).mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
        expect(decodeURIComponent(twitch.authorizeUrl('state', 'http://localhost/callback'))).toContain('user:read:moderated_channels');
    });
    it('batches exact user queries at Twitch’s 100-account boundary', async () => {
        const { twitch, request } = fixture(async url => {
            expect(new URL(url).searchParams.getAll('login').length).toBeLessThanOrEqual(100);
            return response({ data: [] });
        });
        await twitch.initialize();
        await twitch.users(Array.from({ length: 101 }, (_, index) => `user_${index}`));
        expect(vi.mocked(request).mock.calls.filter(([url]) => String(url).includes('/helix/'))).toHaveLength(2);
    });
    it('refuses provider actions when a stored token is revoked', async () => {
        const { twitch, request } = fixture(async () => response({}, 200));
        vi.mocked(request).mockResolvedValueOnce(response({}, 401));
        await twitch.initialize();
        await expect(twitch.changeBan('target', 'offender', 'reason')).rejects.toMatchObject({ status: 401, uncertain: false });
        expect(request).toHaveBeenCalledTimes(1);
    });
});
