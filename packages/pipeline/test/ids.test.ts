import { describe, expect, it } from 'vitest';
import { canonicalKey, contentHash, jobIdFromKey } from '../src/ids.ts';

describe('ids', () => {
  it('builds canonical keys', () => {
    expect(canonicalKey('greenhouse', 'figma', '12345')).toBe('greenhouse:figma:12345');
  });

  it('derives a stable 12-hex job id', () => {
    const id = jobIdFromKey('greenhouse:figma:12345');
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(jobIdFromKey('greenhouse:figma:12345')).toBe(id);
    expect(jobIdFromKey('greenhouse:figma:12346')).not.toBe(id);
  });

  it('content hash is 32 hex, stable, null-safe and order-independent of input object keys', () => {
    const a = contentHash({ title: 'Intern', locations: ['NYC'], description: 'x' });
    const b = contentHash({ description: 'x', locations: ['NYC'], title: 'Intern' });
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(a).toBe(b);
    expect(contentHash({ title: 'Intern', department: null })).toBe(contentHash({ title: 'Intern' }));
    expect(contentHash({ title: 'Intern', remoteFlag: true })).not.toBe(contentHash({ title: 'Intern' }));
    expect(contentHash({ title: 'Intern', locations: ['A', 'B'] })).not.toBe(contentHash({ title: 'Intern', locations: ['AB'] }));
  });
});
