/**
 * The board registry (`registry/boards.csv`) and the source kill switches (`registry/sources.json`).
 * Plan sections 6.1, 8.2, 11.4. Rows parse into the core `Board` schema (src/schema/board.ts).
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type Ats, AtsSchema } from '../schema/common.ts';
import { type Board, BoardSchema, boardId } from '../schema/board.ts';
import { parseCsv, serializeCsv } from './csv.ts';

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

/** Company names compared for slug reuse: case, punctuation, whitespace and legal suffixes are ignored. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|company|gmbh|plc|limited|holdings|group)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Parse and validate boards.csv text into core `Board` rows. Throws `RegistryError` listing every
 * bad line (schema failures, unknown header, duplicate `(ats, board_key)` pairs) instead of stopping
 * at the first. Non-fatal findings (a slug shared by rows whose company names differ) are pushed to
 * `warnings` when an array is given.
 */
export function parseBoardsCsv(text: string, warnings?: string[]): Board[] {
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
  const slugOwners = new Map<string, { name: string; line: number }>();
  const out: Board[] = [];
  rows.forEach((raw, idx) => {
    const line = idx + 2; // 1-based, after the header
    const parsed = BoardSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`line ${line} (${raw['ats'] ?? '?'}:${raw['board_key'] ?? '?'}): ${issue.path.join('.')} ${issue.message}`);
      }
      return;
    }
    const row = parsed.data;
    if (row.ats === 'workday' && !/^[^/]+\/[^/]+$/.test(row.board_key)) {
      problems.push(`line ${line} (${boardId(row)}): workday board_key must be tenant/site`);
    }
    const id = boardId(row);
    const prev = seen.get(id);
    if (prev !== undefined) problems.push(`line ${line}: duplicate board ${id} (first seen on line ${prev})`);
    else seen.set(id, line);
    const owner = slugOwners.get(row.company_slug);
    if (!owner) slugOwners.set(row.company_slug, { name: row.company_name, line });
    else if (nameKey(owner.name) !== nameKey(row.company_name)) {
      warnings?.push(`line ${line}: slug "${row.company_slug}" (${row.company_name}) is also used by "${owner.name}" on line ${owner.line}`);
    }
    out.push(row);
  });
  if (problems.length) throw new RegistryError(problems);
  return out;
}

/** Load and validate a boards.csv file from disk. */
export async function loadBoards(path: string, warnings?: string[]): Promise<Board[]> {
  return parseBoardsCsv(await readFile(path, 'utf8'), warnings);
}

/** Serialize rows in the canonical order (ats, then board_key) with the canonical header. */
export function serializeBoards(rows: readonly Board[]): string {
  const sorted = [...rows].sort((a, b) => a.ats.localeCompare(b.ats) || a.board_key.localeCompare(b.board_key));
  return serializeCsv(
    BOARDS_CSV_HEADER,
    sorted.map((r) => ({ ...r, wd: r.wd === undefined ? '' : String(r.wd) })),
  );
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

/**
 * Pick a slug for `name` that no other company already owns. A slug is reusable only by rows whose
 * company name is the same modulo case and punctuation; otherwise `-<ats>`, then `-<ats>-2`, ... is
 * appended. `taken` maps slug → owning company name and is updated in place.
 */
export function uniqueSlug(name: string, ats: Ats, taken: Map<string, string>): string {
  const base = slugify(name);
  const candidates = [base, `${base}-${ats}`];
  for (let n = 2; ; n += 1) {
    for (const slug of candidates) {
      const owner = taken.get(slug);
      if (owner === undefined) {
        taken.set(slug, name);
        return slug;
      }
      if (nameKey(owner) === nameKey(name)) return slug;
    }
    candidates.length = 0;
    candidates.push(`${base}-${ats}-${n}`);
  }
}

// ---- registry/sources.json -------------------------------------------------------------------

const SourceToggle = z.object({ enabled: z.boolean().default(true) });

export const SourcesConfigSchema = z.object({
  sources: z.partialRecord(AtsSchema, SourceToggle).default({}),
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

export function isSourceEnabled(config: SourcesConfig, ats: Ats): boolean {
  return config.sources[ats]?.enabled ?? true;
}

/** The default sources.json content: everything enabled, listed explicitly so the kill switch is discoverable. */
export function defaultSourcesConfig(): SourcesConfig {
  const sources = Object.fromEntries(AtsSchema.options.map((ats) => [ats, { enabled: true }])) as SourcesConfig['sources'];
  return { sources, publish: { enabled: true } };
}
