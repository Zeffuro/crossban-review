import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceAuth } from '../src/device-auth.js';
import { imageType, validImage } from '../src/evidence.js';
import { parseReports, reportKey } from '../src/parser.js';
import { delay, randomHex, sha256Hex } from '../src/platform.js';
import { Review } from '../src/review.js';
import type { ReviewStorage, TokenStorage } from '../src/storage-port.js';
import { Twitch } from '../src/twitch.js';
import type { TwitchUser } from '../src/types.js';

describe('portable moderation core', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it.each(['', 'Report 🧾\nGebruiker: café', '\ud800'])('preserves Node SHA-256 UTF-8 hashes for %j', value => {
        expect(sha256Hex(value)).toBe(createHash('sha256').update(value).digest('hex'));
    });

    it('preserves binary evidence hashes and accepts legacy Buffer inputs', () => {
        const bytes = new Uint8Array([0, 255, 137, 13, 10]);
        expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(validImage(Buffer.from([255, 216, 255]), 'image/jpeg')).toBe(true);
    });

    it('keeps existing report keys and source revision hashes compatible', async () => {
        const report = parseReports('Channel: source\nUsername: Some_User\nReason: harassment 🧾')[0]!;
        const legacyKey = JSON.stringify([report.originalLogin.toLowerCase(), report.reason.trim(), report.streamer.trim(), '']);
        expect(reportKey(report)).toBe(createHash('sha256').update(legacyKey).digest('hex'));
        report.sourceIdentity = 'channel/message/0';
        const storage: ReviewStorage = { database: { reports: [], history: [] }, save: async () => {} };
        const tokens: TokenStorage = { readTokens: async () => null, writeTokens: async () => {} };
        const review = new Review(storage, new Twitch(tokens, '', ''));
        await review.importReports([report]);
        expect(storage.database.reports[0]!.sourceRevision).toBe(createHash('sha256').update(report.raw).digest('hex'));
    });

    it('validates browser byte arrays without Buffer and rejects mismatched or truncated signatures', () => {
        vi.stubGlobal('Buffer', undefined);
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const jpeg = new Uint8Array([255, 216, 255]);
        const webp = new TextEncoder().encode('RIFF1234WEBP');
        expect(validImage(png, 'image/png')).toBe(true);
        expect(validImage(jpeg, 'image/jpeg')).toBe(true);
        expect(validImage(webp, 'image/webp')).toBe(true);
        expect(validImage(png, 'image/jpeg')).toBe(false);
        for (const bytes of [png, jpeg, webp]) expect(imageType(bytes.subarray(0, bytes.length - 1))).toBeNull();
    });

    it('uses browser cryptography for report and device session identities', async () => {
        const browserCrypto = {
            randomUUID: vi.fn(() => 'browser-report-id'),
            getRandomValues: vi.fn((bytes: Uint8Array) => { bytes.fill(171); return bytes; }),
        };
        vi.stubGlobal('crypto', browserCrypto);
        expect(parseReports('some_user')[0]!.id).toBe('browser-report-id');
        expect(randomHex(16)).toBe('ab'.repeat(16));
        const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
            device_code: 'private', user_code: 'ABCD', expires_in: 1800, interval: 5,
            verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD',
        })));
        const login = await new DeviceAuth('public-client', request).start();
        expect(login.id).toBe('ab'.repeat(16));
        expect(login).not.toHaveProperty('deviceCode');
    });

    it('keeps the browser receiver when native fetch is used by provider classes', async () => {
        const nativeFetch = vi.fn(function (this: unknown, input: string | URL | Request) {
            if (this !== globalThis) throw new TypeError('Illegal invocation');
            return Promise.resolve(new Response(JSON.stringify(String(input).endsWith('/device')
                ? { device_code: 'synthetic', user_code: 'ABCD', expires_in: 600, interval: 5, verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD' }
                : { client_id: 'public-client', user_id: 'actor', login: 'moderator', scopes: ['moderator:manage:banned_users', 'user:read:moderated_channels'] })));
        });
        vi.stubGlobal('fetch', nativeFetch);
        const device = new DeviceAuth('public-client');
        expect((await device.start()).userCode).toBe('ABCD'); device.cancel();
        const storage: TokenStorage = { readTokens: async () => null, writeTokens: async () => {} };
        const twitch = new Twitch(storage, 'public-client', '');
        await twitch.connectTokens({ accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: Date.now() + 3600000 });
        expect(twitch.user?.id).toBe('actor');
    });

    it('waits between reviewed browser mutations with a normal timer and records the generic reason', async () => {
        vi.useFakeTimers();
        const waiting = vi.fn();
        void delay(1200).then(waiting);
        await vi.advanceTimersByTimeAsync(1199);
        expect(waiting).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(waiting).toHaveBeenCalledOnce();
        const user: TwitchUser = { id: 'person', login: 'some_user', displayName: 'Some User', profileImageUrl: '', createdAt: '' };
        const report = parseReports('Channel: source\nUsername: some_user\nReason: harassment')[0]!;
        Object.assign(report, { resolved: user, lookup: 'exists', decision: 'approved' });
        const storage: ReviewStorage = { database: { reports: [report], history: [] }, save: async () => {} };
        const changeBan = vi.fn().mockResolvedValue('success');
        const twitch = { user: { id: 'moderator', login: 'mod' }, users: async () => [user],
            channels: async () => [{ id: 'target', login: 'target', displayName: 'Target' }],
            banned: async () => null, changeBan } as unknown as Twitch;
        const review = new Review(storage, twitch);
        const plan = await review.prepare([report.id], 'target', true);
        await review.execute(plan.planId, 'target');
        expect(changeBan).toHaveBeenCalledWith('target', 'person', 'Crossban reviewed: harassment', false);
        expect(storage.database.history[0]!.status).toBe('success');
    });
});
