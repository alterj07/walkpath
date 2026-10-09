import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_TAGS, FORBID_TAGS, PURIFY_CONFIG, purifierAvailable, sanitizeHtml, type Purifier } from '../src/lib/sanitize.ts';
import { idFromPath, SAFETY_LINE } from '../src/components/JobPage.tsx';
import { slugFromPath } from '../src/components/CompanyPage.tsx';
import { mergeTrackers } from '../src/components/SavedPage.tsx';

// The publish-time allowlist from plan section 11.2; the browser pass must match it exactly.
const PLAN_ALLOWLIST = ['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

describe('browser sanitizer configuration', () => {
  it('allows exactly the plan 11.2 tags and no attributes', () => {
    expect([...ALLOWED_TAGS].sort()).toEqual([...PLAN_ALLOWLIST].sort());
    expect(PURIFY_CONFIG.ALLOWED_TAGS.sort()).toEqual([...PLAN_ALLOWLIST].sort());
    expect(PURIFY_CONFIG.ALLOWED_ATTR).toEqual([]);
    expect(PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(PURIFY_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
  });

  it('forbids every tag the plan names explicitly', () => {
    for (const tag of ['a', 'img', 'iframe', 'svg', 'style', 'script', 'form', 'input']) {
      expect(FORBID_TAGS).toContain(tag);
      expect(PURIFY_CONFIG.FORBID_TAGS).toContain(tag);
      expect(ALLOWED_TAGS).not.toContain(tag);
    }
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('style');
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('href');
    expect(PURIFY_CONFIG.RETURN_TRUSTED_TYPE).toBe(false);
    expect(PURIFY_CONFIG.KEEP_CONTENT).toBe(true);
  });

  it('renders nothing when no DOM is available (server, tests)', () => {
    expect(purifierAvailable()).toBe(false);
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('');
    expect(sanitizeHtml('')).toBe('');
  });

  describe('with a fake window and purifier', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('renders nothing when the purifier reports no support even though a window exists', () => {
      vi.stubGlobal('window', {});
      const sanitize = vi.fn(() => '<p>should not be used</p>');
      const fake: Purifier = { isSupported: false, sanitize };
      expect(purifierAvailable(fake)).toBe(false);
      expect(sanitizeHtml('<p>hi</p>', fake)).toBe('');
      expect(sanitize).not.toHaveBeenCalled();
    });

    it('renders nothing when support flips off after the call or the result is not a string', () => {
      vi.stubGlobal('window', {});
      const flipping = { isSupported: true, sanitize() { flipping.isSupported = false; return '<p>hi</p>'; } };
      expect(sanitizeHtml('<p>hi</p>', flipping)).toBe('');
      const nonString: Purifier = { isSupported: true, sanitize: () => ({}) };
      expect(sanitizeHtml('<p>hi</p>', nonString)).toBe('');
      const throwing: Purifier = { isSupported: true, sanitize: () => { throw new Error('boom'); } };
      expect(sanitizeHtml('<p>hi</p>', throwing)).toBe('');
      const noSanitize: Purifier = { isSupported: true };
      expect(sanitizeHtml('<p>hi</p>', noSanitize)).toBe('');
    });

    it('returns the purifier output when it is supported and a string, passing the pinned config', () => {
      vi.stubGlobal('window', {});
      const sanitize = vi.fn((_html: string) => '<p>hi</p>');
      expect(sanitizeHtml('<p>hi</p><script>x</script>', { isSupported: true, sanitize })).toBe('<p>hi</p>');
      expect(sanitize).toHaveBeenCalledWith('<p>hi</p><script>x</script>', PURIFY_CONFIG);
    });

    it('still refuses without a window even if the purifier claims support', () => {
      expect(sanitizeHtml('<p>hi</p>', { isSupported: true, sanitize: () => '<p>hi</p>' })).toBe('');
    });
  });
});

describe('path parsing for the SPA fallback pages', () => {
  it('extracts a 12-hex job id and rejects everything else', () => {
    expect(idFromPath('/job/a9f3c2e17b04')).toBe('a9f3c2e17b04');
    expect(idFromPath('/job/a9f3c2e17b04/')).toBe('a9f3c2e17b04');
    expect(idFromPath('/job/A9F3C2E17B04')).toBeNull();
    expect(idFromPath('/job/../x')).toBeNull();
    expect(idFromPath('/job/')).toBeNull();
    expect(idFromPath('/jobs/a9f3c2e17b04')).toBeNull();
  });

  it('extracts a company slug and rejects everything else', () => {
    expect(slugFromPath('/company/rocket-lab')).toBe('rocket-lab');
    expect(slugFromPath('/company/rocket-lab/')).toBe('rocket-lab');
    expect(slugFromPath('/company/Rocket Lab')).toBeNull();
    expect(slugFromPath('/company/')).toBeNull();
    expect(slugFromPath(`/company/${'a'.repeat(81)}`)).toBeNull();
  });

  it('carries the safety line', () => {
    expect(SAFETY_LINE).toBe('Legitimate employers never ask for payment, bank details, or your SSN before an offer.');
  });
});

describe('mergeTrackers', () => {
  it('adds new ids and lets the newer entry win', () => {
    const current = {
      aaaaaaaaaaaa: { stage: 'saved' as const, at: '2026-10-01T00:00:00.000Z' },
      bbbbbbbbbbbb: { stage: 'applied' as const, at: '2026-10-05T00:00:00.000Z', note: 'keep' },
    };
    const imported = {
      aaaaaaaaaaaa: { stage: 'applied' as const, at: '2026-10-02T00:00:00.000Z' },
      bbbbbbbbbbbb: { stage: 'rejected' as const, at: '2026-10-04T00:00:00.000Z' },
      cccccccccccc: { stage: 'offer' as const, at: '2026-10-06T00:00:00.000Z' },
    };
    const { merged, added, updated } = mergeTrackers(current, imported);
    expect(added).toBe(1);
    expect(updated).toBe(1);
    expect(merged.aaaaaaaaaaaa?.stage).toBe('applied');
    expect(merged.bbbbbbbbbbbb?.stage).toBe('applied');
    expect(merged.bbbbbbbbbbbb?.note).toBe('keep');
    expect(merged.cccccccccccc?.stage).toBe('offer');
  });

  it('keeps the existing note when a newer imported entry has none, and takes a newer note when given', () => {
    const current = { aaaaaaaaaaaa: { stage: 'saved' as const, at: '2026-10-01T00:00:00.000Z', note: 'local note' } };
    const noNote = mergeTrackers(current, { aaaaaaaaaaaa: { stage: 'applied' as const, at: '2026-10-02T00:00:00.000Z' } });
    expect(noNote.merged.aaaaaaaaaaaa).toEqual({ stage: 'applied', at: '2026-10-02T00:00:00.000Z', note: 'local note' });
    const withNote = mergeTrackers(current, { aaaaaaaaaaaa: { stage: 'applied' as const, at: '2026-10-02T00:00:00.000Z', note: 'imported' } });
    expect(withNote.merged.aaaaaaaaaaaa?.note).toBe('imported');
    const older = mergeTrackers(current, { aaaaaaaaaaaa: { stage: 'rejected' as const, at: '2026-09-01T00:00:00.000Z' } });
    expect(older.merged.aaaaaaaaaaaa?.stage).toBe('saved');
    expect(older.updated).toBe(0);
  });
});
