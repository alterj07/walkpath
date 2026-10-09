/**
 * The board registry (`registry/boards.csv`) and the source kill switches (`registry/sources.json`).
 * Plan sections 6.1, 8.2, 11.4.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parseCsv, serializeCsv } from './csv.ts';

/** Every ATS a registry row may name. Adapters exist for the first six in the MVP; the rest are detected and kept for later. */
export const REGISTRY_ATS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'workday',
  'recruitee',
  'breezy',
  'pinpoint',
  'teamtailor',
  'personio',
  'bamboohr',
  'jazzhr',
  'jsonld',
] as const;
export type RegistryAts = (typeof REGISTRY_ATS)[number];

export const BOARD_STATUSES = ['active', 'disabled', 'needs_refingerprint'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** One row of registry/boards.csv. `wd` is the Workday data-center number (wd1, wd3, wd5, wd12). */
export const BoardRowSchema = z.object({
  company_slug: z.string().regex(SLUG, 'company_slug must be a kebab-case slug'),
  company_name: z.string().trim().min(1),
  domain: z.union([z.literal(''), z.string().regex(DOMAIN, 'domain must be a bare hostname like example.com')]),
  ats: z.enum(REGISTRY_ATS),
  board_key: z.string().trim().min(1),
  careers_url: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
  added_at: z.string().regex(ISO_DATE, 'added_at must be an ISO date (YYYY-MM-DD)'),
  status: z.enum(BOARD_STATUSES),
  wd: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || /^\d{1,3}$/.test(v), 'wd must be a Workday data-center number'),
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

export const BOARDS_CSV_HEADER = [
  'company_slug',
  'company_name',
  'domain',
  'ats',
  'board_key',
  'careers_url',
  'added_at',
  'status',
  'wd',
] as const;

export class RegistryError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`registry has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    this.name = 'RegistryError';
    this.problems = problems;
  }
}

/** Identity of a board inside the registry: the pair an adapter polls. */
export function boardId(row: Pick<BoardRow, 'ats' | 'board_key'>): string {
  return `${row.ats}:${row.board_key}`;
}

/**
 * Parse and validate boards.csv text. Throws `RegistryError` listing every bad line (schema failures,
 * unknown header, duplicate `(ats, board_key)` pairs) instead of stopping at the first.
 */
export function parseBoardsCsv(text: string): BoardRow[] {
  const { header, rows } = parseCsv(text);
  const expected = BOARDS_CSV_HEADER.filter((h) => h !== 'wd');
  const missing = expected.filter((h) => !header.includes(h));
  const unknown = header.filter((h) => !(BOARDS_CSV_HEADER as readonly string[]).includes(h));
  if (missing.length || unknown.length) {
    throw new RegistryError([
      ...missing.map((h) => `header: missing column "${h}"`),
      ...unknown.map((h) => `header: unknown column "${h}"`),
    ]);
  }
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const out: BoardRow[] = [];
  rows.forEach((raw, idx) => {
    const line = idx + 2; // 1-based, after the header
    const parsed = BoardRowSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`line ${line} (${raw['ats'] ?? '?'}:${raw['board_key'] ?? '?'}): ${issue.path.join('.')} ${issue.message}`);
      }
      return;
    }
    const row = parsed.data;
    if (row.ats === 'workday') {
      if (!row.wd) problems.push(`line ${line} (${boardId(row)}): workday rows need wd`);
      if (!/^[^/]+\/[^/]+$/.test(row.board_key)) problems.push(`line ${line} (${boardId(row)}): workday board_key must be tenant/site`);
    }
    const id = boardId(row);
    const prev = seen.get(id);
    if (prev !== undefined) problems.push(`line ${line}: duplicate board ${id} (first seen on line ${prev})`);
    else seen.set(id, line);
    out.push(row);
  });
  if (problems.length) throw new RegistryError(problems);
  return out;
}

/** Load and validate a boards.csv file from disk. */
export async function loadBoards(path: string): Promise<BoardRow[]> {
  return parseBoardsCsv(await readFile(path, 'utf8'));
}

/** Serialize rows in the canonical order (ats, then board_key) with the canonical header. */
export function serializeBoards(rows: readonly BoardRow[]): string {
  const sorted = [...rows].sort((a, b) => a.ats.localeCompare(b.ats) || a.board_key.localeCompare(b.board_key));
  return serializeCsv(BOARDS_CSV_HEADER, sorted);
}

/** Kebab-case company slug: ASCII letters and digits only, diacritics folded, "&" read as "and". */
const NON_DECOMPOSABLE: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ł: 'l', þ: 'th', ð: 'd' };

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßđłþð]/gi, (c) => NON_DECOMPOSABLE[c.toLowerCase()] ?? c)
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length ? slug : 'company';
}

// ---- registry/sources.json -------------------------------------------------------------------

const SourceToggle = z.object({ enabled: z.boolean().default(true) });

export const SourcesConfigSchema = z.object({
  sources: z.partialRecord(z.enum(REGISTRY_ATS), SourceToggle).default({}),
  publish: SourceToggle.default({ enabled: true }),
});
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

/** Parse sources.json text; every source not mentioned defaults to enabled. */
export function parseSourcesConfig(text: string): SourcesConfig {
  return SourcesConfigSchema.parse(JSON.parse(text));
}

export async function loadSourcesConfig(path: string): Promise<SourcesConfig> {
  return parseSourcesConfig(await readFile(path, 'utf8'));
}

export function isSourceEnabled(config: SourcesConfig, ats: RegistryAts): boolean {
  return config.sources[ats]?.enabled ?? true;
}

/** The default sources.json content: everything enabled, listed explicitly so the kill switch is discoverable. */
export function defaultSourcesConfig(): SourcesConfig {
  const sources = Object.fromEntries(REGISTRY_ATS.map((ats) => [ats, { enabled: true }])) as SourcesConfig['sources'];
  return { sources, publish: { enabled: true } };
}
