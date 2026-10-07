export interface TwitchUser {
    id: string;
    login: string;
    displayName: string;
    profileImageUrl: string;
    createdAt: string;
}

export interface Report {
    id: string;
    login: string;
    originalLogin: string;
    reason: string;
    streamer: string;
    raw: string;
    warnings: string[];
    evidence: string[];
    sourceUrl: string;
    decision: 'pending' | 'approved' | 'skipped';
    resolved: TwitchUser | null;
    lookup: 'unresolved' | 'exists' | 'missing';
    sourceIdentity?: string;
    sourceRevision?: string;
    sourceWithdrawn?: boolean;
    sourceMessageIds?: string[];
}

export interface ImportSummary {
    files: number;
    messages: number;
    reports: number;
    attachments: number;
    loaded: number;
    failed: number;
    unassigned: number;
    ignoredMessages: number;
    issues: { messageId: string; fileName: string; reason: string }[];
}

export interface HistoryEntry {
    id: string;
    reportId: string;
    login: string;
    userId: string;
    channelId: string;
    channelLogin: string;
    action: 'ban' | 'unban';
    status: 'started' | 'success' | 'already_banned' | 'failed' | 'uncertain';
    message: string;
    at: string;
}

export interface Database {
    reports: Report[];
    history: HistoryEntry[];
    importSummary?: ImportSummary;
    exportAssets?: Record<string, string>;
}

export interface Tokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    user: { id: string; login: string };
}
