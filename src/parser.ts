import { createHash, randomUUID } from 'node:crypto';
import type { Report } from './types.js';

export function validLogin(value: string): boolean {
    return /^[a-z0-9_]{1,25}$/i.test(value);
}

export function containsReportFields(text: string): boolean {
    return /\b(?:Streamer|Channel|Gebruikersnaam|Username|Name|Naam|Reason|Reden)\s*:/i.test(text) || /^\s*(?:Streamer|Channel)\s+\S/mi.test(text);
}

export function reportKey(report: Pick<Report, 'originalLogin' | 'reason' | 'streamer' | 'raw'>): string {
    return createHash('sha256').update(JSON.stringify([
        report.originalLogin.toLowerCase(), report.reason.trim(), report.streamer.trim(),
        report.originalLogin ? '' : report.raw.trim(),
    ])).digest('hex');
}

function makeReport(name: string, reason: string, streamer: string, raw: string): Report {
    const login = name.trim().toLowerCase();
    const warnings: string[] = [];
    if (!validLogin(login)) warnings.push('Username is missing or ambiguous. Enter the exact name shown in the evidence.');
    if (/onderstrep|underscore|\(.*_/.test(raw)) warnings.push('Underscore count is discussed in this report. Check the exact username.');
    if (!reason) warnings.push('No reported reason was found. Review the original message.');
    else if (!/racis|n[ -]?woord|homohaat|bedreig|dox|stalk|intimid|threat|harass|discriminat|hate/i.test(reason)) {
        warnings.push('The reason needs context. This text hint does not assess the screenshot or prove misconduct.');
    }
    return { id: randomUUID(), login: validLogin(login) ? login : '', originalLogin: name.trim(),
        reason, streamer, raw, warnings, evidence: [], sourceUrl: '', decision: 'pending', resolved: null, lookup: 'unresolved' };
}

export function parseReports(text: string): Report[] {
    const normalized = text.replace(/\r/g, '').trim();
    if (!normalized) return [];
    const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.every(validLogin)) return lines.map(name => makeReport(name, '', '', name));

    // Discord author/timestamp lines and repeated Streamer fields delimit reports.
    const blocks = normalized.split(/\n[^\n]*\s[—–]\s[^\n]*(?:\d{1,2}:\d{2}|Yesterday|Today)[^\n]*\n|\n(?=\s*(?:Streamer|Channel)\s*:)/i);
    const reports: Report[] = [];
    for (const block of blocks) {
        const raw = block.trim();
        if (!raw) continue;
        const fields = [...raw.matchAll(/\b(Streamer|Channel|Gebruikersnaam|Username|Name|Naam|Reason|Reden)[ \t]*:[ \t]*|(?:^|\n|[,;.]\s*)\s*(Streamer|Channel|Gebruikersnaam|Username|Name|Naam|Reason|Reden)[ \t]+(?![ \t]*:)/gi)];
        if (!fields.some(field => /Streamer|Channel|Gebruikersnaam|Username|Name|Naam/i.test(field[1] ?? field[2] ?? ''))) {
            const plain = raw.split('\n').map(line => line.trim()).filter(line => line && line !== 'Image');
            if (plain.length === 3 && validLogin(plain[1]!)) {
                const report = makeReport(plain[1]!, plain[2]!, plain[0]!, raw);
                report.warnings.push('Unstructured report: verify the inferred username, streamer and reason against the original.');
                reports.push(report);
                continue;
            }
            const previous = reports.at(-1);
            if (previous && !/^Image(?:\s+Image)*$/i.test(raw)) {
                previous.raw += `\n\nFollow-up message:\n${raw}`;
                const warning = 'There is a follow-up message, possibly a username correction. Review it before selecting this report.';
                if (!previous.warnings.includes(warning)) previous.warnings.push(warning);
            }
            continue;
        }
        let streamer = '';
        let names: string[] | null = null;
        let reason = '';
        const flush = () => {
            if (names === null) return;
            if (names !== null) for (const name of names) {
                if (name || reason || streamer) reports.push(makeReport(name, reason, streamer, raw));
            }
            names = null;
            reason = '';
        };
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i]!;
            const value = raw.slice(field.index! + field[0].length, fields[i + 1]?.index ?? raw.length)
                .replace(/\n(?:Bewijs\s*:|Evidence\s*:|Image\b)[\s\S]*$/i, '').trim().replace(/[,;]\s*$/, '');
            const label = (field[1] ?? field[2])!.toLowerCase();
            if (label === 'streamer' || label === 'channel') streamer = value;
            else if (label === 'reden' || label === 'reason') reason = value;
            else {
                flush();
                names = value.split(/\s*&\s*|\s*,\s*/).map(name => name.trim());
            }
        }
        if (names === null && !reports.some(report => report.raw === raw)) names = [''];
        flush();
    }
    return reports;
}
