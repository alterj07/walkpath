import { describe, expect, it } from 'vitest';
import {
  BOARDS_CSV_HEADER,
  RegistryError,
  boardId,
  defaultSourcesConfig,
  isSourceEnabled,
  parseBoardsCsv,
  parseSourcesConfig,
  serializeBoards,
  slugify,
} from '../../src/registry/boards.ts';

const HEADER = BOARDS_CSV_HEADER.join(',');
const row = (over: Partial<Record<(typeof BOARDS_CSV_HEADER)[number], string>> = {}) => {
  const base = {
    company_slug: 'figma',
    company_name: 'Figma',
    domain: 'figma.com',
    ats: 'greenhouse',
    board_key: 'figma',
    careers_url: 'https://job-boards.greenhouse.io/figma',
    added_at: '2026-10-09',
    status: 'active',
    wd: '',
    ...over,
  };
  return BOARDS_CSV_HEADER.map((h) => base[h]).join(',');
};

describe('parseBoardsCsv', () => {
  it('parses valid rows', () => {
    const rows = parseBoardsCsv(`${HEADER}\n${row()}\n${row({ ats: 'workday', board_key: 'nvidia/NVIDIAExternalCareerSite', wd: '5', company_slug: 'nvidia', company_name: 'NVIDIA' })}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ats: 'greenhouse', board_key: 'figma', wd: '' });
    expect(rows[1]).toMatchObject({ ats: 'workday', wd: '5' });
  });

  it('accepts the legacy header without wd', () => {
    const header = BOARDS_CSV_HEADER.filter((h) => h !== 'wd').join(',');
    const rows = parseBoardsCsv(`${header}\nfigma,Figma,figma.com,greenhouse,figma,,2026-10-09,active\n`);
    expect(rows[0]?.wd).toBe('');
  });

  it('reports every bad line at once', () => {
    const text = [
      HEADER,
      row({ company_slug: 'Bad Slug' }),
      row({ ats: 'unknownats', board_key: 'x' }),
      row({ domain: 'not a domain', board_key: 'y' }),
      row({ added_at: 'yesterday', board_key: 'z' }),
      row({ status: 'paused', board_key: 'w' }),
      row({ careers_url: 'ftp://x', board_key: 'v' }),
      row({ ats: 'workday', board_key: 'nositeslash', wd: '5' }),
      row({ ats: 'workday', board_key: 'a/b' }),
    ].join('\n');
    let err: unknown;
    try {
      parseBoardsCsv(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RegistryError);
    const problems = (err as RegistryError).problems;
    expect(problems.some((p) => p.startsWith('line 2') && p.includes('company_slug'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 3') && p.includes('ats'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 4') && p.includes('domain'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 5') && p.includes('added_at'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 6') && p.includes('status'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 7') && p.includes('careers_url'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 8') && p.includes('tenant/site'))).toBe(true);
    expect(problems.some((p) => p.startsWith('line 9') && p.includes('need wd'))).toBe(true);
    expect(problems).toHaveLength(8);
  });

  it('rejects duplicate (ats, board_key) pairs', () => {
    expect(() => parseBoardsCsv(`${HEADER}\n${row()}\n${row({ company_slug: 'figma-2' })}\n`)).toThrow(/duplicate board greenhouse:figma \(first seen on line 2\)/);
  });

  it('rejects unknown and missing columns', () => {
    expect(() => parseBoardsCsv('company_slug,extra\nx,y\n')).toThrow(/missing column "company_name"/);
    expect(() => parseBoardsCsv('company_slug,extra\nx,y\n')).toThrow(/unknown column "extra"/);
  });

  it('serializes sorted by ats then board_key with the canonical header', () => {
    const rows = parseBoardsCsv(`${HEADER}\n${row({ ats: 'lever', board_key: 'b' })}\n${row({ ats: 'greenhouse', board_key: 'z' })}\n${row({ ats: 'greenhouse', board_key: 'a' })}\n`);
    const text = serializeBoards(rows);
    const keys = text
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(',').slice(3, 5).join(':'));
    expect(text.startsWith(`${HEADER}\n`)).toBe(true);
    expect(keys).toEqual(['greenhouse:a', 'greenhouse:z', 'lever:b']);
    expect(parseBoardsCsv(text)).toHaveLength(3);
  });

  it('boardId joins ats and key', () => {
    expect(boardId({ ats: 'workday', board_key: 'nvidia/X' })).toBe('workday:nvidia/X');
  });
});

describe('slugify', () => {
  it.each([
    ['Figma', 'figma'],
    ['Rocket Lab', 'rocket-lab'],
    ['Acme, Inc.', 'acme-inc'],
    ['Procter & Gamble', 'procter-and-gamble'],
    ['Ørsted', 'orsted'],
    ['  --Weird__Name--  ', 'weird-name'],
    ['10x Genomics', '10x-genomics'],
    ['', 'company'],
    ['株式会社', 'company'],
  ])('%s → %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe('sources.json', () => {
  it('defaults missing sources to enabled', () => {
    const cfg = parseSourcesConfig('{"sources":{"workday":{"enabled":false}}}');
    expect(isSourceEnabled(cfg, 'workday')).toBe(false);
    expect(isSourceEnabled(cfg, 'greenhouse')).toBe(true);
    expect(cfg.publish.enabled).toBe(true);
  });

  it('accepts an empty object', () => {
    const cfg = parseSourcesConfig('{}');
    expect(cfg.publish.enabled).toBe(true);
    expect(isSourceEnabled(cfg, 'lever')).toBe(true);
  });

  it('rejects unknown source names', () => {
    expect(() => parseSourcesConfig('{"sources":{"linkedin":{"enabled":true}}}')).toThrow();
  });

  it('defaultSourcesConfig lists every ATS enabled', () => {
    const cfg = defaultSourcesConfig();
    expect(Object.keys(cfg.sources)).toContain('greenhouse');
    expect(Object.values(cfg.sources).every((s) => s.enabled)).toBe(true);
    expect(parseSourcesConfig(JSON.stringify(cfg))).toEqual(cfg);
  });
});
