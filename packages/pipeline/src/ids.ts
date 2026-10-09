import { createHash } from 'node:crypto';
import type { Ats } from './schema/common.ts';

/**
 * `ats:board_key:external_id`, the unique key of a job within its source.
 * board_key may itself contain ':' (Lever EU boards are `eu:<site>`); never split a key
 * on ':', use the stored columns.
 */
export function canonicalKey(ats: Ats, boardKey: string, externalId: string): string {
  return `${ats}:${boardKey}:${externalId}`;
}

/** 12 lowercase hex chars of SHA-256 over the canonical key; used in URLs and shard buckets. */
export function jobIdFromKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

export interface ContentHashFields {
  title: string;
  locations?: readonly string[] | null;
  department?: string | null;
  employmentType?: string | null;
  remoteFlag?: boolean | null;
  applyUrl?: string | null;
  postedAt?: string | null;
  description?: string | null;
}

const HASH_FIELD_ORDER = [
  'title',
  'locations',
  'department',
  'employmentType',
  'remoteFlag',
  'applyUrl',
  'postedAt',
  'description',
] as const;

/**
 * 16-byte (32 hex) SHA-256 prefix over the fields that mean "this posting changed".
 * Field order is fixed and nulls/undefined hash identically, so the hash is stable
 * across adapters and across runs.
 */
export function contentHash(fields: ContentHashFields): string {
  const hash = createHash('sha256');
  for (const name of HASH_FIELD_ORDER) {
    const value = fields[name];
    hash.update(name);
    hash.update('\u0000');
    if (value === undefined || value === null) {
      hash.update('');
    } else if (Array.isArray(value)) {
      hash.update(value.map((v) => String(v).trim()).join('\u0001'));
    } else {
      hash.update(String(value).trim());
    }
    hash.update('\u0002');
  }
  return hash.digest('hex').slice(0, 32);
}
