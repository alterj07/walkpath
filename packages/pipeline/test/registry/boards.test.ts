import { describe, expect, it } from 'vitest';
import {
  BOARDS_CSV_HEADER,
  RegistryError,
  defaultSourcesConfig,
  isSourceEnabled,
  parseBoardsCsv,
  parseSourcesConfig,
  serializeBoards,
  slugify,
  uniqueSlug,
} from '../../src/registry/boards.ts';
import { boardId } from '../../src/schema/board.ts';

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
    expect(rows[0]).toMatchObject({ ats: 'greenhouse', board_key: 'figma' });
    expect(rows[0]?.wd).toBeUndefined();
    expect(rows[1]).toMatchObject({ ats: 'workday', wd: 5 });
  });

  it('accepts the legacy header without wd', () => {
    const header = BOARDS_CSV_HEADER.filter((h) => h !== 'wd').join(',');
    const rows = parseBoardsCsv(`${header}\nfigma,Figma,figma.com,greenhouse,figma,https://job-boards.greenhouse.io/figma,2026-10-09,active\n`);
    expect(rows[0]?.wd).toBeUndefined();
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
    expect(problems.some((p) => p.startsWith('line 9') && p.includes('wd is required'))).toBe(true);
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

  it('round-trips the wd column through serializeBoards', () => {
    const rows = parseBoardsCsv(`${HEADER}\n${row({ ats: 'workday', board_key: 'nvidia/X', wd: '5', company_slug: 'nvidia' })}\n${row()}\n`);
    const text = serializeBoards(rows);
    expect(text).toContain(',workday,nvidia/X,');
    expect(text.split('\n')[1]?.endsWith(',')).toBe(true); // greenhouse row: empty wd
    expect(parseBoardsCsv(text).find((r) => r.ats === 'workday')?.wd).toBe(5);
  });

  it('warns (does not throw) when a slug is shared by different company names', () => {
    const warnings: string[] = [];
    const rows = parseBoardsCsv(
      `${HEADER}\n${row({ company_slug: 'atlas', company_name: 'Atlas', board_key: 'a' })}\n${row({ company_slug: 'atlas', company_name: 'ATLAS Inc.', board_key: 'b' })}\n${row({ company_slug: 'atlas', company_name: 'Atlas Robotics', ats: 'lever', board_key: 'c' })}\n`,
      warnings,
    );
    expect(rows).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/slug "atlas" \(Atlas Robotics\) is also used by "Atlas"/);
  });
});

describe('uniqueSlug', () => {
  it('reuses a slug for the same name and suffixes the ats for a different one', () => {
    const taken = new Map<string, string>();
    expect(uniqueSlug('Atlas', 'ashby', taken)).toBe('atlas');
    expect(uniqueSlug('ATLAS', 'smartrecruiters', taken)).toBe('atlas');
    expect(uniqueSlug('ATLAS, Inc.', 'smartrecruiters', taken)).toBe('atlas-inc');
    expect(uniqueSlug('Atlas Robotics', 'lever', taken)).toBe('atlas-robotics');
    expect(uniqueSlug('Axiom', 'lever', taken)).toBe('axiom');
    expect(uniqueSlug('Axiom Space', 'lever', taken)).toBe('axiom-space');
    expect(uniqueSlug('Axiom!', 'greenhouse', taken)).toBe('axiom');
    expect(uniqueSlug('Axiom Health', 'greenhouse', taken)).toBe('axiom-health');
  });

  it('walks -ats, -ats-2, ... when those are taken too', () => {
    const taken = new Map<string, string>([
      ['atlas', 'Atlas One'],
      ['atlas-lever', 'Atlas Two'],
      ['atlas-lever-2', 'Atlas Three'],
    ]);
    expect(uniqueSlug('Atlas', 'lever', taken)).toBe('atlas-lever-3');
    expect(taken.get('atlas-lever-3')).toBe('Atlas');
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
