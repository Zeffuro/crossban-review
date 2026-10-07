import { imageType } from './evidence.js';
import { sha256Hex } from './platform.js';
import type { ExportBatch, ExportAttachment } from './discord-export.js';
import type { Review } from './review.js';
import type { ImportSummary, Report } from './types.js';

export interface ImportBatch { batch: ExportBatch; directory: string; exportedAt: number }
export interface ImportMedia {
    exists(path: string): Promise<boolean>;
    load(url: string, directory: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array, extension: string): Promise<void>;
}

export async function importExportBatches(review: Review, batches: ImportBatch[], media: ImportMedia): Promise<ImportSummary> {
    batches.sort((a, b) => a.exportedAt - b.exportedAt);
    const summary: ImportSummary = { files: batches.length, messages: 0, reports: 0, attachments: 0, loaded: 0, failed: 0, unassigned: 0, ignoredMessages: 0, issues: [] };
    const database = review.storage.database;
    const assets = { ...database.exportAssets };
    const latestSources = new Map<string, Report[]>();
    let byteBudget = 128 * 1024 * 1024;
    let attachmentCount = 0;
    const deadline = Date.now() + 90000;
    const fetchAsset = async (attachment: ExportAttachment, exportDirectory: string): Promise<string> => {
        const cached = assets[attachment.id];
        if (cached && /^\/evidence\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(cached) && await media.exists(cached)) return cached;
        if (++attachmentCount > 1000 || byteBudget <= 0 || Date.now() >= deadline) throw new Error('Import media budget reached. Import a smaller date range.');
        const bytes = await media.load(attachment.url, exportDirectory);
        byteBudget -= bytes.length;
        if (byteBudget < 0) throw new Error('Import screenshots exceed 128 MB. Import a smaller date range.');
        const extension = imageType(bytes);
        if (!extension) throw new Error('Attachment is not a supported PNG, JPEG or WebP screenshot.');
        const filename = `${sha256Hex(bytes).slice(0, 32)}.${extension}`;
        await media.write(`/evidence/${filename}`, bytes, extension);
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
