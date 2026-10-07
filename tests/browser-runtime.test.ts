import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { BrowserStorage } from '../src/browser-storage.js';
import { createBrowserRuntime, type BrowserRuntime } from '../src/browser-runtime.js';
import { Review } from '../src/review.js';
import type { Twitch } from '../src/twitch.js';
import type { Database, HistoryEntry, TwitchUser } from '../src/types.js';
import { exportBrowserBackup, importBrowserBackup } from '../src/browser-backup.js';

const runtimes: BrowserRuntime[] = [];
const stores: BrowserStorage[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); for (const storage of stores.splice(0)) storage.close(); vi.restoreAllMocks(); });

function storage(factory = new IDBFactory(), name = 'test') {
    const value = new BrowserStorage(name, factory); stores.push(value); return value;
}

function locks() {
    let held = false;
    return { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
        if (held) return callback(null);
        held = true;
        try { await callback({}); } finally { held = false; }
    } } as unknown as Pick<LockManager, 'request'>;
}

function provider() {
    const identity = (login: string): TwitchUser => ({ id: login, login, displayName: login, profileImageUrl: '', createdAt: '' });
    return { user: { id: 'actor', login: 'actor' }, initialize: vi.fn(async () => {}),
        users: vi.fn(async (names: string[]) => names.map(identity)), channels: vi.fn(async () => [{ id: 'channel', login: 'example', displayName: 'Example' }]),
        banned: vi.fn(async () => null), changeBan: vi.fn(async () => 'success'), disconnect: vi.fn(async () => {}) };
}

async function approved(review: Review) {
    await review.import('some_user'); await review.resolve();
    const id = review.storage.database.reports[0]!.id;
    await review.update(id, { decision: 'approved' });
    return review.prepare([id], 'channel', true);
}

describe('browser durable workspace', () => {
    it('waits for committed intent before the provider mutation and records the durable result', async () => {
        const factory = new IDBFactory();
        const store = storage(factory); await store.initialize();
        const twitch = provider(); const review = new Review(store, twitch as unknown as Twitch, async () => {});
        const plan = await approved(review);
        twitch.changeBan.mockImplementation(async () => {
            const observer = storage(factory); await observer.initialize(false);
            expect(observer.database.history[0]?.status).toBe('started');
            return 'success';
        });
        await review.execute(plan.planId, 'example');
        const observer = storage(factory); await observer.initialize(false);
        expect(observer.database.history[0]?.status).toBe('success');
        expect(twitch.changeBan).toHaveBeenCalledTimes(1);
    });

    it('rolls back and sends no mutation when IndexedDB rejects saving intent', async () => {
        const store = storage(); await store.initialize();
        const twitch = provider(); const review = new Review(store, twitch as unknown as Twitch);
        const plan = await approved(review);
        const original = IDBDatabase.prototype.transaction;
        const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
            const value = original.apply(this, args);
            if (args[1] === 'readwrite') queueMicrotask(() => value.abort());
            return value;
        });
        await expect(review.execute(plan.planId, 'example')).rejects.toThrow('Browser storage');
        transaction.mockRestore();
        expect(twitch.changeBan).not.toHaveBeenCalled();
        expect(store.database.history).toHaveLength(0);
        await expect(store.save()).rejects.toThrow('Browser storage');
    });

    it('restores committed started entries as uncertain after an outcome save fails', async () => {
        const factory = new IDBFactory(); const store = storage(factory); await store.initialize();
        const twitch = provider(); const review = new Review(store, twitch as unknown as Twitch);
        const plan = await approved(review);
        twitch.changeBan.mockImplementation(async () => {
            vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
            return 'success';
        });
        await expect(review.execute(plan.planId, 'example')).rejects.toThrow('Browser storage');
        expect(store.database.history[0]?.status).toBe('started');
        vi.restoreAllMocks();
        const recovered = storage(factory); await recovered.initialize();
        expect(recovered.database.history[0]?.status).toBe('uncertain');
        const next = new Review(recovered, twitch as unknown as Twitch);
        await expect(next.prepare([recovered.database.reports[0]!.id], 'channel', true)).rejects.toThrow('uncertain');
        expect(twitch.changeBan).toHaveBeenCalledTimes(1);
    });

    it('keeps database and evidence atomic and memory-only tokens out of backup/reload', async () => {
        const factory = new IDBFactory(); const store = storage(factory); await store.initialize();
        const twitch = provider(); const review = new Review(store, twitch as unknown as Twitch);
        await approved(review);
        const path = `/evidence/${'a'.repeat(32)}.png`;
        const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
        await store.atomic(async () => {
            store.database.reports[0]!.evidence.push(path); await store.save();
            await store.saveWithAssets(new Map([[path, blob]]));
        });
        await store.writeTokens({ accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: 100, user: { id: 'actor', login: 'actor' } });
        const backup = await exportBrowserBackup(store);
        expect(JSON.stringify(backup)).not.toContain('secret');
        const reload = storage(factory); await reload.initialize(false);
        expect(await reload.readTokens()).toBeNull();
        expect((await reload.getAsset(path))?.size).toBe(8);
        await importBrowserBackup(reload, backup);
        expect(reload.database.reports[0]).toMatchObject({ decision: 'pending', resolved: null, lookup: 'unresolved' });
    });

    it('rolls back evidence and report updates together on an aborted import transaction', async () => {
        const factory = new IDBFactory(); const store = storage(factory); await store.initialize();
        const review = new Review(store, provider() as unknown as Twitch); await review.import('some_user');
        const path = `/evidence/${'c'.repeat(32)}.png`;
        const original = IDBDatabase.prototype.transaction;
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
            const value = original.apply(this, args);
            if (args[1] === 'readwrite') queueMicrotask(() => value.abort());
            return value;
        });
        await expect(store.atomic(async () => {
            store.database.reports[0]!.evidence.push(path); await store.save();
            await store.saveWithAssets(new Map([[path, new Blob(['pending asset'])]]));
        })).rejects.toThrow('Browser storage');
        vi.restoreAllMocks();
        const observer = storage(factory); await observer.initialize(false);
        expect(observer.database.reports[0]?.evidence).toEqual([]);
        expect(await observer.getAsset(path)).toBeUndefined();
        expect(store.database.reports[0]?.evidence).toEqual([]);
    });

    it('enforces the combined screenshot cap before commit and allows recovery from a controlled limit rejection', async () => {
        const factory = new IDBFactory(); const store = storage(factory); await store.initialize();
        const review = new Review(store, provider() as unknown as Twitch); await review.import('some_user');
        const oldPath = `/evidence/${'d'.repeat(32)}.png`; const newPath = `/evidence/${'e'.repeat(32)}.png`;
        const existing = vi.spyOn(store, 'listAssets').mockResolvedValue(new Map([[oldPath, { size: 128 * 1024 * 1024 } as Blob]]));
        await expect(store.atomic(async () => {
            store.database.reports[0]!.evidence.push(newPath);
            await store.saveWithAssets(new Map([[newPath, new Blob(['one byte over capacity'])]]));
        })).rejects.toThrow('exceeds 128 MB of screenshots');
        expect(store.failed).toBe(false);
        expect(store.database.reports[0]?.evidence).toEqual([]);
        const observer = storage(factory); await observer.initialize(false);
        expect(observer.database.reports[0]?.evidence).toEqual([]);
        expect(await observer.getAsset(newPath)).toBeUndefined();
        await store.saveWithAssets(new Map([[oldPath, new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })]]));
        existing.mockRestore();
        await store.save();
        expect((await store.getAsset(oldPath))?.size).toBe(8);
    });

    it('rejects backup authorization fields, malformed paths, missing assets and restores interrupted history', async () => {
        const store = storage(); await store.initialize();
        const base = { version: 1, database: { reports: [], history: [] }, assets: [] };
        await expect(importBrowserBackup(store, { ...base, tokens: {} })).rejects.toThrow('Invalid workspace backup');
        await expect(importBrowserBackup(store, { ...base, assets: [{ path: '../escape.png', mime: 'image/png', data: '' }] })).rejects.toThrow('Invalid workspace backup');
        const entry: HistoryEntry = { id: 'h1', reportId: 'r1', login: 'some_user', userId: '1', channelId: '2', channelLogin: 'example', action: 'ban', status: 'started', message: '', at: new Date().toISOString() };
        await importBrowserBackup(store, { ...base, database: { reports: [], history: [entry] } });
        expect(store.database.history[0]?.status).toBe('uncertain');
        const review = new Review(store, provider() as unknown as Twitch); await review.import('some_user');
        const database: Database = structuredClone(store.database);
        database.reports[0]!.evidence.push(`/evidence/${'b'.repeat(32)}.png`);
        await expect(importBrowserBackup(store, { ...base, database })).rejects.toThrow('Invalid workspace backup');
        expect(store.database.reports[0]?.evidence).toHaveLength(0);
    });

    it('preserves trusted local history when restoring an empty or conflicting backup', async () => {
        const store = storage(); await store.initialize();
        const entry: HistoryEntry = { id: 'local-action', reportId: 'r1', login: 'some_user', userId: '1', channelId: '2', channelLogin: 'example',
            action: 'ban', status: 'uncertain', message: 'Check the live outcome.', at: new Date().toISOString() };
        store.database.history.push(entry); await store.save();
        const empty = { version: 1, database: { reports: [], history: [] }, assets: [] };
        await importBrowserBackup(store, empty);
        expect(store.database.history).toEqual([entry]);
        await importBrowserBackup(store, { ...empty, database: { reports: [], history: [{ ...entry, status: 'failed', message: 'Forged resolution.' }] } });
        expect(store.database.history).toEqual([entry]);
    });

    it('requires manually checked reconciliation before a restored success can authorize unban', async () => {
        const store = storage(); await store.initialize();
        const entry: HistoryEntry = { id: 'restored-action', reportId: 'r1', login: 'some_user', userId: '1', channelId: 'channel', channelLogin: 'example',
            action: 'ban', status: 'success', message: 'Forged successful ban.', at: new Date().toISOString() };
        await importBrowserBackup(store, { version: 1, database: { reports: [], history: [entry] }, assets: [] });
        expect(store.database.history[0]).toMatchObject({ status: 'uncertain', message: 'Restored action requires checking Twitch before proceeding.' });
        const twitch = provider(); const review = new Review(store, twitch as unknown as Twitch);
        await expect(review.unban(entry.id, 'example')).rejects.toThrow('Only a successful ban');
        expect(twitch.channels).not.toHaveBeenCalled(); expect(twitch.changeBan).not.toHaveBeenCalled();
        await expect(review.reconcile(entry.id, 'success', false)).rejects.toThrow('explicitly confirm');
        await review.reconcile(entry.id, 'success', true);
        await review.unban(entry.id, 'example');
        expect(twitch.changeBan).toHaveBeenCalledOnce();
        expect(store.database.history[1]?.action).toBe('unban');
    });
});

describe('browser workspace locking', () => {
    it('does not open or recover IndexedDB while lock acquisition is pending', async () => {
        let enter!: (lock: object) => Promise<void>;
        const manager = { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
            enter = callback;
        } } as unknown as Pick<LockManager, 'request'>;
        const store = storage(); const initialize = vi.spyOn(store, 'initialize'); const twitch = provider();
        const runtime = createBrowserRuntime({ storage: store, locks: manager, twitch: twitch as unknown as Twitch }); runtimes.push(runtime);
        expect(initialize).not.toHaveBeenCalled(); expect(twitch.initialize).not.toHaveBeenCalled();
        const held = enter({}); await runtime.ready;
        expect(initialize).toHaveBeenCalledOnce(); expect(twitch.initialize).toHaveBeenCalledOnce();
        runtime.dispose(); await held;
    });

    it('acquires the lock before recovery/token load and fails all nonstate routes closed in a second tab', async () => {
        const factory = new IDBFactory(); const manager = locks();
        const firstStore = storage(factory); const secondStore = storage(factory);
        const firstTwitch = provider(); const secondTwitch = provider();
        const firstInitialize = vi.spyOn(firstStore, 'initialize');
        const secondInitialize = vi.spyOn(secondStore, 'initialize');
        const first = createBrowserRuntime({ storage: firstStore, locks: manager, twitch: firstTwitch as unknown as Twitch }); runtimes.push(first);
        await first.ready;
        const second = createBrowserRuntime({ storage: secondStore, locks: manager, twitch: secondTwitch as unknown as Twitch }); runtimes.push(second);
        await second.ready;
        expect(firstInitialize).toHaveBeenCalledWith();
        expect(secondInitialize).toHaveBeenCalledWith(false);
        expect(secondTwitch.initialize).not.toHaveBeenCalled();
        expect(await second.request('/api/state')).toMatchObject({ readOnly: true, busy: true, auth: { id: 'actor', login: 'actor' } });
        for (const [path, method] of [['/api/channels', 'GET'], ['/api/backup', 'GET'], ['/api/auth/start', 'POST'], ['/api/import', 'POST']]) {
            await expect(second.request(path!, {}, method)).rejects.toThrow('Another tab');
        }
        expect(secondTwitch.channels).not.toHaveBeenCalled();
    });

    it('fails closed with an actionable state when Web Locks are unavailable', async () => {
        const store = storage(); const initialize = vi.spyOn(store, 'initialize');
        const twitch = provider(); const runtime = createBrowserRuntime({ storage: store, locks: null, twitch: twitch as unknown as Twitch }); runtimes.push(runtime);
        expect(await runtime.request('/api/state')).toMatchObject({ readOnly: true, error: expect.stringContaining('Web Locks') });
        await expect(runtime.request('/api/import', { text: 'some_user' }, 'POST')).rejects.toThrow('Web Locks');
        expect(initialize).not.toHaveBeenCalled();
        expect(twitch.initialize).not.toHaveBeenCalled();
    });
});
