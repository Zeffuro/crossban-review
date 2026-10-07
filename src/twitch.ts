import type { Storage } from './storage.js';
import type { Tokens, TwitchUser } from './types.js';

export class ProviderError extends Error {
    constructor(message: string, readonly status = 502, readonly uncertain = false) { super(message); }
}

export interface Channel { id: string; login: string; displayName: string }
const scopes = ['moderator:manage:banned_users', 'user:read:moderated_channels'];

export class Twitch {
    private tokens: Tokens | null = null;
    private refreshPromise: Promise<Tokens> | null = null;
    private validatedAt = 0;
    constructor(private readonly storage: Storage, readonly clientId: string, private readonly clientSecret: string,
        private readonly request: typeof fetch = fetch) {}

    get configured(): boolean { return Boolean(this.clientId); }
    get usesDeviceLogin(): boolean { return !this.clientSecret; }
    get user(): Tokens['user'] | null { return this.tokens?.user ?? null; }
    async initialize(): Promise<void> { this.tokens = await this.storage.readTokens(); }

    authorizeUrl(state: string, redirect: string): string {
        if (!this.clientId || !this.clientSecret) throw new ProviderError('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env, then restart.', 400);
        return `https://id.twitch.tv/oauth2/authorize?${new URLSearchParams({ client_id: this.clientId,
            redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), state, force_verify: 'true' })}`;
    }

    private async tokenRequest(parameters: Record<string, string>): Promise<Omit<Tokens, 'user'>> {
        const response = await this.request('https://id.twitch.tv/oauth2/token', {
            method: 'POST', body: new URLSearchParams({ client_id: this.clientId,
                ...(this.clientSecret ? { client_secret: this.clientSecret } : {}), ...parameters }),
            signal: AbortSignal.timeout(15000),
        }).catch(() => { throw new ProviderError('Twitch authorization is unavailable. Try reconnecting.'); });
        if (!response.ok) throw new ProviderError('Twitch authorization failed. Check application settings or reconnect.', 401);
        const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token ||
            typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new ProviderError('Twitch returned incomplete authorization.');
        return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 };
    }

    private async validate(accessToken: string): Promise<Tokens['user']> {
        const response = await this.request('https://id.twitch.tv/oauth2/validate', {
            headers: { Authorization: `OAuth ${accessToken}` }, signal: AbortSignal.timeout(15000),
        }).catch(() => { throw new ProviderError('Twitch token validation is unavailable.'); });
        if (!response.ok) throw new ProviderError('Twitch connection expired or was revoked. Reconnect.', 401);
        const data = await response.json() as { client_id: string; user_id: string; login: string; scopes: string[] };
        if (data.client_id !== this.clientId || typeof data.user_id !== 'string' || !data.user_id || typeof data.login !== 'string' || !data.login || !Array.isArray(data.scopes)
            || scopes.some(scope => !data.scopes.includes(scope))) throw new ProviderError('Twitch identity or required permissions do not match. Reconnect.', 401);
        this.validatedAt = Date.now();
        return { id: data.user_id, login: data.login };
    }

    async connect(code: string, redirect: string): Promise<void> {
        const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect });
        await this.connectTokens(tokens);
    }

    async connectTokens(tokens: Omit<Tokens, 'user'>): Promise<void> {
        const user = await this.validate(tokens.accessToken);
        await this.storage.writeTokens({ ...tokens, user });
        this.tokens = { ...tokens, user };
    }

    async disconnect(): Promise<void> {
        await this.storage.writeTokens(null);
        this.tokens = null;
    }

    private async access(): Promise<Tokens> {
        if (this.refreshPromise) return this.refreshPromise;
        if (!this.tokens) throw new ProviderError('Connect a Twitch account first.', 401);
        if (this.tokens.expiresAt > Date.now() + 60000) {
            if (Date.now() - this.validatedAt >= 3600000) {
                const user = await this.validate(this.tokens.accessToken);
                if (user.id !== this.tokens.user.id) throw new ProviderError('Twitch identity changed. Reconnect.', 401);
            }
            return this.tokens;
        }
        if (!this.refreshPromise) {
            const previous = this.tokens;
            this.refreshPromise = (async () => {
                if (this.usesDeviceLogin) {
                    // Public refresh tokens are single-use, including an exchange whose response is lost.
                    await this.storage.writeTokens(null);
                    this.tokens = null;
                }
                const refreshed = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refreshToken });
                const user = await this.validate(refreshed.accessToken);
                if (user.id !== previous.user.id) throw new ProviderError('Twitch identity changed. Reconnect.', 401);
                const tokens = { ...refreshed, user };
                await this.storage.writeTokens(tokens);
                this.tokens = tokens;
                return tokens;
            })().finally(() => { this.refreshPromise = null; });
        }
        return this.refreshPromise;
    }

    async validateConnection(): Promise<void> {
        const tokens = await this.access();
        const user = await this.validate(tokens.accessToken);
        if (user.id !== tokens.user.id) throw new ProviderError('Twitch identity changed. Reconnect.', 401);
    }

    private async helix(path: string, init: RequestInit = {}): Promise<Response> {
        const tokens = await this.access();
        return this.request(`https://api.twitch.tv/helix/${path}`, {
            ...init, headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${tokens.accessToken}`,
                'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        }).catch(() => { throw new ProviderError('Twitch request timed out or disconnected.', 502, init.method === 'POST' || init.method === 'DELETE'); });
    }

    async users(values: string[], byId = false): Promise<TwitchUser[]> {
        const results: TwitchUser[] = [];
        for (let start = 0; start < values.length; start += 100) {
            const params = new URLSearchParams();
            for (const value of values.slice(start, start + 100)) params.append(byId ? 'id' : 'login', value);
            const response = await this.helix(`users?${params}`);
            if (!response.ok) throw new ProviderError(`Twitch account lookup failed (${response.status}). Try again later.`);
            const data = await response.json() as { data: { id: string; login: string; display_name: string; profile_image_url: string; created_at: string }[] };
            if (!Array.isArray(data.data)) throw new ProviderError('Twitch returned an invalid account lookup.');
            results.push(...data.data.map(user => ({ id: user.id, login: user.login, displayName: user.display_name,
                profileImageUrl: user.profile_image_url, createdAt: user.created_at })));
        }
        return results;
    }

    async channels(): Promise<Channel[]> {
        const tokens = await this.access();
        await this.validateConnection();
        const channels: Channel[] = [{ id: tokens.user.id, login: tokens.user.login, displayName: tokens.user.login }];
        let after = '';
        const seen = new Set<string>();
        do {
            const params = new URLSearchParams({ user_id: tokens.user.id, first: '100' });
            if (after) params.set('after', after);
            const response = await this.helix(`moderation/channels?${params}`);
            if (!response.ok) throw new ProviderError(`Cannot verify moderated channels (${response.status}). Reconnect or try later.`);
            const body = await response.json() as { data: { broadcaster_id: string; broadcaster_login: string; broadcaster_name: string }[]; pagination?: { cursor?: string } };
            channels.push(...body.data.map(channel => ({ id: channel.broadcaster_id, login: channel.broadcaster_login, displayName: channel.broadcaster_name })));
            after = body.pagination?.cursor ?? '';
            if (after && seen.has(after)) throw new ProviderError('Twitch channel pagination repeated. Try later.');
            seen.add(after);
        } while (after);
        return channels;
    }

    async banned(channelId: string, ids: string[]): Promise<Set<string> | null> {
        if (channelId !== this.user?.id) return null;
        const banned = new Set<string>();
        for (let i = 0; i < ids.length; i += 100) {
            const params = new URLSearchParams({ broadcaster_id: channelId, first: '100' });
            ids.slice(i, i + 100).forEach(id => params.append('user_id', id));
            const response = await this.helix(`moderation/banned?${params}`);
            if (!response.ok) throw new ProviderError(`Cannot check existing bans (${response.status}). No bans were sent.`);
            const body = await response.json() as { data: { user_id: string; expires_at: string }[] };
            body.data.filter(entry => !entry.expires_at).forEach(entry => banned.add(entry.user_id));
        }
        return banned;
    }

    async changeBan(channelId: string, userId: string, reason: string, unban = false): Promise<'success' | 'already_banned'> {
        const tokens = await this.access();
        const params = new URLSearchParams({ broadcaster_id: channelId, moderator_id: tokens.user.id });
        if (unban) params.set('user_id', userId);
        const response = await this.helix(`moderation/bans?${params}`, { method: unban ? 'DELETE' : 'POST',
            ...(unban ? {} : { body: JSON.stringify({ data: { user_id: userId, reason: reason.slice(0, 500) } }) }) });
        if (response.ok) return 'success';
        const body = await response.json().catch(() => ({})) as { message?: string };
        if (!unban && response.status === 400 && body.message?.toLowerCase() === 'user is already banned') return 'already_banned';
        throw new ProviderError(`Twitch ${unban ? 'unban' : 'ban'} rejected (${response.status}). ${response.status === 429 ? 'Rate limit reached; wait before preparing another batch.' : 'Check permissions and current channel state.'}`,
            response.status, response.status >= 500);
    }
}
