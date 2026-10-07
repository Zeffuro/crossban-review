import { BrowserStorage, evidencePath, maxWorkspaceDatabaseBytes, maxWorkspaceEvidenceBytes } from './browser-storage.js';
import { imageType } from './evidence.js';
import type { Database, HistoryEntry, Report } from './types.js';

const maxImage = 8 * 1024 * 1024;
const maxAssets = maxWorkspaceEvidenceBytes;
const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const invalid = () => new Error('Invalid workspace backup. Use a Crossban Review backup with valid screenshots and no authorization data.');

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !keys.includes(key))) throw invalid();
    return record;
}

function string(value: unknown, max = maxWorkspaceDatabaseBytes): string {
    if (typeof value !== 'string' || value.length > max) throw invalid();
    return value;
}

function list(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw invalid();
    return value;
}

function strings(value: unknown, max: number, length = 1000): string[] {
    return list(value, max).map(item => string(item, length));
}

function choice(value: unknown, options: string[]): string {
    if (typeof value !== 'string' || !options.includes(value)) throw invalid();
    return value;
}

function sourceUrl(value: unknown): string {
    const text = string(value, 500);
    if (text) {
        let url: URL;
        try { url = new URL(text); } catch { throw invalid(); }
        if (url.protocol !== 'https:' || url.username || url.password) throw invalid();
    }
    return text;
}

function report(value: unknown): Report {
    const item = object(value, ['id', 'login', 'originalLogin', 'reason', 'streamer', 'raw', 'warnings', 'evidence', 'sourceUrl', 'decision', 'resolved', 'lookup',
        'sourceIdentity', 'sourceRevision', 'sourceWithdrawn', 'sourceMessageIds']);
    for (const field of ['id', 'login', 'originalLogin', 'reason', 'streamer', 'raw']) string(item[field]);
    if (!/^[a-f0-9-]{1,100}$/.test(string(item.id, 100))) throw invalid();
    strings(item.warnings, 1000);
    const evidence = strings(item.evidence, 20, 2000);
    for (const path of evidence) if (!evidencePath.test(path)) sourceUrl(path);
    sourceUrl(item.sourceUrl);
    choice(item.decision, ['pending', 'approved', 'skipped']);
    choice(item.lookup, ['unresolved', 'exists', 'missing']);
    if (item.resolved !== null) {
        const resolved = object(item.resolved, ['id', 'login', 'displayName', 'profileImageUrl', 'createdAt']);
        for (const field of ['id', 'login', 'displayName', 'profileImageUrl', 'createdAt']) string(resolved[field], 2000);
    }
    for (const field of ['sourceIdentity', 'sourceRevision']) if (item[field] !== undefined) string(item[field], 2000);
    if (item.sourceWithdrawn !== undefined && typeof item.sourceWithdrawn !== 'boolean') throw invalid();
    if (item.sourceMessageIds !== undefined) strings(item.sourceMessageIds, 10000);
    return { ...item, warnings: [...new Set(item.warnings as string[])], evidence,
        decision: 'pending', resolved: null, lookup: 'unresolved' } as unknown as Report;
}

function history(value: unknown): HistoryEntry {
    const item = object(value, ['id', 'reportId', 'login', 'userId', 'channelId', 'channelLogin', 'action', 'status', 'message', 'at']);
    for (const field of ['id', 'reportId', 'login', 'userId', 'channelId', 'channelLogin', 'message', 'at']) string(item[field], 10000);
    choice(item.action, ['ban', 'unban']);
    choice(item.status, ['started', 'success', 'already_banned', 'failed', 'uncertain']);
    if (!Number.isFinite(Date.parse(item.at as string))) throw invalid();
    const needsVerification = ['started', 'success', 'already_banned'].includes(item.status as string);
    return { ...item, ...(needsVerification ? { status: 'uncertain', message: 'Restored action requires checking Twitch before proceeding.' } : {}) } as unknown as HistoryEntry;
}

export function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return btoa(binary);
}

export function decodeBase64(data: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw invalid();
    let binary: string;
    try { binary = atob(data); } catch { throw invalid(); }
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function exportBrowserBackup(storage: BrowserStorage): Promise<unknown> {
    const assets: { path: string; mime: string; data: string }[] = [];
    let total = 0;
    for (const [path, blob] of await storage.listAssets()) {
        if (!evidencePath.test(path) || blob.size > maxImage || (total += blob.size) > maxAssets) throw invalid();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const type = imageType(bytes);
        if (!type || !path.endsWith(`.${type}`)) throw invalid();
        assets.push({ path, mime: mimeTypes[type], data: encodeBase64(bytes) });
    }
    return { version: 1, database: structuredClone(storage.database), assets };
}

export async function importBrowserBackup(storage: BrowserStorage, input: unknown): Promise<void> {
    const backup = object(input, ['version', 'database', 'assets']);
    if (backup.version !== 1) throw invalid();
    const raw = object(backup.database, ['reports', 'history', 'importSummary', 'exportAssets']);
    if (new TextEncoder().encode(JSON.stringify(raw)).length > maxWorkspaceDatabaseBytes) throw invalid();
    const database: Database = { reports: list(raw.reports, 10000).map(report), history: list(raw.history, 100000).map(history) };
    if (new Set(database.reports.map(item => item.id)).size !== database.reports.length || new Set(database.history.map(item => item.id)).size !== database.history.length) throw invalid();
    if (raw.importSummary !== undefined) {
        const summary = object(raw.importSummary, ['files', 'messages', 'reports', 'attachments', 'loaded', 'failed', 'unassigned', 'ignoredMessages', 'issues']);
        for (const field of ['files', 'messages', 'reports', 'attachments', 'loaded', 'failed', 'unassigned', 'ignoredMessages']) {
            if (!Number.isSafeInteger(summary[field]) || (summary[field] as number) < 0) throw invalid();
        }
        for (const value of list(summary.issues, 100000)) {
            const issue = object(value, ['messageId', 'fileName', 'reason']);
            for (const field of ['messageId', 'fileName', 'reason']) string(issue[field], 10000);
        }
        database.importSummary = structuredClone(summary) as unknown as Database['importSummary'];
    }
    if (raw.exportAssets !== undefined) {
        const mappings = raw.exportAssets;
        if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) || Object.keys(mappings).length > 100000) throw invalid();
        database.exportAssets = Object.fromEntries(Object.entries(mappings).map(([key, value]) => {
            if (!key || key.length > 2000 || ['__proto__', 'constructor', 'prototype'].includes(key) || !evidencePath.test(string(value, 100))) throw invalid();
            return [key, value as string];
        }));
    }
    const assets = new Map<string, Blob>();
    let total = 0;
    for (const value of list(backup.assets, 100000)) {
        const asset = object(value, ['path', 'mime', 'data']);
        const path = string(asset.path, 100);
        if (!evidencePath.test(path) || assets.has(path)) throw invalid();
        const bytes = decodeBase64(string(asset.data, Math.ceil(maxImage / 3) * 4));
        const type = imageType(bytes);
        if (!type || asset.mime !== mimeTypes[type] || !path.endsWith(`.${type}`) || bytes.length > maxImage || (total += bytes.length) > maxAssets) throw invalid();
        assets.set(path, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeTypes[type] }));
    }
    for (const path of [...database.reports.flatMap(item => item.evidence), ...Object.values(database.exportAssets ?? {})]) {
        if (evidencePath.test(path) && !assets.has(path)) throw invalid();
    }
    const currentIds = new Set(storage.database.history.map(entry => entry.id));
    database.history = [...database.history.filter(entry => !currentIds.has(entry.id)), ...structuredClone(storage.database.history)];
    await storage.atomic(async () => {
        storage.database = database;
        await storage.saveWithAssets(assets, true);
    });
}
