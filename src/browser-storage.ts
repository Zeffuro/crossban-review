import type { Database, Tokens } from './types.js';
import type { ReviewStorage, TokenStorage } from './storage-port.js';

export const evidencePath = /^\/evidence\/[a-f0-9]{32}\.(png|jpg|webp)$/;
export const maxWorkspaceEvidenceBytes = 128 * 1024 * 1024;
export const maxWorkspaceDatabaseBytes = 32 * 1024 * 1024;
const storageFailure = 'Browser storage could not save this operation. Reload and review history before continuing; free storage space if needed.';
class WorkspaceLimitError extends Error {}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error(storageFailure));
        transaction.onerror = () => {};
    });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export class BrowserStorage implements ReviewStorage, TokenStorage {
    database: Database = { reports: [], history: [] };
    private committed: Database = structuredClone(this.database);
    private connection?: IDBDatabase;
    private tokens: Tokens | null = null;
    private blocked = false;
    private staging: { assets: Map<string, Blob>; replace: boolean } | null = null;
    private urls = new Map<string, string>();

    constructor(readonly name = 'crossban-review', private readonly factory: IDBFactory = indexedDB) {}

    get failed(): boolean { return this.blocked; }
    get failureMessage(): string { return storageFailure; }

    async initialize(recover = true): Promise<void> {
        const request = this.factory.open(this.name, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('workspace');
            request.result.createObjectStore('evidence');
        };
        this.connection = await result(request);
        const transaction = this.connection.transaction('workspace', 'readonly');
        const done = transactionDone(transaction);
        const database = await result(transaction.objectStore('workspace').get('database')) as Database | undefined;
        await done;
        if (database) this.database = database;
        if (!Array.isArray(this.database.reports) || !Array.isArray(this.database.history)) throw new Error('Invalid browser workspace. Restore a backup.');
        this.committed = structuredClone(this.database);
        if (recover) {
            for (const report of this.database.reports) report.warnings = [...new Set(report.warnings)];
            for (const entry of this.database.history) if (entry.status === 'started') {
                entry.status = 'uncertain';
                entry.message = 'Interrupted operation. Check Twitch before doing anything else; it was not retried.';
            }
            await this.save();
        }
    }

    assertWritable(): void {
        if (this.blocked) throw new Error(storageFailure);
        if (!this.connection) throw new Error('Browser workspace is not ready.');
    }

    async save(): Promise<void> { await this.saveWithAssets(new Map()); }

    async saveWithAssets(assets: Map<string, Blob>, replaceAssets = false): Promise<void> {
        this.assertWritable();
        if (this.staging) {
            if (replaceAssets) { this.staging.assets.clear(); this.staging.replace = true; }
            for (const [path, blob] of assets) this.staging.assets.set(path, blob);
            return;
        }
        const snapshot = structuredClone(this.database);
        try {
            if ([...assets.keys()].some(path => !evidencePath.test(path))) throw new WorkspaceLimitError('Invalid evidence path.');
            if (snapshot.reports.length > 10000 || snapshot.history.length > 100000) {
                throw new WorkspaceLimitError('Browser workspace has too many reports or actions. Use a smaller export or keep a separate workspace.');
            }
            if (new TextEncoder().encode(JSON.stringify(snapshot)).length > maxWorkspaceDatabaseBytes) {
                throw new WorkspaceLimitError('Browser workspace exceeds 32 MB of review data. Use a smaller export or keep a separate workspace.');
            }
            const combined = replaceAssets ? new Map<string, Blob>() : await this.listAssets();
            for (const [path, blob] of assets) combined.set(path, blob);
            if (combined.size > 100000) throw new WorkspaceLimitError('Browser workspace has too many screenshots. Use a smaller export or keep a separate workspace.');
            if ([...combined.values()].reduce((total, blob) => total + blob.size, 0) > maxWorkspaceEvidenceBytes) {
                throw new WorkspaceLimitError('Browser workspace exceeds 128 MB of screenshots. Use a smaller export or keep a separate workspace.');
            }
            const transaction = this.connection!.transaction(['workspace', 'evidence'], 'readwrite', { durability: 'strict' });
            const done = transactionDone(transaction);
            transaction.objectStore('workspace').put(snapshot, 'database');
            const evidence = transaction.objectStore('evidence');
            if (replaceAssets) evidence.clear();
            for (const [path, blob] of assets) {
                evidence.put(blob, path);
            }
            await done;
            this.committed = snapshot;
            for (const [path, url] of this.urls) if (replaceAssets || assets.has(path)) {
                URL.revokeObjectURL(url); this.urls.delete(path);
            }
        } catch (error) {
            this.database = structuredClone(this.committed);
            if (error instanceof WorkspaceLimitError) throw error;
            this.blocked = true;
            throw new Error(storageFailure);
        }
    }

    async atomic<T>(operation: () => Promise<T>): Promise<T> {
        this.assertWritable();
        if (this.staging) throw new Error('Another storage import is running.');
        this.staging = { assets: new Map(), replace: false };
        try {
            const value = await operation();
            const staged = this.staging;
            this.staging = null;
            await this.saveWithAssets(staged.assets, staged.replace);
            return value;
        } catch (error) {
            this.staging = null;
            this.database = structuredClone(this.committed);
            throw error;
        }
    }

    async getAsset(path: string): Promise<Blob | undefined> {
        if (!evidencePath.test(path)) throw new Error('Invalid evidence path.');
        if (this.staging?.assets.has(path)) return this.staging.assets.get(path);
        if (this.staging?.replace) return undefined;
        const transaction = this.connection!.transaction('evidence', 'readonly');
        const done = transactionDone(transaction);
        const blob = await result(transaction.objectStore('evidence').get(path)) as Blob | undefined;
        await done;
        return blob;
    }

    async listAssets(): Promise<Map<string, Blob>> {
        const transaction = this.connection!.transaction('evidence', 'readonly');
        const done = transactionDone(transaction);
        const store = transaction.objectStore('evidence');
        const [keys, blobs] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
        await done;
        return new Map(keys.map((key, index) => [String(key), blobs[index] as Blob]));
    }

    async evidenceUrls(): Promise<Record<string, string>> {
        const paths = new Set(this.database.reports.flatMap(report => report.evidence).filter(path => evidencePath.test(path)));
        for (const path of paths) if (!this.urls.has(path)) {
            const blob = await this.getAsset(path);
            if (blob) this.urls.set(path, URL.createObjectURL(blob));
        }
        return Object.fromEntries([...this.urls].filter(([path]) => paths.has(path)));
    }

    async readTokens(): Promise<Tokens | null> { return structuredClone(this.tokens); }
    async writeTokens(tokens: Tokens | null): Promise<void> { this.tokens = structuredClone(tokens); }
    close(): void {
        this.tokens = null;
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear(); this.connection?.close();
    }
}
