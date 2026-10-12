import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { BrowserStorage } from '../src/browser-storage.js';
import { exportBrowserBackup, importBrowserBackup } from '../src/browser-backup.js';
import { createBrowserRuntime } from '../src/browser-runtime.js';
import { parseReports } from '../src/parser.js';
import { Review } from '../src/review.js';
import type { Twitch } from '../src/twitch.js';
import type { Database, Report, TwitchUser } from '../src/types.js';

const paths = ['a', 'b', 'c'].map(letter => `/evidence/${letter.repeat(32)}.png`);
const user = (login: string): TwitchUser => ({ id: login, login, displayName: login, profileImageUrl: '', createdAt: '' });
const provider = () => ({ user: null, initialize: vi.fn(async () => {}), users: vi.fn(async (names: string[]) => names.map(user)),
    channels: vi.fn(), banned: vi.fn(), changeBan: vi.fn() });
function imported(raw = 'Username: first_user\nReason: Synthetic report', evidence = paths.slice(0, 2)): Report {
    return { ...parseReports(raw)[0]!, sourceIdentity: '1/2/3/0', sourceUrl: 'https://discord.com/channels/1/2/3',
        sourceMessageIds: ['3'], evidence: [...evidence] };
}
function memory() {
    const storage = { database: { reports: [], history: [] } as Database, save: vi.fn(async () => {}) };
    const twitch = provider();
    return { storage, twitch, review: new Review(storage, twitch as unknown as Twitch) };
}
const stores: BrowserStorage[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
async function browser(factory = new IDBFactory(), name = 'split') {
    const store = new BrowserStorage(name, factory); stores.push(store); await store.initialize(); return store;
}

describe('manual report splits', () => {
    it('moves selected proof, retains source context and history, and revokes parent lookup and approval without a provider call', async () => {
        const { storage, twitch, review } = memory();
        await review.importReports([imported()]);
        const parent = storage.database.reports[0]!;
        parent.decision = 'approved'; parent.lookup = 'exists'; parent.resolved = user(parent.login);
        storage.database.history.push({ id: 'history', reportId: parent.id, login: parent.login, userId: parent.login,
            channelId: 'channel', channelLogin: 'example', action: 'ban', status: 'uncertain', message: 'Check outcome', at: new Date().toISOString() });
        const history = structuredClone(storage.database.history);
        await review.split(parent.id, { evidence: [paths[1]], login: 'Second_User__', reason: 'Different account shown in this screenshot' });
        const child = storage.database.reports[1]!;
        expect(parent).toMatchObject({ evidence: [paths[0]], decision: 'pending', lookup: 'unresolved', resolved: null, splitEvidence: [paths[1]] });
        expect(child).toMatchObject({ login: 'second_user__', reason: 'Different account shown in this screenshot', evidence: [paths[1]],
            splitFrom: parent.id, splitSourceRevision: parent.sourceRevision, raw: parent.raw, sourceUrl: parent.sourceUrl,
            sourceMessageIds: parent.sourceMessageIds, decision: 'pending', lookup: 'unresolved', resolved: null });
        expect(child.sourceIdentity).toBeUndefined();
        expect(storage.database.history).toEqual(history);
        for (const method of [twitch.users, twitch.channels, twitch.banned, twitch.changeBan]) expect(method).not.toHaveBeenCalled();
    });

    it('suppresses moved proof on full reimport, preserves reviewed children, and invalidates edited and reverted source revisions only once', async () => {
        const { storage, review } = memory();
        await review.importReports([imported()]);
        const parent = storage.database.reports[0]!;
        await review.split(parent.id, { evidence: [paths[1]], login: 'second_user', reason: 'Manual reason' });
        const child = storage.database.reports[1]!;
        await review.resolve([child.id]); await review.update(child.id, { decision: 'approved' });
        await review.importReports([imported()]);
        expect(storage.database.reports).toHaveLength(2);
        expect(parent.evidence).toEqual([paths[0]]);
        expect(child.decision).toBe('approved');
        for (const raw of ['Username: edited_user\nReason: Revised report', imported().raw]) {
            await review.importReports([imported(raw)]);
            expect(child).toMatchObject({ login: 'second_user', reason: 'Manual reason', evidence: [paths[1]], decision: 'pending',
                lookup: 'unresolved', resolved: null, sourceConflict: true });
            expect(child.warnings.join(' ')).toContain('source of this split report changed');
            await review.resolve([child.id]); await review.update(child.id, { decision: 'approved' });
            expect(child.sourceConflict).toBe(false);
            await review.importReports([imported(raw)]);
            expect(child.decision).toBe('approved');
        }
    });

    it('requires review for added or removed source proof without discarding the manually assigned evidence', async () => {
        const { storage, review } = memory(); await review.importReports([imported()]);
        const parent = storage.database.reports[0]!;
        await review.split(parent.id, { evidence: [paths[1]], login: 'second_user', reason: '' });
        const child = storage.database.reports[1]!;
        for (const evidence of [paths, [paths[0]!]]) {
            child.decision = 'skipped';
            await review.importReports([imported(undefined, evidence)]);
            expect(child.decision).toBe('pending'); expect(child.evidence).toEqual([paths[1]]);
            child.decision = 'skipped';
            await review.importReports([imported(undefined, evidence)]);
            expect(child.decision).toBe('skipped');
        }
    });

    it('blocks split children when their source is withdrawn and allows fresh review when that source returns', async () => {
        const { storage, review } = memory(); await review.importReports([imported()]);
        const parent = storage.database.reports[0]!;
        await review.split(parent.id, { evidence: [paths[1]], login: 'second_user', reason: '' });
        const child = storage.database.reports[1]!;
        await review.importReports([], ['1/2/3']);
        expect(child.sourceWithdrawn).toBe(true);
        await expect(review.resolve([child.id])).rejects.toThrow('no longer lists');
        await review.update(child.id, { decision: 'skipped' });
        await review.importReports([], ['1/2/3']);
        expect(child.decision).toBe('skipped');
        await review.importReports([imported()], ['1/2/3']);
        expect(child.sourceWithdrawn).toBe(false); expect(child.decision).toBe('pending');
        await review.resolve([child.id]); await review.update(child.id, { decision: 'approved' });
    });

    it('supports moving every screenshot and further splits without duplicating canonical source ownership', async () => {
        const { storage, review } = memory(); await review.importReports([imported()]);
        const parent = storage.database.reports[0]!;
        await review.split(parent.id, { evidence: paths.slice(0, 2), login: parent.login, reason: parent.reason });
        const child = storage.database.reports[1]!;
        await review.split(child.id, { evidence: [paths[1]], login: 'third_user', reason: '' });
        await review.importReports([imported()]);
        expect(storage.database.reports).toHaveLength(3);
        expect(storage.database.reports.map(item => item.evidence)).toEqual([[], [paths[0]], [paths[1]]]);
        expect(storage.database.reports.slice(1).every(item => item.splitFrom === parent.id && !item.sourceIdentity)).toBe(true);
    });

    it('rejects stale reports, duplicate or foreign paths, URL evidence, invalid accounts and oversized reasons before mutation', async () => {
        const { storage, review } = memory(); await review.importReports([imported()]);
        const id = storage.database.reports[0]!.id; const before = structuredClone(storage.database);
        await expect(review.split('stale', { evidence: [paths[0]], login: 'user', reason: '' })).rejects.toThrow('not found');
        for (const fields of [{ evidence: [] }, { evidence: [paths[0], paths[0]] }, { evidence: [paths[2]] },
            { evidence: ['../escape.png'] }, { evidence: ['https://example.com/image.png'] }, { login: 'two users' },
            { reason: 'x'.repeat(1001) }, { reason: null }]) {
            await expect(review.split(id, { evidence: [paths[0]], login: 'second_user', reason: '', ...fields })).rejects.toThrow();
            expect(storage.database).toEqual(before);
        }
        await review.split(id, { evidence: [paths[0]], login: 'second_user', reason: '' });
        const after = structuredClone(storage.database);
        await expect(review.split(id, { evidence: [paths[0]], login: 'third_user', reason: '' })).rejects.toThrow('currently attached');
        expect(storage.database).toEqual(after);
    });

    it('restores in-memory evidence, decisions and metadata when a native save fails', async () => {
        const { storage, review } = memory(); await review.importReports([imported()]);
        const before = structuredClone(storage.database);
        storage.save.mockRejectedValueOnce(new Error('Disk full'));
        await expect(review.split(storage.database.reports[0]!.id, { evidence: [paths[1]], login: 'second_user', reason: '' })).rejects.toThrow('Disk full');
        expect(storage.database).toEqual(before);
    });

    it('rolls back browser split state on transaction failure and preserves committed evidence after reload', async () => {
        const factory = new IDBFactory(); const store = await browser(factory); const review = new Review(store, provider() as unknown as Twitch);
        await review.importReports([imported()]); const before = structuredClone(store.database);
        const original = IDBDatabase.prototype.transaction;
        const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
            const value = original.apply(this, args); if (args[1] === 'readwrite') queueMicrotask(() => value.abort()); return value;
        });
        await expect(review.split(store.database.reports[0]!.id, { evidence: [paths[1]], login: 'second_user', reason: '' })).rejects.toThrow('Browser storage');
        expect(store.database).toEqual(before); spy.mockRestore();
        const reload = await browser(factory); expect(reload.database).toEqual(before);
    });

    it('retains split linkage and suppression across browser backup restore and rejects orphaned links', async () => {
        const store = await browser(); const review = new Review(store, provider() as unknown as Twitch);
        await review.importReports([imported()]);
        const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
        await store.saveWithAssets(new Map(paths.slice(0, 2).map(path => [path, blob])));
        await review.split(store.database.reports[0]!.id, { evidence: [paths[1]], login: 'second_user', reason: 'Manual reason' });
        const splitId = store.database.reports[1]!.id;
        const runtime = createBrowserRuntime({ storage: store, twitch: provider() as unknown as Twitch, locks: { request: async (_name: string, _options: unknown,
            callback: (lock: object) => Promise<void>) => callback({}) } as unknown as Pick<LockManager, 'request'> });
        try {
            await runtime.request(`/api/reports/${splitId}/evidence`,
                { dataUrl: `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}` }, 'POST');
        } finally { runtime.dispose(); }
        const addedPath = store.database.reports[1]!.evidence[1]!;
        expect(addedPath).toMatch(/^\/evidence\/[a-f0-9]{32}\.png$/);
        const backup = await exportBrowserBackup(store);
        const restored = await browser(new IDBFactory(), 'restored-split');
        await importBrowserBackup(restored, backup);
        const child = restored.database.reports[1]!; child.decision = 'skipped';
        await new Review(restored, provider() as unknown as Twitch).importReports([imported()]);
        expect(restored.database.reports).toHaveLength(2); expect(child.decision).toBe('skipped');
        expect(restored.database.reports[0]!.evidence).toEqual([paths[0]]);
        expect(child).toMatchObject({ splitFrom: restored.database.reports[0]!.id, evidence: [paths[1], addedPath], reason: 'Manual reason' });
        const invalid = structuredClone(backup) as { database: Database }; invalid.database.reports[1]!.splitFrom = 'abcdef';
        await expect(importBrowserBackup(restored, invalid)).rejects.toThrow('Invalid workspace backup');
        const missingProof = structuredClone(backup) as { database: Database };
        missingProof.database.reports[0]!.splitEvidence!.push(paths[2]!);
        await expect(importBrowserBackup(restored, missingProof)).rejects.toThrow('Invalid workspace backup');
        const missingSuppression = structuredClone(backup) as { database: Database };
        missingSuppression.database.reports[0]!.splitEvidence = [];
        await expect(importBrowserBackup(restored, missingSuppression)).rejects.toThrow('Invalid workspace backup');
    });

    it('exposes split through the browser API and returns the normal updated state', async () => {
        const store = await browser(); const twitch = provider();
        await new Review(store, twitch as unknown as Twitch).importReports([imported()]);
        const runtime = createBrowserRuntime({ storage: store, twitch: twitch as unknown as Twitch, locks: { request: async (_name: string, _options: unknown,
            callback: (lock: object) => Promise<void>) => callback({}) } as unknown as Pick<LockManager, 'request'> });
        try {
            const state = await runtime.request(`/api/reports/${store.database.reports[0]!.id}/split`,
                { evidence: [paths[1]], login: 'second_user', reason: '' }, 'POST') as { reports: Report[] };
            expect(state.reports).toHaveLength(2); expect(state.reports[1]?.splitFrom).toBe(state.reports[0]?.id);
            expect(twitch.changeBan).not.toHaveBeenCalled();
        } finally { runtime.dispose(); }
    });
});
