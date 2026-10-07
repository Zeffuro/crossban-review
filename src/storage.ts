import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database, Tokens } from './types.js';

export class Storage {
    readonly directory: string;
    database: Database = { reports: [], history: [] };
    private key!: Buffer;
    private queue: Promise<void> = Promise.resolve();

    constructor(directory = resolve('data')) { this.directory = directory; }

    async initialize(): Promise<void> {
        await mkdir(resolve(this.directory, 'evidence'), { recursive: true });
        try { this.key = await readFile(resolve(this.directory, 'token.key')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.key = randomBytes(32);
            await writeFile(resolve(this.directory, 'token.key'), this.key, { mode: 0o600, flag: 'wx' });
        }
        try { this.database = JSON.parse(await readFile(resolve(this.directory, 'reviews.json'), 'utf8')) as Database; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!Array.isArray(this.database.reports) || !Array.isArray(this.database.history)) throw new Error('Invalid review database; restore a backup.');
        for (const report of this.database.reports) report.warnings = [...new Set(report.warnings)];
        for (const entry of this.database.history) if (entry.status === 'started') {
            entry.status = 'uncertain';
            entry.message = 'Interrupted operation. Check Twitch before doing anything else; it was not retried.';
        }
        await this.save();
    }

    async save(): Promise<void> {
        const snapshot = JSON.stringify(this.database, null, 2);
        const next = this.queue.then(async () => {
            const path = resolve(this.directory, 'reviews.json');
            await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 });
            await rename(`${path}.tmp`, path);
        });
        this.queue = next.catch(() => {});
        await next;
    }

    async readTokens(): Promise<Tokens | null> {
        try {
            const bytes = await readFile(resolve(this.directory, 'tokens.enc'));
            const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
            decipher.setAuthTag(bytes.subarray(12, 28));
            return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as Tokens;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error('Cannot decrypt Twitch connection. Restore token.key or disconnect and reconnect.');
        }
    }

    async writeTokens(tokens: Tokens | null): Promise<void> {
        const path = resolve(this.directory, 'tokens.enc');
        if (!tokens) { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
        await writeFile(`${path}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
    }
}
