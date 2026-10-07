import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Storage } from '../src/storage.js';

describe('durable local records', () => {
    it('encrypts credentials and restores interrupted operations without scheduling a retry', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'crossban-storage-test-'));
        try {
            const first = new Storage(directory);
            await first.initialize();
            await first.writeTokens({ accessToken: 'secret-access-test', refreshToken: 'secret-refresh-test', expiresAt: 123,
                user: { id: 'actor', login: 'actor' } });
            expect((await readFile(join(directory, 'tokens.enc'))).toString()).not.toContain('secret-access-test');
            first.database.history.push({ id: 'history', reportId: 'report', login: 'test_user', userId: '1', channelId: '2',
                channelLogin: 'example', action: 'ban', status: 'started', message: '', at: 'now' });
            await first.save();
            const second = new Storage(directory);
            await second.initialize();
            expect((await second.readTokens())?.accessToken).toBe('secret-access-test');
            expect(second.database.history[0]?.status).toBe('uncertain');
            expect(second.database.history[0]?.message).toContain('not retried');
            await second.writeTokens(null);
            expect(await second.readTokens()).toBeNull();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
