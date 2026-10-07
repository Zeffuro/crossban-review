import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { parseDiscordExport, type ExportAttachment } from './discord-export.js';
import { imageType } from './evidence.js';
import { Review, ReviewError } from './review.js';
import type { ImportSummary, Report } from './types.js';

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

export async function importExportFolder(review: Review, directory: string, request = fetch): Promise<ImportSummary> {
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
    batches.sort((a, b) => a.exportedAt - b.exportedAt);
    const summary: ImportSummary = { files: files.length, messages: 0, reports: 0, attachments: 0, loaded: 0, failed: 0, unassigned: 0, ignoredMessages: 0, issues: [] };
    const database = review.storage.database;
    const assets = { ...database.exportAssets };
    const latestSources = new Map<string, Report[]>();
    let byteBudget = 128 * 1024 * 1024;
    let attachmentCount = 0;
    const deadline = Date.now() + 90000;
    const fetchAsset = async (attachment: ExportAttachment, exportDirectory: string): Promise<string> => {
        const cached = assets[attachment.id];
        if (cached && /^\/evidence\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(cached)) {
            if (await stat(resolve(review.storage.directory, cached.slice(1))).then(() => true, () => false)) return cached;
        }
        if (++attachmentCount > 1000 || byteBudget <= 0 || Date.now() >= deadline) throw new Error('Import media budget reached. Import a smaller date range.');
        const bytes = await loadExportAsset(attachment.url, exportDirectory, request);
        byteBudget -= bytes.length;
        if (byteBudget < 0) throw new Error('Import screenshots exceed 128 MB. Import a smaller date range.');
        const extension = imageType(bytes);
        if (!extension) throw new Error('Attachment is not a supported PNG, JPEG or WebP screenshot.');
        const filename = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${extension}`;
        await writeFile(resolve(review.storage.directory, 'evidence', filename), bytes, { mode: 0o600 });
        return assets[attachment.id] = `/evidence/${filename}`;
    };
    for (const { batch, directory: exportDirectory } of batches) {
        summary.messages += batch.messages;
        summary.ignoredMessages += batch.ignoredMessages;
        for (const source of batch.sourceMessages) latestSources.set(source, []);
        for (const group of batch.unassigned) for (const attachment of group.attachments) {
            summary.attachments++; summary.unassigned++;
            summary.issues.push({ messageId: group.messageId, fileName: attachment.fileName, reason: 'No report could be associated with this attachment. Review it in the export.' });
        }
        for (const group of batch.groups) {
            const identity = group.reports[0]!.sourceIdentity!;
            latestSources.set(identity.slice(0, identity.lastIndexOf('/')), group.reports);
            for (const attachment of group.attachments) {
                summary.attachments++;
                try {
                    if (group.reports.some(report => report.evidence.length >= 20)) throw new Error('Message has more than 20 screenshots. Review the remaining attachments in Discord.');
                    const url = await fetchAsset(attachment, exportDirectory);
                    if (group.reports.some(report => new Set([...(review.findImportedReport(report)?.evidence ?? []), ...report.evidence, url]).size > 20)) {
                        throw new Error('Report would exceed 20 screenshots, including previously attached proof. Review this attachment in Discord.');
                    }
                    for (const report of group.reports) if (!report.evidence.includes(url)) report.evidence.push(url);
                    summary.loaded++;
                } catch (error) {
                    summary.failed++;
                    const reason = error instanceof Error && !/fetch failed|aborted|timeout|redirect/i.test(error.message)
                        ? error.message : 'Screenshot download failed or expired. Export again with Download assets enabled.';
                    summary.issues.push({ messageId: attachment.messageId ?? group.messageId, fileName: attachment.fileName, reason });
                    for (const report of group.reports) report.warnings.push(`Export attachment unavailable: ${attachment.fileName}. Review it in Discord or export with Download assets enabled.`);
                }
            }
        }
    }
    const reports = [...latestSources.values()].flat();
    summary.reports = reports.length;
    const staged = structuredClone(database);
    staged.exportAssets = assets;
    staged.importSummary = summary;
    review.storage.database = staged;
    try { await review.importReports(reports, [...latestSources.keys()]); }
    catch (error) { review.storage.database = database; throw error; }
    return summary;
}
