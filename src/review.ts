import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseReports, reportKey, validLogin } from './parser.js';
import type { Storage } from './storage.js';
import { ProviderError, type Twitch } from './twitch.js';
import type { HistoryEntry, Report } from './types.js';

export class ReviewError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
interface Item { reportId: string; login: string; userId: string; reason: string }
interface Plan { planId: string; channelId: string; channelLogin: string; actorId: string; items: Item[]; expiresAt: number; skipped: { login: string; reason: string }[] }

function validSourceUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 500) return false;
    if (!value) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
}

export class Review {
    busy = false;
    private readonly plans = new Map<string, Plan>();
    constructor(readonly storage: Storage, readonly twitch: Twitch, private readonly pause = () => delay(1200)) {}

    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.busy) throw new ReviewError('Another operation is running. Wait for it to finish.', 409);
        this.busy = true;
        try { return await operation(); }
        finally { this.busy = false; }
    }

    invalidate(): void { this.plans.clear(); }
    report(id: string): Report {
        const report = this.storage.database.reports.find(item => item.id === id);
        if (!report) throw new ReviewError('Report not found.', 404);
        return report;
    }

    async import(text: string): Promise<void> {
        const reports = parseReports(text);
        if (!reports.length) throw new ReviewError('No reports found. Use Channel / Username / Reason fields, or one exact username per line.');
        await this.importReports(reports);
    }

    findImportedReport(report: Report, existing = new Map(this.storage.database.reports.map(item => [reportKey(item), item]))): Report | undefined {
        const sourceMatch = report.sourceIdentity && this.storage.database.reports.find(item => item.sourceIdentity === report.sourceIdentity);
        const keyed = existing.get(reportKey(report));
        if (sourceMatch) return sourceMatch;
        if (keyed && (!report.sourceIdentity || !keyed.sourceIdentity)) return keyed;
        if (!report.sourceIdentity) return undefined;
        const baseMessage = report.raw.split('\n\nFollow-up message:')[0]!;
        const legacy = this.storage.database.reports.filter(item => !item.sourceIdentity);
        const rawMatches = legacy.filter(item => item.raw.includes(baseMessage) &&
            item.originalLogin.replace(/`/g, '').toLowerCase() === report.originalLogin.replace(/`/g, '').toLowerCase());
        if (rawMatches.length === 1) return rawMatches[0];
        const spelling = (value: string) => value.replace(/[_`\s]/g, '').toLowerCase();
        const uncertainMatches = legacy.filter(item => (/underscore|onderstrep/i.test(item.raw) || item.warnings.some(warning => /underscore/i.test(warning))) &&
            spelling(item.originalLogin) === spelling(report.originalLogin) && spelling(item.streamer) === spelling(report.streamer) &&
            item.reason.trim().toLowerCase() === report.reason.trim().toLowerCase());
        return uncertainMatches.length === 1 ? uncertainMatches[0] : undefined;
    }

    async importReports(reports: Report[], observedSources: string[] = []): Promise<void> {
        this.invalidate();
        const observed = new Set(observedSources);
        const active = new Set(reports.map(report => report.sourceIdentity));
        for (const report of this.storage.database.reports) {
            if (report.sourceIdentity && observed.has(report.sourceIdentity.slice(0, report.sourceIdentity.lastIndexOf('/'))) && !active.has(report.sourceIdentity)) {
                report.sourceWithdrawn = true;
                report.decision = 'pending';
                report.lookup = 'unresolved';
                report.resolved = null;
                report.warnings = [...new Set([...report.warnings, 'The latest exported message no longer lists this account. This report is blocked; review its source.'])];
            }
        }
        const existing = new Map(this.storage.database.reports.map(report => [reportKey(report), report]));
        for (const report of reports) {
            if (report.sourceIdentity) report.sourceRevision = createHash('sha256').update(report.raw).digest('hex');
            const previous = this.findImportedReport(report, existing);
            const sourceMatch = previous?.sourceIdentity === report.sourceIdentity && !!report.sourceIdentity;
            if (!previous) {
                this.storage.database.reports.push(report);
                existing.set(reportKey(report), report);
            } else {
                const newText = !previous.raw.includes(report.raw);
                const newEvidence = report.evidence.some(url => !previous.evidence.includes(url));
                const sourceChanged = !!sourceMatch && previous.sourceRevision !== report.sourceRevision;
                const fieldsChanged = !!report.sourceIdentity && reportKey(previous) !== reportKey(report);
                if (fieldsChanged) {
                    if (previous.originalLogin !== report.originalLogin) previous.login = report.login;
                    previous.originalLogin = report.originalLogin;
                    previous.reason = report.reason;
                    previous.streamer = report.streamer;
                    previous.warnings.push(sourceMatch ? 'The exported report was edited. Check the original message and exact account again.'
                        : 'Export spelling differs from the ambiguous pasted report. Verify every underscore against the screenshot before approving.');
                }
                if (newText || sourceChanged || fieldsChanged) {
                    if (newText) previous.raw = report.raw.includes(previous.raw) ? report.raw : `${previous.raw}\n\nAdditional import:\n${report.raw}`;
                    previous.decision = 'pending';
                    previous.resolved = null;
                    previous.lookup = 'unresolved';
                    previous.warnings.push('New information was imported. Review this report again, including any corrections.');
                } else if (newEvidence && previous.decision === 'approved') previous.decision = 'pending';
                previous.warnings = [...new Set([...previous.warnings, ...report.warnings])];
                previous.evidence = [...new Set([...previous.evidence, ...report.evidence])];
                if (report.sourceIdentity) previous.sourceIdentity = report.sourceIdentity;
                if (report.sourceRevision) previous.sourceRevision = report.sourceRevision;
                if (report.sourceIdentity) previous.sourceWithdrawn = false;
                if (report.sourceMessageIds) previous.sourceMessageIds = [...new Set([...(previous.sourceMessageIds ?? []), ...report.sourceMessageIds])];
                if (!previous.sourceUrl && report.sourceUrl) previous.sourceUrl = report.sourceUrl;
            }
        }
        await this.storage.save();
    }

    async update(id: string, input: Record<string, unknown>): Promise<void> {
        const report = this.report(id);
        const login = input.login;
        const url = input.sourceUrl;
        const decision = input.decision;
        if (login !== undefined && (typeof login !== 'string' || !validLogin(login.trim()))) throw new ReviewError('Enter an exact Twitch username, preserving every underscore.');
        if (url !== undefined && !validSourceUrl(url)) throw new ReviewError('Use an HTTPS source link without embedded credentials, or leave it empty.');
        if (decision !== undefined && !['pending', 'approved', 'skipped'].includes(String(decision))) throw new ReviewError('Invalid review decision.');
        const loginChanged = typeof login === 'string' && login.trim().toLowerCase() !== report.login;
        if (decision === 'approved' && (report.lookup !== 'exists' || loginChanged)) throw new ReviewError('Resolve this account before approving it.');
        if (decision === 'approved' && report.sourceWithdrawn) throw new ReviewError('The latest exported source no longer lists this account. It cannot be approved.');
        this.invalidate();
        if (typeof login === 'string' && loginChanged) {
            report.login = login.trim().toLowerCase();
            report.resolved = null;
            report.lookup = 'unresolved';
            report.decision = 'pending';
            report.warnings.push('Username was manually changed. Resolve it again and compare it with the evidence.');
        }
        if (typeof url === 'string') report.sourceUrl = url;
        if (typeof decision === 'string') {
            report.decision = decision as Report['decision'];
        }
        await this.storage.save();
    }

    async resolve(ids?: string[]): Promise<void> {
        this.invalidate();
        const reports = ids ? ids.map(id => this.report(id)) : this.storage.database.reports.filter(report => report.decision !== 'skipped' && !report.sourceWithdrawn);
        if (reports.some(report => report.sourceWithdrawn)) throw new ReviewError('The latest exported source no longer lists this account. Review its message in Discord.');
        const names = [...new Set(reports.map(report => report.login).filter(validLogin))];
        const users = await this.twitch.users(names);
        for (const report of reports) {
            const user = users.find(user => user.login.toLowerCase() === report.login);
            if (report.resolved?.id !== user?.id) report.decision = 'pending';
            report.resolved = user ?? null;
            report.lookup = user ? 'exists' : validLogin(report.login) ? 'missing' : 'unresolved';
        }
        await this.storage.save();
    }

    private lastAction(userId: string, channelId: string): HistoryEntry | undefined {
        return this.storage.database.history.findLast(entry => entry.userId === userId && entry.channelId === channelId
            && (entry.status === 'success' || entry.status === 'already_banned' || entry.status === 'uncertain' || entry.status === 'started'));
    }

    async prepare(ids: string[], channelId: string, reviewed: boolean): Promise<Plan> {
        this.invalidate();
        if (!reviewed) throw new ReviewError('Confirm you reviewed the evidence, exact identities and reasons.');
        if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new ReviewError('Select 1–100 distinct reports.');
        const reports = ids.map(id => this.report(id));
        if (reports.some(report => report.sourceWithdrawn || report.decision !== 'approved' || report.lookup !== 'exists' || !report.resolved)) throw new ReviewError('Only reviewed, approved and resolved reports can be selected.');
        const channel = (await this.twitch.channels()).find(channel => channel.id === channelId);
        if (!channel) throw new ReviewError('This Twitch account cannot moderate the selected channel.', 403);
        const users = await this.twitch.users(reports.map(report => report.login));
        if (reports.some(report => !users.some(user => user.id === report.resolved?.id && user.login === report.login))) throw new ReviewError('An account changed or disappeared. Resolve and review the list again.', 409);
        const existing = await this.twitch.banned(channelId, reports.map(report => report.resolved!.id));
        const skipped: Plan['skipped'] = [];
        const items: Item[] = [];
        const seen = new Set<string>();
        for (const report of reports) {
            const userId = report.resolved!.id;
            const last = this.lastAction(userId, channelId);
            if (last && ['uncertain', 'started'].includes(last.status)) throw new ReviewError(`Check the uncertain operation for ${report.login} in history first.`, 409);
            if (existing?.has(userId) || (last?.action === 'ban' && ['success', 'already_banned'].includes(last.status))) {
                skipped.push({ login: report.login, reason: 'Already banned or previously recorded as banned in this channel.' });
            } else if (seen.has(userId)) skipped.push({ login: report.login, reason: 'Duplicate Twitch user ID.' });
            else {
                seen.add(userId);
                if (userId === channel.id || userId === this.twitch.user?.id) throw new ReviewError('Cannot select the broadcaster or connected account.');
                items.push({ reportId: report.id, userId, login: report.login, reason: report.reason });
            }
        }
        if (!items.length) throw new ReviewError('Every selected user was already banned or duplicated. No batch is needed.');
        const plan: Plan = { planId: randomUUID(), channelId: channel.id, channelLogin: channel.login, actorId: this.twitch.user!.id,
            items, skipped, expiresAt: Date.now() + 5 * 60000 };
        this.plans.set(plan.planId, plan);
        return plan;
    }

    async execute(planId: string, confirmation: string): Promise<void> {
        const plan = this.plans.get(planId);
        this.invalidate();
        if (!plan || plan.expiresAt < Date.now()) throw new ReviewError('The preview expired or changed. Prepare a new batch.', 409);
        if (confirmation !== plan.channelLogin) throw new ReviewError('Type the exact target channel login to confirm.');
        if (this.twitch.user?.id !== plan.actorId) throw new ReviewError('The connected Twitch account changed.', 409);
        if (!(await this.twitch.channels()).some(channel => channel.id === plan.channelId)) throw new ReviewError('Channel moderation permission changed.', 403);
        const users = await this.twitch.users(plan.items.map(item => item.login));
        if (plan.items.some(item => !users.some(user => user.id === item.userId && user.login === item.login))) throw new ReviewError('An account identity changed. Prepare and review again.', 409);
        for (const [index, item] of plan.items.entries()) {
            if (index) await this.pause();
            const ok = await this.change(item, plan.channelId, plan.channelLogin, false);
            if (!ok) break;
        }
    }

    private async change(item: Item, channelId: string, channelLogin: string, unban: boolean): Promise<boolean> {
        const entry: HistoryEntry = { id: randomUUID(), reportId: item.reportId, userId: item.userId, login: item.login,
            channelId, channelLogin, action: unban ? 'unban' : 'ban', status: 'started', message: '', at: new Date().toISOString() };
        this.storage.database.history.push(entry);
        await this.storage.save();
        try {
            entry.status = await this.twitch.changeBan(channelId, item.userId, `Crossban reviewed locally: ${item.reason || 'See original report'}`, unban);
            entry.message = entry.status === 'already_banned' ? 'Already banned; this tool did not create the ban.' : unban ? 'Unban completed.' : 'Permanent ban completed.';
        } catch (error) {
            entry.status = error instanceof ProviderError && !error.uncertain ? 'failed' : 'uncertain';
            entry.message = error instanceof ProviderError ? error.message : 'Provider outcome unknown. Check Twitch manually before proceeding.';
        }
        await this.storage.save();
        return entry.status === 'success' || entry.status === 'already_banned';
    }

    async unban(historyId: string, confirmation: string): Promise<void> {
        this.invalidate();
        const entry = this.storage.database.history.find(entry => entry.id === historyId);
        if (!entry || entry.action !== 'ban' || entry.status !== 'success') throw new ReviewError('Only a successful ban recorded by this tool can be undone.');
        if (confirmation !== entry.channelLogin) throw new ReviewError('Type the exact channel login.');
        if (this.lastAction(entry.userId, entry.channelId)?.id !== entry.id) throw new ReviewError('There is a newer action for this user. Review history first.', 409);
        if (!(await this.twitch.channels()).some(channel => channel.id === entry.channelId)) throw new ReviewError('You no longer moderate this channel.', 403);
        await this.change({ reportId: entry.reportId, login: entry.login, userId: entry.userId, reason: '' }, entry.channelId, entry.channelLogin, true);
    }

    async reconcile(historyId: string, outcome: string, reviewed: boolean): Promise<void> {
        const entry = this.storage.database.history.find(entry => entry.id === historyId);
        if (!entry || entry.status !== 'uncertain' || !reviewed || !['success', 'failed'].includes(outcome)) throw new ReviewError('Check this uncertain operation on Twitch and explicitly confirm its outcome.');
        this.invalidate();
        entry.status = outcome as 'success' | 'failed';
        entry.message = 'Outcome manually confirmed by the reviewer after checking Twitch.';
        await this.storage.save();
    }
}
