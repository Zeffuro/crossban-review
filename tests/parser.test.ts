import { describe, expect, it } from 'vitest';
import { parseReports, reportKey } from '../src/parser.js';

describe('Discord paste import', () => {
    it('accepts English reports, repeated channel fields, and mixed Dutch labels', () => {
        const reports = parseReports('Channel: example_channel\nUsername: person_one\nReason: Harassment\nEvidence: screenshot\nChannel: other_channel\nName: person_two\nReden: racisme');
        expect(reports.map(report => report.login)).toEqual(['person_one', 'person_two']);
        expect(reports[0]).toMatchObject({ streamer: 'example_channel', reason: 'Harassment' });
        expect(reports[1]).toMatchObject({ streamer: 'other_channel', reason: 'racisme' });
    });
    it('keeps inline, multiple-name and unstructured reports and excludes the blank template', () => {
        const reports = parseReports(`Streamer:\nGebruikersnaam:\nReden:\nBewijs:\n[SCREENSHOT]
Mod — 10/4/2026 17:30
Streamer: example_channel, Naam: person_one Reden: bodyshaming
Image
Mod — Yesterday at 15:50
Streamer: example_channel
naam: person_two & person_three
reden: racisme
Image
Mod — Yesterday at 16:00
other_channel
person_four
haatspraak
Image`);
        expect(reports.map(report => report.login)).toEqual(['person_one', 'person_two', 'person_three', 'person_four']);
        expect(reports[0]?.reason).toBe('bodyshaming');
        expect(reports[3]?.warnings.join(' ')).toContain('Unstructured');
        expect(reports.every(report => report.decision === 'pending')).toBe(true);
    });
    it('preserves underscore corrections and missing names without inventing identities', () => {
        const reports = parseReports(`Streamer: example
Naam: ambiguous__ (4 underscores)
Reden: Homohaat
Image
Mod — Yesterday at 15:50
ambiguous____
Mod — Yesterday at 16:00
Streamer: example
Reden: Haat
Image
Mod — Yesterday at 16:01
missing_name__`);
        expect(reports).toHaveLength(2);
        expect(reports.map(report => report.login)).toEqual(['', '']);
        expect(reports[0]?.raw).toContain('ambiguous____');
        expect(reports[1]?.raw).toContain('missing_name__');
    });
    it('accepts spaces before colons and leaves names inside reason prose intact', () => {
        const reports = parseReports('Streamer : example\nNaam : 0123456\nReden : hij heeft zijn naam ernaar veranderd\nImage');
        expect(reports).toHaveLength(1);
        expect(reports[0]?.login).toBe('0123456');
        expect(reports[0]?.reason).toBe('hij heeft zijn naam ernaar veranderd');
    });
    it('deduplication keys survive separate imports and case differences', () => {
        const first = parseReports('Streamer: example\nNaam: Some_User\nReden: racisme')[0]!;
        const second = parseReports('Streamer: example\nNaam: some_user\nReden: racisme')[0]!;
        expect(first.id).not.toBe(second.id);
        expect(reportKey(first)).toBe(reportKey(second));
    });
    it('keeps a reason that occurs before the username', () => {
        const report = parseReports('Streamer: example\nReden: racisme\nNaam: someone')[0];
        expect(report?.reason).toBe('racisme');
    });
});
