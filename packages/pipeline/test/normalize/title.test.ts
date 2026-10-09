import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../../src/normalize/title.ts';

const cases: Array<[string, string]> = [
  ['  Software   Engineer Intern ', 'Software Engineer Intern'],
  ['Software Engineer Intern - Richmond, VA', 'Software Engineer Intern'],
  ['Data Intern (Remote)', 'Data Intern'],
  ['ML Intern | New York', 'ML Intern'],
  ['Intern - Software (REQ-12345)', 'Intern - Software'],
  ['Hardware Intern - 2026-1234', 'Hardware Intern'],
  ['Firmware Intern #12345', 'Firmware Intern'],
  ['Design Intern [R123456]', 'Design Intern'],
  ['Product Intern - JR0012345', 'Product Intern'],
  ['Intern, Software - Austin, Texas, US', 'Intern, Software'],
  ['Software Engineering Intern - Summer 2027', 'Software Engineering Intern - Summer 2027'],
  ['Intern (Job ID: 445566)', 'Intern'],
  ['Embedded Intern - Remote - US', 'Embedded Intern'],
  ['Data Science Intern - Seattle, WA - Remote', 'Data Science Intern'],
  ['Intern - Hybrid', 'Intern'],
  ['Security Intern (United States)', 'Security Intern'],
  ['Software Engineering Intern | Boston', 'Software Engineering Intern'],
  ['Software Engineer Intern - Richmond, VA (Intern)', 'Software Engineer Intern'],
  ['Software Engineer - Richmond, VA (Intern)', 'Software Engineer Intern'],
  ['Software Engineer (Co-op)', 'Software Engineer Co-op'],
  ['iOS Engineer Intern - Mobile', 'iOS Engineer Intern - Mobile'],
  ['Backend Intern - Springfield', 'Backend Intern - Springfield'],
];

describe('normalizeTitle', () => {
  for (const [raw, expected] of cases) {
    it(`normalizes ${JSON.stringify(raw)}`, () => {
      const r = normalizeTitle(raw);
      expect(r.title).toBe(expected);
      expect(r.title_raw).toBe(raw);
    });
  }

  it('keeps meaningful dash segments that are not locations', () => {
    expect(normalizeTitle('Software Engineer Intern - Ads Infrastructure').title).toBe('Software Engineer Intern - Ads Infrastructure');
    expect(normalizeTitle('Intern - Indiana Jones Team').title).toBe('Intern - Indiana Jones Team');
  });

  it('never returns an empty title', () => {
    expect(normalizeTitle('(REQ-1234)').title).toBe('(REQ-1234)');
  });
});
