import { describe, expect, it } from 'vitest';
import { unsafeStringReason, validateSummaryOutput } from '../../src/llm/schema.ts';
import { GOOD_OUTPUT } from './fixtures.ts';

describe('validateSummaryOutput', () => {
  it('accepts a well-formed output', () => {
    const r = validateSummaryOutput(GOOD_OUTPUT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.must_have_skills).toEqual(['Python', 'SQL']);
  });

  it.each([
    ['html tag', { summary: 'Great role <script>alert(1)</script>' }, 'html'],
    ['url', { summary: 'Apply at https://evil.example now' }, 'url'],
    ['www url', { qualifications: ['see www.evil.example'] }, 'url'],
    ['email', { responsibilities: ['email bob@evil.example'] }, 'email'],
    ['phone', { summary: 'Call +1 (555) 123-4567 to apply' }, 'phone'],
    ['bare phone', { summary: 'call 555 123 4567' }, 'phone'],
    ['angle bracket in skill', { must_have_skills: ['C++', '<b>Go</b>'] }, 'html'],
    ['scheme-less link', { summary: 'Apply at evil-site.com/apply today' }, 'url'],
    ['telegram short link', { summary: 'Message t.me/x for details' }, 'url'],
    ['defanged url', { summary: 'See hxxp://evil for more' }, 'url'],
    ['messaging app', { qualifications: ['Contact us on WhatsApp'] }, 'contact'],
    ['zero-width split url', { summary: 'See ht' + String.fromCharCode(0x200b) + 'tp://evil.example' }, 'url'],
  ])('rejects %s', (_label, patch, reason) => {
    const r = validateSummaryOutput({ ...GOOD_OUTPUT, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith('unsafe:')).toBe(true);
      expect(r.reason.endsWith(reason)).toBe(true);
      // The reason never echoes model text.
      expect(r.reason).not.toContain('evil');
      expect(r.reason).not.toContain('script');
    }
  });

  it('rejects oversize lists, long strings, bad enums and extra keys quietly', () => {
    const tooMany = validateSummaryOutput({ ...GOOD_OUTPUT, responsibilities: Array(6).fill('x') });
    expect(tooMany.ok).toBe(false);
    const tooLong = validateSummaryOutput({ ...GOOD_OUTPUT, summary: 'a'.repeat(401) });
    expect(tooLong.ok).toBe(false);
    const badFamily = validateSummaryOutput({ ...GOOD_OUTPUT, role_family: 'sales' });
    expect(badFamily.ok).toBe(false);
    const badSeason = validateSummaryOutput({ ...GOOD_OUTPUT, season: 'Summer' });
    expect(badSeason.ok).toBe(false);
    const badYear = validateSummaryOutput({ ...GOOD_OUTPUT, grad_years: [1999] });
    expect(badYear.ok).toBe(false);
    const extra = validateSummaryOutput({ ...GOOD_OUTPUT, link: 'http://x' });
    expect(extra.ok).toBe(true); // unknown keys are stripped, not fatal
    if (extra.ok) expect('link' in extra.value).toBe(false);
  });

  it('reports schema failures by path only', () => {
    const r = validateSummaryOutput({ summary: 'ok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith('schema: responsibilities')).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateSummaryOutput(null).ok).toBe(false);
    expect(validateSummaryOutput('{}').ok).toBe(false);
  });
});

describe('unsafeStringReason', () => {
  it('allows ordinary text with digits and punctuation', () => {
    expect(unsafeStringReason('GPA 3.5+ preferred; 2-3 years of C++ (C++17)')).toBeNull();
    expect(unsafeStringReason('Graduating in May 2027 or December 2027')).toBeNull();
    expect(unsafeStringReason('Students graduating 2026-2027 or 2026 – 2028')).toBeNull();
    expect(unsafeStringReason('Requisition 2026 1234 5678 is open')).toBeNull();
  });

  it('allows technology names that contain dots', () => {
    for (const s of ['Node.js', '.NET', 'C++', 'Vue.js and Next.js', 'ASP.NET Core', 'socket.io', 'web.dev tooling']) {
      expect(unsafeStringReason(s), s).toBeNull();
    }
  });
});
