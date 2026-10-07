import type { Database, Tokens } from './types.js';

export interface ReviewStorage {
    database: Database;
    save(): Promise<void>;
}

export interface TokenStorage {
    readTokens(): Promise<Tokens | null>;
    writeTokens(tokens: Tokens | null): Promise<void>;
}
