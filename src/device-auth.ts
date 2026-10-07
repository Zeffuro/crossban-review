import { randomHex } from './platform.js';
import { ProviderError } from './twitch.js';
import type { Tokens } from './types.js';

export interface DeviceLogin { id: string; userCode: string; url: string; expiresAt: number; interval: number }
interface Session extends DeviceLogin { deviceCode: string; nextPoll: number }
const scopes = ['moderator:manage:banned_users', 'user:read:moderated_channels'];

export class DeviceAuth {
    private session: Session | null = null;
    constructor(private readonly clientId: string, private readonly request: typeof fetch = fetch.bind(globalThis)) {}

    cancel(): void { this.session = null; }

    async start(): Promise<DeviceLogin> {
        this.cancel();
        if (!this.clientId) throw new ProviderError('Set TWITCH_CLIENT_ID in .env, then restart.', 400);
        const response = await this.request('https://id.twitch.tv/oauth2/device', {
            method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scopes: scopes.join(' ') }),
            signal: AbortSignal.timeout(15000),
        }).catch(() => { throw new ProviderError('Twitch login is unavailable. Try again later.'); });
        if (!response.ok) throw new ProviderError('Twitch could not start login. Check that this client ID belongs to a Public Twitch application.', 400);
        const data = await response.json() as Record<string, unknown>;
        if (typeof data.device_code !== 'string' || !data.device_code || typeof data.user_code !== 'string' ||
            !/^[A-Za-z0-9-]{4,32}$/.test(data.user_code) || typeof data.verification_uri !== 'string' ||
            typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
            typeof data.interval !== 'number' || !Number.isFinite(data.interval) || data.interval <= 0 || data.interval >= data.expires_in) {
            throw new ProviderError('Twitch returned incomplete login details. Try again.');
        }
        let url: URL;
        try { url = new URL(data.verification_uri); }
        catch { throw new ProviderError('Twitch returned an unexpected login address.'); }
        if (url.protocol !== 'https:' || !['www.twitch.tv', 'twitch.tv'].includes(url.hostname) || url.pathname !== '/activate' ||
            url.username || url.password || url.port || url.hash || url.searchParams.get('device-code') !== data.user_code) {
            throw new ProviderError('Twitch returned an unexpected login address.');
        }
        const interval = Math.max(5, data.interval);
        const login: DeviceLogin = { id: randomHex(16), userCode: data.user_code, url: url.href,
            expiresAt: Date.now() + Math.min(1800, data.expires_in) * 1000, interval };
        this.session = { ...login, deviceCode: data.device_code, nextPoll: Date.now() + interval * 1000 };
        return login;
    }

    async poll(id: string): Promise<Omit<Tokens, 'user'> | null> {
        const session = this.session;
        if (!session || session.id !== id || session.expiresAt <= Date.now()) {
            throw new ProviderError('Twitch login expired or was replaced. Start again.', 401);
        }
        if (Date.now() < session.nextPoll) return null;
        session.nextPoll = Date.now() + session.interval * 1000;
        let response: Response;
        try {
            response = await this.request('https://id.twitch.tv/oauth2/token', {
                method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scopes: scopes.join(' '),
                    device_code: session.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
                signal: AbortSignal.timeout(15000),
            });
        } catch {
            this.cancel();
            throw new ProviderError('Twitch login request failed. Start again; it was not retried.');
        }
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        if ([400, 429].includes(response.status) && (data.message === 'authorization_pending' || data.message === 'slow_down')) {
            if (data.message === 'slow_down') {
                session.interval += 5;
                session.nextPoll = Date.now() + session.interval * 1000;
            }
            return null;
        }
        this.cancel();
        if (!response.ok) throw new ProviderError('Twitch login was cancelled, expired or rejected. Start again.', 401);
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token ||
            typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
            throw new ProviderError('Twitch returned incomplete authorization.');
        }
        return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 };
    }
}
