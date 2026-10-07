import { parseDiscordExport } from './discord-export.js';
import { importExportBatches, type ImportBatch } from './export-engine.js';
import { ReviewError, type Review } from './review.js';
import type { BrowserStorage } from './browser-storage.js';

const imageLimit = 8 * 1024 * 1024;

function safePath(value: string): string {
    const parts = value.replaceAll('\\', '/').split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || /^[a-z]+:/i.test(value) || value.startsWith('/')) {
        throw new ReviewError('Asset path must be relative to the export.');
    }
    return parts.join('/');
}

async function remoteAsset(url: string): Promise<Uint8Array> {
    const address = new URL(url);
    if (address.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(address.hostname) ||
        address.username || address.password || address.port || !/^\/attachments\/\d+\/\d+\//.test(address.pathname)) {
        throw new ReviewError('Only exported Discord CDN attachment URLs are downloaded.');
    }
    const response = await fetch(address, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw new ReviewError('Screenshot download failed or expired. Export again with Download assets enabled.');
    if (Number(response.headers.get('content-length')) > imageLimit) throw new ReviewError('Screenshot exceeds 8 MB.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > imageLimit) throw new ReviewError('Screenshot exceeds 8 MB.');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}

export async function importBrowserExport(review: Review, storage: BrowserStorage, files: File[]): Promise<void> {
    if (!Array.isArray(files) || !files.length || files.length > 12000 || files.some(file => !(file instanceof File))) {
        throw new ReviewError('Choose the folder containing your DiscordChatExporter JSON files and downloaded assets.');
    }
    const entries = new Map<string, File>();
    for (const file of files) {
        const path = safePath(file.webkitRelativePath || file.name);
        if (entries.has(path)) throw new ReviewError('The selected export contains duplicate file paths.');
        entries.set(path, file);
    }
    const jsonFiles = [...entries].filter(([path]) => path.toLowerCase().endsWith('.json')).sort(([a], [b]) => a.localeCompare(b));
    if (!jsonFiles.length || jsonFiles.length > 100) throw new ReviewError('Put between 1 and 100 DiscordChatExporter JSON files in the export folder.');
    let total = 0;
    const batches: ImportBatch[] = [];
    for (const [path, file] of jsonFiles) {
        total += file.size;
        if (total > 32 * 1024 * 1024) throw new ReviewError('Export JSON files exceed 32 MB. Import a smaller date range.');
        let value: unknown;
        try { value = JSON.parse(await file.text()); }
        catch { throw new ReviewError(`Cannot read JSON in ${file.name}. Export again as JSON.`); }
        const stamp = (value as { exportedAt?: unknown } | null)?.exportedAt;
        const exportedAt = typeof stamp === 'string' ? Date.parse(stamp) : 0;
        if (!Number.isFinite(exportedAt)) throw new ReviewError('Export has an invalid exportedAt timestamp.');
        batches.push({ batch: parseDiscordExport(value), directory: path.slice(0, path.lastIndexOf('/') + 1), exportedAt });
    }
    await storage.atomic(() => importExportBatches(review, batches, {
        exists: async path => Boolean(await storage.getAsset(path)),
        load: async (url, directory) => {
            if (/^https?:/i.test(url)) return remoteAsset(url);
            let path: string;
            try { path = safePath(directory + decodeURIComponent(url)); }
            catch { throw new ReviewError('Asset path must be relative to the export.'); }
            const file = entries.get(path);
            if (!file) throw new ReviewError('Screenshot file was not selected. Export with Download assets enabled and choose the entire folder.');
            if (file.size > imageLimit) throw new ReviewError('Screenshot exceeds 8 MB.');
            return new Uint8Array(await file.arrayBuffer());
        },
        write: async (path, bytes, extension) => {
            const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
            await storage.saveWithAssets(new Map([[path, new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })]]));
        },
    })).then(() => undefined);
}
