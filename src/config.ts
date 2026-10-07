import { bundledClientId } from './client-id.js';
export { bundledClientId } from './client-id.js';

export function twitchConfiguration(environment: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
    const customId = environment.TWITCH_CLIENT_ID?.trim();
    return {
        clientId: customId || bundledClientId,
        clientSecret: customId ? environment.TWITCH_CLIENT_SECRET?.trim() || '' : '',
    };
}
