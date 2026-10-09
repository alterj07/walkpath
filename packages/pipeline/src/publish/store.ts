import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRecord } from '../schema/job.ts';
import { BucketFileSchema, bucketOf, type BucketFile } from './formats.ts';

/**
 * The published record store: `jobs/<xx>.json` bucket files under a data directory
 * (plan 5.1, 6.3). Buckets are loaded lazily, written only when they changed, with
 * sorted keys and 2-space JSON so the data-branch diffs stay small. The same class
 * serves the `pending/` store that holds records waiting on the LLM gate.
 */
export class Store {
  readonly dir: string;
  private readonly buckets = new Map<string, Map<string, JobRecord>>();
  private readonly dirty = new Set<string>();
  private loadedAll = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private bucketPath(bucket: string): string {
    return join(this.dir, `${bucket}.json`);
  }

  private async loadBucket(bucket: string): Promise<Map<string, JobRecord>> {
    const cached = this.buckets.get(bucket);
    if (cached) return cached;
    const map = new Map<string, JobRecord>();
    let text: string | null = null;
    try {
      text = await readFile(this.bucketPath(bucket), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      const parsed = BucketFileSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new Error(`store: invalid bucket ${bucket}: ${parsed.error.issues[0]?.message ?? 'schema'}`);
      }
      for (const [id, record] of Object.entries(parsed.data)) map.set(id, record);
    }
    this.buckets.set(bucket, map);
    return map;
  }

  /** Load every bucket file present on disk (once). */
  async loadAll(): Promise<void> {
    if (this.loadedAll) return;
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const name of names) {
      const m = name.match(/^([0-9a-f]{2})\.json$/);
      if (m && m[1]) await this.loadBucket(m[1]);
    }
    this.loadedAll = true;
  }

  async get(id: string): Promise<JobRecord | null> {
    const map = await this.loadBucket(bucketOf(id));
    return map.get(id) ?? null;
  }

  async put(record: JobRecord): Promise<void> {
    const bucket = bucketOf(record.id);
    const map = await this.loadBucket(bucket);
    map.set(record.id, record);
    this.dirty.add(bucket);
  }

  async delete(id: string): Promise<boolean> {
    const bucket = bucketOf(id);
    const map = await this.loadBucket(bucket);
    const existed = map.delete(id);
    if (existed) this.dirty.add(bucket);
    return existed;
  }

  /** Every record in the store (loads all buckets). */
  async all(): Promise<JobRecord[]> {
    await this.loadAll();
    const out: JobRecord[] = [];
    for (const map of this.buckets.values()) out.push(...map.values());
    return out;
  }

  /** Drop records closed before `closedBeforeIso` (30-day retention, plan 6.4). Returns the count. */
  async removeClosedBefore(closedBeforeIso: string): Promise<number> {
    await this.loadAll();
    let removed = 0;
    for (const [bucket, map] of this.buckets) {
      for (const [id, record] of map) {
        if (record.closed_at !== null && record.closed_at < closedBeforeIso) {
          map.delete(id);
          this.dirty.add(bucket);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** Write only the buckets that changed; empty buckets are deleted. Returns the bucket names written. */
  async writeChanged(): Promise<string[]> {
    const written: string[] = [];
    if (this.dirty.size === 0) return written;
    await mkdir(this.dir, { recursive: true });
    for (const bucket of [...this.dirty].sort()) {
      const map = this.buckets.get(bucket);
      const path = this.bucketPath(bucket);
      if (!map || map.size === 0) {
        await rm(path, { force: true });
      } else {
        const file: BucketFile = {};
        for (const id of [...map.keys()].sort()) file[id] = map.get(id) as JobRecord;
        await writeFile(path, JSON.stringify(file, null, 2) + '\n');
      }
      written.push(bucket);
    }
    this.dirty.clear();
    return written;
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }
}

export function openStore(dir: string): Store {
  return new Store(dir);
}
