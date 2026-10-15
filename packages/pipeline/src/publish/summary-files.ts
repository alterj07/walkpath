import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IsoDateTimeSchema, JobIdSchema } from '../schema/common.ts';
import { JobSummarySchema, type JobRecord, type JobSummary } from '../schema/job.ts';
import { validateSummaryOutput, type SummaryOutput } from '../llm/schema.ts';
import type { Store } from './store.ts';

/**
 * One file per summarized job, written by `scripts/summarize-local.ts` on a separate runner and
 * folded into the shards by the next publish run. The content hash ties the summary to the exact
 * text it was generated from: a record that changed since is summarized again instead.
 */
export const SummaryFileSchema = z.object({
  id: JobIdSchema,
  content_hash: z.string().min(8),
  summary: JobSummarySchema,
  /** Raw model output (validated again on read; it feeds the LLM gate for pending records). */
  output: z.unknown(),
  generated_at: IsoDateTimeSchema,
});
export type SummaryFile = z.infer<typeof SummaryFileSchema>;

export const SUMMARIES_DIR = 'summaries';

export interface ApplySummaryFilesOptions {
  dataDir: string;
  store: Store;
  pending: Store;
  /** The orchestrator's save path (enrich, LLM gate, queue removal). */
  apply: (jobId: string, summary: JobSummary, output: SummaryOutput) => Promise<void>;
  log?: (line: string) => void;
}

export interface ApplySummaryFilesResult {
  files: number;
  applied: number;
  invalid: number;
  hash_mismatch: number;
  missing: number;
}

export async function listSummaryFiles(dataDir: string): Promise<string[]> {
  const dir = join(dataDir, SUMMARIES_DIR);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
  return names
    .filter((n) => /^[0-9a-f]{12}\.json$/.test(n))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Fold `summaries/*.json` into the stores. Every file is removed afterwards, whether it was
 * applied or dropped, so a repeat run is a no-op (idempotent). Nothing about the files is
 * trusted: schema, output validator and content hash all have to agree with the stored record.
 */
export async function applySummaryFiles(opts: ApplySummaryFilesOptions): Promise<ApplySummaryFilesResult> {
  const log = opts.log ?? (() => {});
  const result: ApplySummaryFilesResult = { files: 0, applied: 0, invalid: 0, hash_mismatch: 0, missing: 0 };
  for (const path of await listSummaryFiles(opts.dataDir)) {
    result.files += 1;
    let file: SummaryFile | null = null;
    try {
      const parsed = SummaryFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) file = parsed.data;
    } catch {
      file = null;
    }
    const validated = file ? validateSummaryOutput(file.output) : null;
    if (!file || !validated || !validated.ok) {
      result.invalid += 1;
      await rm(path, { force: true });
      continue;
    }
    const record: JobRecord | null = (await opts.store.get(file.id)) ?? (await opts.pending.get(file.id)) ?? null;
    if (!record) {
      result.missing += 1;
    } else if (record.content_hash !== file.content_hash) {
      result.hash_mismatch += 1;
    } else if (record.summary !== null) {
      // Summarized by another path (the API chain) since the file was written; keep the stored one.
      result.missing += 1;
    } else {
      await opts.apply(file.id, file.summary, validated.value);
      result.applied += 1;
    }
    await rm(path, { force: true });
  }
  if (result.files > 0) {
    log(
      `summaries: files=${result.files} applied=${result.applied} invalid=${result.invalid} hash_mismatch=${result.hash_mismatch} missing=${result.missing}`,
    );
  }
  return result;
}
