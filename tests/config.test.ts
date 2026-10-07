import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { bundledClientId, twitchConfiguration } from '../src/config.js';

describe('bundled public Twitch application', () => {
    it('works without an env file and excludes an orphaned client secret', () => {
        expect(twitchConfiguration({})).toEqual({ clientId: bundledClientId, clientSecret: '' });
        expect(twitchConfiguration({ TWITCH_CLIENT_ID: '  ', TWITCH_CLIENT_SECRET: 'orphan-secret' }))
            .toEqual({ clientId: bundledClientId, clientSecret: '' });
    });
    it('preserves explicit public and legacy confidential overrides', () => {
        expect(twitchConfiguration({ TWITCH_CLIENT_ID: 'custom-public' })).toEqual({ clientId: 'custom-public', clientSecret: '' });
        expect(twitchConfiguration({ TWITCH_CLIENT_ID: ' custom-private ', TWITCH_CLIENT_SECRET: 'custom-secret' }))
            .toEqual({ clientId: 'custom-private', clientSecret: 'custom-secret' });
    });
    it('ships the matching public ID and an empty secret in the launcher template', async () => {
        const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
        expect(template).toMatch(new RegExp(`^TWITCH_CLIENT_ID=${bundledClientId}\\r?$`, 'm'));
        expect(template).toMatch(/^TWITCH_CLIENT_SECRET=\r?$/m);
    });
});
