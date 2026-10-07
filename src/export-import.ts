import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { parseDiscordExport } from './discord-export.js';
import { importExportBatches } from './export-engine.js';
import { ReviewError, type Review } from './review.js';
import type { ImportSummary } from './types.js';

const imageLimit = 8 * 1024 * 1024;
function within(root: string, path: string): boolean {
    const part = relative(root, path);
    return part !== '..' && !part.startsWith(`..\\`) && !part.startsWith('../') && !isAbsolute(part);
}

export async function loadExportAsset(url: string, exportDirectory: string, request = fetch): Promise<Buffer> {
    if (!/^https?:/i.test(url)) {
        if (/^[a-z]+:/i.test(url) || isAbsolute(url)) throw new Error('Asset path must be relative to the export.');
        const root = await realpath(exportDirectory);
        const path = await realpath(resolve(root, decodeURIComponent(url)));
        if (!within(root, path)) throw new Error('Asset path leaves the export folder.');
        if ((await stat(path)).size > imageLimit) throw new Error('Screenshot exceeds 8 MB.');
        return readFile(path);
    }
    const address = new URL(url);
    if (address.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(address.hostname) ||
        address.username || address.password || address.port || !/^\/attachments\/\d+\/\d+\//.test(address.pathname)) {
        throw new Error('Only exported Discord CDN attachment URLs are downloaded.');
    }
    const response = await request(address, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Screenshot download returned HTTP ${response.status}. Export again with Download assets enabled.`);
    if (Number(response.headers.get('content-length')) > imageLimit) throw new Error('Screenshot exceeds 8 MB.');
    if (!response.body) throw new Error('Screenshot response was empty.');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > imageLimit) throw new Error('Screenshot exceeds 8 MB.');
            chunks.push(Buffer.from(value));
        }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
}

export async function importExportFolder(review: Review & { storage: { directory: string } }, directory: string, request = fetch): Promise<ImportSummary> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => { throw new ReviewError('Create the export folder beside Start.cmd and put DiscordChatExporter JSON files and assets there.'); });
    const files = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length || files.length > 100) throw new ReviewError('Put between 1 and 100 DiscordChatExporter JSON files in the export folder.');
    const batches = [];
    let total = 0;
    for (const file of files) {
        const path = resolve(directory, file.name);
        total += (await stat(path)).size;
        if (total > 32 * 1024 * 1024) throw new ReviewError('Export JSON files exceed 32 MB. Import a smaller date range.');
        let parsed: unknown;
        try { parsed = JSON.parse(await readFile(path, 'utf8')); }
        catch { throw new ReviewError(`Cannot read JSON in ${file.name}. Export again as JSON.`); }
        const stamp = (parsed as { exportedAt?: unknown }).exportedAt;
        const exportedAt = typeof stamp === 'string' ? Date.parse(stamp) : 0;
        if (!Number.isFinite(exportedAt)) throw new ReviewError('Export has an invalid exportedAt timestamp.');
        batches.push({ batch: parseDiscordExport(parsed), directory: dirname(path), exportedAt });
    }
    return importExportBatches(review, batches, {
        exists: path => stat(resolve(review.storage.directory, path.slice(1))).then(() => true, () => false),
        load: (url, folder) => loadExportAsset(url, folder, request),
        write: async (path, bytes) => { await writeFile(resolve(review.storage.directory, path.slice(1)), bytes, { mode: 0o600 }); },
    });
}
