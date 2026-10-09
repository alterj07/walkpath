import { describe, expect, it } from 'vitest';
import { groupKey } from '../../src/normalize/group.ts';

describe('groupKey', () => {
  it('groups city variants of the same title on the same board', () => {
    const a = groupKey({ title: 'Summer 2027 Engineering Internships - Austin, TX', boardId: 'greenhouse:acme' });
    const b = groupKey({ title: 'Summer 2027 Engineering Internships - Seattle, WA', boardId: 'greenhouse:acme' });
    const c = groupKey({ title: 'Summer 2027 Engineering Internships (Remote)', boardId: 'greenhouse:acme' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
  it('separates different boards and different titles', () => {
    const a = groupKey({ title: 'Software Intern', boardId: 'greenhouse:acme' });
    expect(groupKey({ title: 'Software Intern', boardId: 'lever:acme' })).not.toBe(a);
    expect(groupKey({ title: 'Hardware Intern', boardId: 'greenhouse:acme' })).not.toBe(a);
  });
  it('prefers the requisition id when present', () => {
    const a = groupKey({ title: 'Software Intern - Austin', boardId: 'greenhouse:acme', internalReqId: '123' });
    const b = groupKey({ title: 'Software Intern (Remote)', boardId: 'greenhouse:acme', internalReqId: '123' });
    expect(a).toBe(b);
    expect(a).toBe('greenhouse:acme|req:123');
  });
});
