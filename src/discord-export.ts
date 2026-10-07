import { containsReportFields, parseReports, validLogin } from './parser.js';
import { ReviewError } from './review.js';
import type { Report } from './types.js';

export interface ExportAttachment { id: string; url: string; fileName: string; messageId?: string }
export interface ExportGroup { messageId: string; reports: Report[]; attachments: ExportAttachment[] }
export interface ExportBatch { groups: ExportGroup[]; messages: number; ignoredMessages: number; unassigned: ExportGroup[]; sourceMessages: string[] }
interface Message {
    id: string; type: string; content: string; attachments: ExportAttachment[];
    reference?: { messageId?: string } | null;
}
const snowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{1,25}$/.test(value);

export function parseDiscordExport(value: unknown): ExportBatch {
    if (!value || typeof value !== 'object') throw new ReviewError('Invalid DiscordChatExporter JSON.');
    const data = value as { guild?: { id?: unknown }; channel?: { id?: unknown }; messages?: unknown };
    if (!snowflake(data.guild?.id) || !snowflake(data.channel?.id) || !Array.isArray(data.messages) || data.messages.length > 10000) {
        throw new ReviewError('Use a DiscordChatExporter channel JSON with at most 10,000 messages.');
    }
    const messages = data.messages as Message[];
    for (const message of messages) {
        if (!message || !snowflake(message.id) || typeof message.content !== 'string' || message.content.length > 1000000 ||
            typeof message.type !== 'string' || !Array.isArray(message.attachments) || message.attachments.length > 100 ||
            message.attachments.some(item => !item || !snowflake(item.id) || typeof item.url !== 'string' || typeof item.fileName !== 'string')) {
            throw new ReviewError('An exported message has invalid fields. Export the channel again as JSON.');
        }
    }
    const batch: ExportBatch = { groups: [], messages: messages.length, ignoredMessages: 0, unassigned: [],
        sourceMessages: messages.map(message => `${data.guild!.id}/${data.channel!.id}/${message.id}`) };
    const associations = new Map<string, ExportGroup>();
    let previous: ExportGroup | undefined;
    for (const message of messages) {
        const attachments = message.attachments.map(item => ({ ...item, messageId: message.id }));
        if (!['Default', 'Reply'].includes(message.type)) {
            batch.ignoredMessages++;
            if (attachments.length) batch.unassigned.push({ messageId: message.id, reports: [], attachments });
            continue;
        }
        const clean = message.content.replace(/\*\*|`/g, '');
        const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
        const structured = containsReportFields(clean);
        const unstructured = lines.length === 3 && validLogin(lines[1]!);
        const reports = structured ? parseReports(clean) : unstructured
            ? parseReports(`Streamer: ${lines[0]}\nNaam: ${lines[1]}\nReden: ${lines[2]}`) : [];
        if (reports.length) {
            reports.forEach((report, index) => {
                report.raw = message.content;
                report.sourceUrl = `https://discord.com/channels/${data.guild!.id}/${data.channel!.id}/${message.id}`;
                report.sourceIdentity = `${data.guild!.id}/${data.channel!.id}/${message.id}/${index}`;
                report.sourceMessageIds = [message.id];
                if (unstructured && !structured) report.warnings.push('Unstructured report: verify the inferred username, streamer and reason against the original.');
                if (reports.length > 1 && message.attachments.length) report.warnings.push('These screenshots belong to a message naming multiple accounts. Check which screenshot supports each account.');
            });
            const group = { messageId: message.id, reports, attachments };
            batch.groups.push(group);
            associations.set(message.id, group);
            previous = group;
            continue;
        }
        const target = message.reference?.messageId ? associations.get(message.reference.messageId) : previous;
        if (target && (clean.trim() || message.attachments.length)) {
            for (const report of target.reports) {
                report.raw += `\n\nFollow-up message:\n${message.content}`;
                report.sourceMessageIds!.push(message.id);
                report.warnings.push(message.reference?.messageId
                    ? 'An exported reply is included. Check it for corrections or changes in account status.'
                    : 'An adjacent message is included as context. Its relationship to this report is unverified.');
            }
            target.attachments.push(...attachments);
            associations.set(message.id, target);
        } else {
            batch.ignoredMessages++;
            if (attachments.length) batch.unassigned.push({ messageId: message.id, reports: [], attachments });
        }
    }
    return batch;
}
