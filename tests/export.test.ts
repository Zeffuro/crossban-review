import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDiscordExport } from '../src/discord-export.js';
import { importExportFolder, loadExportAsset } from '../src/export-import.js';
import { Review } from '../src/review.js';
import { Storage } from '../src/storage.js';
import type { Twitch } from '../src/twitch.js';

const message = (id: string, content: string, attachments: { id: string; url: string; fileName: string }[] = [], reply?: string) =>
    ({ id, type: reply ? 'Reply' : 'Default', content, attachments, reference: reply ? { messageId: reply } : null });
const exported = (messages: ReturnType<typeof message>[]) => ({ guild: { id: '1' }, channel: { id: '2' }, messages });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);

describe('Discord export association and evidence import', () => {
    it('imports English report fields with exact usernames and evidence association', () => {
        const batch = parseDiscordExport(exported([
            message('10', 'Channel: example_channel\nUsername: reported_user__\nReason: Harassment\nEvidence: attached screenshot', [{ id: '5', url: 'image.png', fileName: 'image.png' }]),
        ]));
        expect(batch.groups).toHaveLength(1);
        expect(batch.groups[0]!.reports[0]).toMatchObject({ login: 'reported_user__', streamer: 'example_channel', reason: 'Harassment' });
        expect(batch.groups[0]!.attachments).toHaveLength(1);
    });
    it('keeps names with underscores, linked replies and shared evidence with their source reports', () => {
        const batch = parseDiscordExport(exported([
            message('10', 'Streamer: example\nNaam: `one___` & two_user\nReden: racisme', [{ id: '5', url: 'image.png', fileName: 'image.png' }]),
            message('11', 'Streamer: example\nNaam: third_user\nReden: haat'),
            message('12', 'First report was corrected', [], '10'),
            message('13', 'thanks', [{ id: '6', url: 'second.png', fileName: 'second.png' }], '10'),
        ]));
        expect(batch.groups).toHaveLength(2);
        expect(batch.groups[0]!.reports.map(report => report.login)).toEqual(['one___', 'two_user']);
        expect(batch.groups[0]!.reports[0]!.sourceMessageIds).toEqual(['10', '12', '13']);
        expect(batch.groups[0]!.attachments).toHaveLength(2);
        expect(batch.groups[0]!.reports[0]!.raw).toContain('First report was corrected');
        expect(batch.groups[1]!.reports[0]!.raw).not.toContain('corrected');
        expect(batch.groups[0]!.reports[0]!.warnings.join(' ')).toContain('multiple accounts');
    });
    it('does not interpret a username follow-up as a new identity or import a blank template', () => {
        const batch = parseDiscordExport(exported([
            message('10', '# **Crossbans**\n**Streamer:\nGebruikersnaam:\nReden:**\n\n**Bewijs:**\n[*SCREENSHOT*]'),
            message('11', 'Streamer: example\nReden: haat', [{ id: '5', url: 'image.png', fileName: 'image.png' }]),
            message('12', 'missing_name__'),
        ]));
        expect(batch.groups).toHaveLength(1);
        expect(batch.groups[0]!.reports[0]!.login).toBe('');
        expect(batch.groups[0]!.reports[0]!.raw).toContain('missing_name__');
        expect(batch.ignoredMessages).toBe(1);
    });
    it('parses an unstructured three-line report as streamer/name/reason rather than three names', () => {
        const batch = parseDiscordExport(exported([message('10', 'example\nreported_user\nhaatspraak')]));
        expect(batch.groups[0]!.reports).toHaveLength(1);
        expect(batch.groups[0]!.reports[0]).toMatchObject({ login: 'reported_user', streamer: 'example', reason: 'haatspraak', raw: 'example\nreported_user\nhaatspraak' });
    });
    it('blocks traversal, arbitrary CDN endpoints and redirects before downloading', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-path-'));
        await mkdir(resolve(folder, 'export'));
        await writeFile(resolve(folder, 'outside.png'), png);
        const fetcher = vi.fn<typeof fetch>();
        await expect(loadExportAsset('../outside.png', resolve(folder, 'export'), fetcher)).rejects.toThrow('leaves');
        await expect(loadExportAsset('https://127.0.0.1/private', folder, fetcher)).rejects.toThrow('Only exported');
        await expect(loadExportAsset('https://cdn.discordapp.com/not-an-attachment', folder, fetcher)).rejects.toThrow('Only exported');
        expect(fetcher).not.toHaveBeenCalled();
        fetcher.mockResolvedValue(new Response(png));
        await loadExportAsset('https://cdn.discordapp.com/attachments/1/2/image.png', folder, fetcher);
        expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
    });
    it('rejects an oversized streaming download even without a content-length', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
        await expect(loadExportAsset('https://cdn.discordapp.com/attachments/1/2/image.png', '.', fetcher)).rejects.toThrow('exceeds 8 MB');
    });
    it('merges existing pasted reports, stores exact source links, caches proof and retains an identical review', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-export-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        const text = 'Streamer: example\nNaam: one_user\nReden: racisme';
        await review.import(text);
        let report = storage.database.reports[0]!;
        report.decision = 'approved';
        await writeFile(resolve(folder, 'image.png'), png);
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([message('10', text, [{ id: '5', url: 'image.png', fileName: 'image.png' }])])));
        const first = await importExportFolder(review, folder);
        report = storage.database.reports[0]!;
        expect(first).toMatchObject({ files: 1, messages: 1, reports: 1, attachments: 1, loaded: 1, failed: 0 });
        expect(storage.database.reports).toHaveLength(1);
        expect(report.decision).toBe('pending');
        expect(report.sourceUrl).toBe('https://discord.com/channels/1/2/10');
        expect(await readFile(resolve(storage.directory, report.evidence[0]!.slice(1)))).toEqual(png);
        report.decision = 'skipped';
        await importExportFolder(review, folder);
        report = storage.database.reports[0]!;
        expect(report.decision).toBe('skipped');
        expect(report.evidence).toHaveLength(1);
        expect(storage.database.reports).toHaveLength(1);
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([message('10', text + '\nnew context', [{ id: '5', url: 'image.png', fileName: 'image.png' }])])));
        await importExportFolder(review, folder);
        report = storage.database.reports[0]!;
        expect(report.decision).toBe('pending');
        expect(storage.database.reports).toHaveLength(1);
    });
    it('records every failed or unassigned attachment instead of quietly discarding it', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-failure-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([
            message('9', '', [{ id: '4', url: 'missing.png', fileName: 'orphan.png' }]),
            message('10', 'Streamer: example\nNaam: one_user\nReden: racisme', [{ id: '5', url: 'https://cdn.discordapp.com/attachments/1/2/image.png', fileName: 'proof.png' }]),
        ])));
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
        const summary = await importExportFolder(new Review(storage, {} as Twitch), folder, fetcher);
        expect(summary).toMatchObject({ attachments: 2, failed: 1, unassigned: 1, loaded: 0 });
        expect(summary.issues).toHaveLength(2);
        expect(summary.attachments).toBe(summary.loaded + summary.failed + summary.unassigned);
        expect(storage.database.reports[0]!.warnings.join(' ')).toContain('attachment unavailable');
    });
    it('requires review of edited identities and of a replay of an older source revision', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-edit-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        const path = resolve(folder, 'export.json');
        const original = 'Streamer: example\nNaam: one_user\nReden: racisme';
        await writeFile(path, JSON.stringify(exported([message('10', original)])));
        await importExportFolder(review, folder);
        let report = storage.database.reports[0]!;
        report.decision = 'approved';
        await writeFile(path, JSON.stringify(exported([message('10', original.replace('one_user', 'two_user'))])));
        await importExportFolder(review, folder);
        report = storage.database.reports[0]!;
        expect(report.login).toBe('two_user');
        expect(report.lookup).toBe('unresolved');
        expect(report.decision).toBe('pending');
        report.decision = 'approved';
        await writeFile(path, JSON.stringify(exported([message('10', original)])));
        await importExportFolder(review, folder);
        report = storage.database.reports[0]!;
        expect(report.login).toBe('one_user');
        expect(report.decision).toBe('pending');
        expect(storage.database.reports).toHaveLength(1);
    });
    it('blocks identities removed from an explicitly exported message, including messages now empty', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-withdraw-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        const path = resolve(folder, 'export.json');
        const original = 'Streamer: example\nNaam: one_user & two_user\nReden: racisme';
        await writeFile(path, JSON.stringify(exported([message('10', original)])));
        await importExportFolder(review, folder);
        for (const report of storage.database.reports) report.decision = 'approved';
        await writeFile(path, JSON.stringify(exported([message('10', original.replace(' & two_user', ''))])));
        await importExportFolder(review, folder);
        const removed = storage.database.reports.find(report => report.login === 'two_user')!;
        expect(removed.sourceWithdrawn).toBe(true);
        expect(removed.decision).toBe('pending');
        await expect(review.resolve([removed.id])).rejects.toThrow('no longer lists');
        await writeFile(path, JSON.stringify(exported([message('10', '')])));
        const result = await importExportFolder(review, folder);
        expect(result.reports).toBe(0);
        expect(storage.database.reports.every(report => report.sourceWithdrawn)).toBe(true);
    });
    it('keeps removed candidates blocked when overlapping exports include an older revision', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-overlap-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        const original = 'Streamer: example\nNaam: one_user & two_user\nReden: racisme';
        await writeFile(resolve(folder, 'z-old.json'), JSON.stringify({ ...exported([message('10', original)]), exportedAt: '2026-10-01T00:00:00Z' }));
        await importExportFolder(review, folder);
        storage.database.reports[1]!.decision = 'approved';
        await writeFile(resolve(folder, 'a-new.json'), JSON.stringify({ ...exported([message('10', original.replace(' & two_user', ''))]), exportedAt: '2026-10-02T00:00:00Z' }));
        const summary = await importExportFolder(review, folder);
        expect(summary.reports).toBe(1);
        expect(storage.database.reports[1]!.sourceWithdrawn).toBe(true);
        expect(storage.database.reports[1]!.decision).toBe('pending');
    });
    it('records orphan-only exports and rolls back live database state on a failed save', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-rollback-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([
            { ...message('10', '', [{ id: '4', url: 'missing.png', fileName: 'proof.png' }]), type: 'Other' },
        ])));
        const summary = await importExportFolder(review, folder);
        expect(summary).toMatchObject({ reports: 0, attachments: 1, unassigned: 1 });
        expect(storage.database.importSummary?.unassigned).toBe(1);
        const before = storage.database;
        vi.spyOn(storage, 'save').mockRejectedValue(new Error('Disk full'));
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([message('10', 'Streamer: example\nNaam: new_user\nReden: racisme')])));
        await expect(importExportFolder(review, folder)).rejects.toThrow('Disk full');
        expect(storage.database).toBe(before);
        expect(storage.database.reports).toHaveLength(0);
    });
    it('replaces uncertain paste spelling with exported spelling and requires a fresh lookup', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-spelling-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        await review.import('Streamer: sourcechannel\nNaam: one_user\nReden: haat\n\nModerator — Today 12:00\nCheck the underscore');
        storage.database.reports[0]!.decision = 'approved';
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([message('10', 'Streamer: source_channel\nNaam: one_user_\nReden: haat')])));
        await importExportFolder(review, folder);
        expect(storage.database.reports).toHaveLength(1);
        expect(storage.database.reports[0]).toMatchObject({ login: 'one_user_', decision: 'pending', lookup: 'unresolved' });
        expect(storage.database.reports[0]!.warnings.join(' ')).toContain('Export spelling differs');
    });
    it('includes previously attached proof in the screenshot cap and reports the actual reply containing a failed asset', async () => {
        const folder = await mkdtemp(resolve(tmpdir(), 'crossban-cap-'));
        const storage = new Storage(resolve(folder, 'data'));
        await storage.initialize();
        const review = new Review(storage, {} as Twitch);
        const text = 'Streamer: example\nNaam: one_user\nReden: racisme';
        await review.import(text);
        storage.database.reports[0]!.evidence = Array.from({ length: 20 }, (_, i) => `/evidence/${String(i).padStart(32, '0')}.png`);
        await writeFile(resolve(folder, 'image.png'), png);
        await writeFile(resolve(folder, 'export.json'), JSON.stringify(exported([
            message('10', text), message('11', 'proof', [{ id: '5', url: 'image.png', fileName: 'image.png' }], '10'),
        ])));
        const result = await importExportFolder(review, folder);
        expect(result).toMatchObject({ failed: 1, loaded: 0 });
        expect(result.issues[0]!.messageId).toBe('11');
        expect(storage.database.reports[0]!.evidence).toHaveLength(20);
    });
});
