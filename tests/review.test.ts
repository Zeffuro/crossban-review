import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Review } from '../src/review.js';
import type { Storage } from '../src/storage.js';
import { ProviderError, type Twitch } from '../src/twitch.js';
import type { Database, TwitchUser } from '../src/types.js';

const identity = (login: string, id = login): TwitchUser => ({ id, login, displayName: login, profileImageUrl: '', createdAt: '' });
describe('reviewed execution invariants', () => {
    let database: Database;
    let save: ReturnType<typeof vi.fn>;
    let provider: { user: { id: string; login: string }; users: ReturnType<typeof vi.fn>; channels: ReturnType<typeof vi.fn>;
        banned: ReturnType<typeof vi.fn>; changeBan: ReturnType<typeof vi.fn> };
    let review: Review;
    beforeEach(() => {
        database = { reports: [], history: [] };
        save = vi.fn().mockResolvedValue(undefined);
        provider = { user: { id: 'actor', login: 'actor' }, users: vi.fn(async (names: string[]) => names.map(name => identity(name))),
            channels: vi.fn().mockResolvedValue([{ id: 'channel', login: 'example', displayName: 'Example' }]),
            banned: vi.fn().mockResolvedValue(null), changeBan: vi.fn().mockResolvedValue('success') };
        review = new Review({ database, save } as unknown as Storage, provider as unknown as Twitch, async () => {});
    });
    async function approved(names = ['one_user', 'two_user']) {
        await review.import(names.map(name => `Streamer: source\nNaam: ${name}\nReden: racisme`).join('\n'));
        await review.resolve();
        for (const report of database.reports) await review.update(report.id, { decision: 'approved' });
        return database.reports.map(report => report.id);
    }
    it('accepts generic HTTPS source links without fetching them and rejects executable or credential URLs', async () => {
        await review.import('some_user');
        const id = database.reports[0]!.id;
        await review.update(id, { sourceUrl: 'https://example.com/moderation/report' });
        expect(database.reports[0]!.sourceUrl).toBe('https://example.com/moderation/report');
        for (const sourceUrl of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com/report']) {
            await expect(review.update(id, { sourceUrl })).rejects.toThrow('HTTPS source link');
        }
        expect(provider.users).not.toHaveBeenCalled();
    });
    it('prepares without sending bans, requires exact channel confirmation, and consumes a plan once', async () => {
        const ids = await approved();
        const plan = await review.prepare(ids, 'channel', true);
        expect(provider.changeBan).not.toHaveBeenCalled();
        await expect(review.execute(plan.planId, 'wrong_channel')).rejects.toThrow('exact target');
        expect(provider.changeBan).not.toHaveBeenCalled();
        const second = await review.prepare(ids, 'channel', true);
        await review.execute(second.planId, 'example');
        await expect(review.execute(second.planId, 'example')).rejects.toThrow('expired');
        expect(provider.changeBan).toHaveBeenCalledTimes(2);
    });
    it('rejects stale identity, changed permission and edits after preview', async () => {
        const ids = await approved();
        const first = await review.prepare(ids, 'channel', true);
        provider.users.mockResolvedValue([identity('one_user', 'different_account'), identity('two_user')]);
        await expect(review.execute(first.planId, 'example')).rejects.toThrow('identity changed');
        provider.users.mockImplementation(async (names: string[]) => names.map(name => identity(name)));
        const second = await review.prepare(ids, 'channel', true);
        provider.channels.mockResolvedValue([]);
        await expect(review.execute(second.planId, 'example')).rejects.toThrow('permission changed');
        provider.channels.mockResolvedValue([{ id: 'channel', login: 'example' }]);
        const third = await review.prepare(ids, 'channel', true);
        await review.update(ids[0]!, { sourceUrl: 'https://discord.com/channels/1/2/3' });
        await expect(review.execute(third.planId, 'example')).rejects.toThrow('expired');
        expect(provider.changeBan).not.toHaveBeenCalled();
    });
    it('persists before mutation and stops on an uncertain result without replay', async () => {
        const ids = await approved();
        const plan = await review.prepare(ids, 'channel', true);
        provider.changeBan.mockImplementation(async () => {
            expect(database.history[0]?.status).toBe('started');
            expect(save).toHaveBeenCalled();
            throw new ProviderError('Lost response', 502, true);
        });
        await review.execute(plan.planId, 'example');
        expect(database.history[0]?.status).toBe('uncertain');
        expect(provider.changeBan).toHaveBeenCalledTimes(1);
        await expect(review.prepare(ids, 'channel', true)).rejects.toThrow('uncertain');
        await review.reconcile(database.history[0]!.id, 'failed', true);
        expect((await review.prepare(ids, 'channel', true)).items).toHaveLength(2);
    });
    it('does not send a provider operation if the intent cannot be saved', async () => {
        const plan = await review.prepare(await approved(), 'channel', true);
        save.mockRejectedValueOnce(new Error('disk full'));
        await expect(review.execute(plan.planId, 'example')).rejects.toThrow('disk full');
        expect(provider.changeBan).not.toHaveBeenCalled();
    });
    it('skips duplicate users and previous successful bans, but allows a later explicitly reviewed reban after unban', async () => {
        const ids = await approved(['one_user']);
        const plan = await review.prepare(ids, 'channel', true);
        await review.execute(plan.planId, 'example');
        await expect(review.prepare(ids, 'channel', true)).rejects.toThrow('Every selected');
        const entry = database.history[0]!;
        await review.unban(entry.id, 'example');
        expect(database.history[1]?.action).toBe('unban');
        await expect(review.unban(entry.id, 'example')).rejects.toThrow('newer action');
        expect((await review.prepare(ids, 'channel', true)).items).toHaveLength(1);
    });
    it('does not let already-existing bans be treated as bans created by the tool', async () => {
        const plan = await review.prepare(await approved(['one_user']), 'channel', true);
        provider.changeBan.mockResolvedValue('already_banned');
        await review.execute(plan.planId, 'example');
        await expect(review.unban(database.history[0]!.id, 'example')).rejects.toThrow('Only a successful ban');
    });
    it('rejects overlapping jobs and declines unreviewed selections', async () => {
        const ids = await approved();
        await expect(review.prepare(ids, 'channel', false)).rejects.toThrow('reviewed');
        await review.exclusive(async () => {
            await expect(review.exclusive(async () => {})).rejects.toThrow('Another operation');
        });
    });
    it('remembers skipped imports without clearing decisions', async () => {
        await review.import('Streamer: source\nNaam: some_user\nReden: racisme');
        await review.update(database.reports[0]!.id, { decision: 'skipped' });
        await review.import('Streamer: source\nNaam: some_user\nReden: racisme');
        expect(database.reports).toHaveLength(1);
        expect(database.reports[0]?.decision).toBe('skipped');
    });
    it('merges a later correction, revokes approval, and keeps that correction when a shorter paste is imported again', async () => {
        await approved(['some_user']);
        const base = 'Streamer: source\nNaam: some_user\nReden: racisme';
        await review.import(`${base}\nReporter — Today 13:37\nCorrection: do not ban some_user; offender is different_user`);
        expect(database.reports).toHaveLength(1);
        expect(database.reports[0]?.decision).toBe('pending');
        expect(database.reports[0]?.lookup).toBe('unresolved');
        expect(database.reports[0]?.raw).toContain('do not ban');
        await review.import(base);
        expect(database.reports[0]?.raw).toContain('do not ban');
    });
    it('rejects invalid compound edits before changing the approved identity', async () => {
        const ids = await approved(['one_user']);
        await expect(review.update(ids[0]!, { login: 'another_user', decision: 'approved' })).rejects.toThrow('Resolve');
        expect(database.reports[0]?.login).toBe('one_user');
        expect(database.reports[0]?.decision).toBe('approved');
    });
});
