import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserStorage } from '../src/browser-storage.js';
import { importBrowserExport } from '../src/browser-export.js';
import { exportBrowserBackup, importBrowserBackup } from '../src/browser-backup.js';
import { Review } from '../src/review.js';
import type { Twitch } from '../src/twitch.js';

function selectedFile(name: string, content: BlobPart, path: string) {
    const file = new File([content], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const exported = (name: string, url = 'assets/proof.png') => JSON.stringify({
    guild: { id: '1' }, channel: { id: '2' }, exportedAt: '2026-10-07T01:00:00Z',
    messages: [{ id: '3', type: 'Default', content: `Username: ${name}\nReason: Synthetic example`,
        attachments: [{ id: '4', url, fileName: 'proof.png' }] }],
});

describe('browser folder import and backup boundaries', () => {
    it('imports downloaded evidence atomically, preserves coverage and revokes approval on source correction', async () => {
        const store = new BrowserStorage('folder', new IDBFactory()); await store.initialize();
        try {
            const review = new Review(store, {} as Twitch);
            const files = [selectedFile('channel.json', exported('synthetic_one'), 'export/channel.json'),
                selectedFile('proof.png', png, 'export/assets/proof.png')];
            await importBrowserExport(review, store, files);
            expect(store.database.importSummary).toMatchObject({ files: 1, messages: 1, reports: 1, attachments: 1, loaded: 1, failed: 0 });
            const report = store.database.reports[0]!;
            expect(await store.getAsset(report.evidence[0]!)).toBeInstanceOf(Blob);
            report.decision = 'approved'; await store.save();
            await importBrowserExport(review, store, [selectedFile('channel.json', exported('synthetic_two'), 'export/channel.json'), files[1]!]);
            expect(store.database.reports).toHaveLength(1);
            expect(store.database.reports[0]).toMatchObject({ originalLogin: 'synthetic_two', decision: 'pending', lookup: 'unresolved', resolved: null });
            const backup = await exportBrowserBackup(store);
            await importBrowserBackup(store, backup);
            expect(store.database.reports[0]?.evidence).toHaveLength(1);
        } finally { store.close(); }
    });

    it('records missing evidence and rejects relative path escapes without dropping report coverage', async () => {
        const store = new BrowserStorage('missing', new IDBFactory()); await store.initialize();
        try {
            const review = new Review(store, {} as Twitch);
            await importBrowserExport(review, store, [selectedFile('channel.json', exported('synthetic_one', '../proof.png'), 'export/channel.json')]);
            expect(store.database.importSummary).toMatchObject({ reports: 1, attachments: 1, loaded: 0, failed: 1 });
            expect(store.database.reports[0]?.warnings.join(' ')).toContain('attachment unavailable');
            expect(store.database.reports[0]?.decision).toBe('pending');
        } finally { store.close(); }
    });

    it('rejects a report count that could not be restored and keeps the prior committed workspace', async () => {
        const store = new BrowserStorage('limits', new IDBFactory()); await store.initialize();
        try {
            const review = new Review(store, {} as Twitch);
            await review.import('synthetic_saved');
            const report = store.database.reports[0]!;
            store.database.reports = Array.from({ length: 10001 }, (_, index) => ({ ...report, id: `${index}`, login: `synthetic_${index}` }));
            await expect(store.save()).rejects.toThrow('too many reports');
            expect(store.database.reports).toHaveLength(1);
            await review.import('synthetic_next');
            await importBrowserBackup(store, await exportBrowserBackup(store));
            expect(store.database.reports).toHaveLength(2);
        } finally { store.close(); }
    });
});
