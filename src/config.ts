export const bundledClientId = 'cwl06q3rm61vjnhj60lplf8w8ogra3';

export function twitchConfiguration(environment: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
    const customId = environment.TWITCH_CLIENT_ID?.trim();
    return {
        clientId: customId || bundledClientId,
        clientSecret: customId ? environment.TWITCH_CLIENT_SECRET?.trim() || '' : '',
    };
}
