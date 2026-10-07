import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function sha256Hex(value: string | Uint8Array): string {
    return bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value));
}

export function randomUUID(): string {
    return globalThis.crypto.randomUUID();
}

export function randomHex(length: number): string {
    return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(length)));
}

export function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}
