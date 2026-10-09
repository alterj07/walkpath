import type { JobEvent } from '../crawl/diff.ts';
import { internshipGate } from '../gates/internship.ts';
import { techGate } from '../gates/tech.ts';
import { jobIdFromKey } from '../ids.ts';
import { parseArrangement, parseGradYears, parseSalary, parseSeason, parseWorkAuth } from '../normalize/fields.ts';
import { groupKey } from '../normalize/group.ts';
import { parseLocation } from '../normalize/location.ts';
import { normalizeTitle } from '../normalize/title.ts';
import type { Board } from '../schema/board.ts';
import type { RoleFamily } from '../schema/common.ts';
import type { JobRecord } from '../schema/job.ts';
import type { Gate, StateDb } from '../state/db.ts';
import { resolveApplyUrl } from './apply-url.ts';
import { htmlToPlainText, sanitizeDescription } from './sanitize.ts';
import { scamSignals } from './scam.ts';
import type { Store } from './store.ts';

/**
 * Turns crawl events into published records (plan 4.5 gate order, 4.6 layer 3 fan-out,
 * 4.7 closures, 11.2/11.3 publish-time controls). Rules decide what they can; titles the
 * rules call ambiguous wait in the pending store for the LLM gate (`applyLlmGate`).
 */

export interface HeldEntry {
  id: string;
  signals: string[];
  held_at: string;
}

/** grouped.json entry: a folded multi-location sibling → its canonical record and the location it contributed. */
export interface GroupedEntry {
  canonical: string;
  location: string;
}

/**
 * Open canonical records keyed by title group (plan 4.6 layer 3), built once per publish run
 * from `store.all()`. That call loads every bucket (roughly 1 KB per open record, so tens of MB
 * at 30k open jobs), which is why the index is built once and shared across artifacts.
 */
export type GroupIndex = Map<string, JobRecord>;

export async function buildGroupIndex(store: Store): Promise<GroupIndex> {
  const index: GroupIndex = new Map();
  for (const existing of await store.all()) {
    if (existing.closed_at !== null) continue;
    const key = titleGroupKey(existing.title_raw, existing.source.ats, existing.source.board);
    const prev = index.get(key);
    if (!prev || existing.posted_at < prev.posted_at) index.set(key, existing);
  }
  return index;
}

export interface MergeOptions {
  events: readonly JobEvent[];
  closedKeys: readonly string[];
  reopenedKeys: readonly string[];
  boardsById: ReadonlyMap<string, Board>;
  now: Date;
  db: StateDb;
  store: Store;
  pending: Store;
  held: HeldEntry[];
  /** Mutated in place: folded sibling id → canonical id + location. */
  grouped: Record<string, GroupedEntry>;
  /** Mutated in place as records are published. */
  groups: GroupIndex;
  log?: (message: string) => void;
}

export interface MergeResult {
  /** Records newly visible on the site this run (new, or changed into eligibility). */
  published: JobRecord[];
  /** Of `published`, the ones that are genuinely new (not reposts) and may be alerted. */
  alertable: JobRecord[];
  updated: number;
  /** Job ids placed in the pending store and queued for the LLM gate. */
  ambiguous: string[];
  queuedForSummary: string[];
  closed: number;
  reopened: number;
  counts: {
    events: number;
    not_intern: number;
    not_tech: number;
    non_us: number;
    held: number;
    unknown_board: number;
    grouped: number;
    /** Events skipped because the LLM already rejected the job and its content has not changed. */
    skipped_llm_negative: number;
  };
  unparsedLocations: string[];
}

interface GateOutcome {
  gate: Gate;
  employment_type: 'internship' | 'co_op';
  family: RoleFamily | null;
}

/** Combine the two rule gates (plan 4.5): a hard negative on either side wins; else both must be positive. */
export function combinedGate(title: string, employmentType: string | null | undefined, department: string | null | undefined): GateOutcome {
  const intern = internshipGate({ title, employmentType });
  const tech = techGate(title, department);
  if (intern.verdict === 'not_intern') return { gate: 'not_intern', employment_type: intern.employment_type, family: tech.family };
  if (tech.verdict === 'not_tech') return { gate: 'not_tech', employment_type: intern.employment_type, family: null };
  if (intern.verdict === 'intern' && tech.verdict === 'tech' && tech.family) {
    return { gate: 'tech_intern', employment_type: intern.employment_type, family: tech.family };
  }
  return { gate: 'ambiguous', employment_type: intern.employment_type, family: tech.family };
}

/** Build the published record for an event (plan 6.3). `family` must be known. */
export function buildRecord(event: JobEvent, board: Board, family: RoleFamily, employmentType: 'internship' | 'co_op', now: Date): {
  record: JobRecord;
  country: 'US' | 'other' | null;
  locationMatched: boolean;
} {
  const input = event.input;
  const { title, title_raw } = normalizeTitle(input.title);
  const locations = [...new Set(input.locations.map((l) => l.trim()).filter((l) => l.length > 0))];
  const first = locations[0] ?? '';
  const loc = parseLocation(first);
  const others = locations.slice(1).filter((l) => l !== first);
  const arrangement = parseArrangement({
    remoteFlag: input.remoteFlag,
    title: input.title,
    locations,
    description: input.descriptionHtml,
  });
  const resolved = resolveApplyUrl({
    applyUrl: input.applyUrl,
    hostedUrl: input.hostedUrl,
    ats: event.ats,
    companyDomain: board.domain,
    careersUrl: board.careers_url,
  });
  const descriptionHtml = sanitizeDescription(input.descriptionHtml);
  const descriptionText = htmlToPlainText(descriptionHtml);
  const auth = parseWorkAuth(descriptionText);
  const record: JobRecord = {
    id: event.job_id,
    title,
    title_raw,
    company: { slug: board.company_slug, name: board.company_name, domain: board.domain },
    location: {
      raw: first,
      city: loc.city,
      state: loc.state,
      country: loc.country,
      arrangement: loc.remote && arrangement === 'unknown' ? 'remote' : arrangement,
      others,
    },
    source: { ats: event.ats, board: event.board_key, external_id: input.externalId },
    apply_url: resolved.apply_url,
    apply_url_downgraded: resolved.apply_url_downgraded,
    posted_at: event.posted_at,
    posted_at_source: event.posted_at_source,
    first_seen_at: event.first_seen_at,
    last_seen_at: now.toISOString(),
    closed_at: null,
    employment_type: employmentType,
    role_family: family,
    season: parseSeason(input.title, descriptionText),
    salary: parseSalary({ structured: input.salary, description: descriptionText, title: input.title }),
    citizenship_required: auth.citizenship_required,
    sponsorship: auth.sponsorship,
    grad_years: parseGradYears(descriptionText),
    summary: null,
    description_html: descriptionHtml,
    content_hash: event.content_hash,
  };
  return { record, country: loc.country, locationMatched: loc.matched || first === '' || loc.remote };
}

function titleGroupKey(title: string, ats: string, boardKey: string): string {
  return groupKey({ title, boardId: `${ats}:${boardKey}` });
}

/** Apply one artifact's events and closures to the stores. */
export async function applyEvents(opts: MergeOptions): Promise<MergeResult> {
  const log = opts.log ?? (() => {});
  const nowIso = opts.now.toISOString();
  const result: MergeResult = {
    published: [],
    alertable: [],
    updated: 0,
    ambiguous: [],
    queuedForSummary: [],
    closed: 0,
    reopened: 0,
    counts: { events: opts.events.length, not_intern: 0, not_tech: 0, non_us: 0, held: 0, unknown_board: 0, grouped: 0, skipped_llm_negative: 0 },
    unparsedLocations: [],
  };
  const heldIds = new Set(opts.held.map((h) => h.id));
  const groupCanonical = opts.groups;
  const grouped = opts.grouped;

  // Process events oldest-posted first so the earliest posting becomes the group canonical.
  const ordered = [...opts.events].sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.job_id.localeCompare(b.job_id));
  const gateRows: Array<{ event: JobEvent; gate: Gate }> = [];

  for (const event of ordered) {
    const board = opts.boardsById.get(event.board_id);
    if (!board) {
      result.counts.unknown_board += 1;
      continue;
    }
    // An LLM verdict is final for that content: the same posting is not re-summarized unless it changed.
    const prior = opts.db.getJob(event.canonical_key);
    if (
      prior &&
      prior.gate_source === 'llm' &&
      (prior.gate === 'not_tech' || prior.gate === 'not_intern') &&
      prior.content_hash === event.content_hash
    ) {
      result.counts.skipped_llm_negative += 1;
      continue;
    }
    const outcome = combinedGate(event.input.title, event.input.employmentType, event.input.department);
    gateRows.push({ event, gate: outcome.gate });
    if (outcome.gate === 'not_intern') {
      result.counts.not_intern += 1;
      await dropEverywhere(event.job_id, opts);
      continue;
    }
    if (outcome.gate === 'not_tech') {
      result.counts.not_tech += 1;
      await dropEverywhere(event.job_id, opts);
      continue;
    }
    // Ambiguous titles still need a family for the record shape; use the rule family or a placeholder
    // that the LLM gate overwrites before the record ever reaches the public store.
    const family = outcome.family ?? 'software_engineering';
    const built = buildRecord(event, board, family, outcome.employment_type, opts.now);
    if (built.country === 'other') {
      result.counts.non_us += 1;
      await dropEverywhere(event.job_id, opts);
      continue;
    }
    if (!built.locationMatched && built.record.location.raw) result.unparsedLocations.push(built.record.location.raw);

    const scam = scamSignals({
      title: built.record.title_raw,
      descriptionText: htmlToPlainText(built.record.description_html),
      companyKnown: true,
    });
    if (scam.held) {
      result.counts.held += 1;
      if (!heldIds.has(event.job_id)) {
        opts.held.push({ id: event.job_id, signals: scam.signals, held_at: nowIso });
        heldIds.add(event.job_id);
      }
      await dropEverywhere(event.job_id, opts);
      continue;
    }

    const existing = await opts.store.get(event.job_id);
    if (existing) {
      // Changed (or reposted) job already on the site: refresh fields, keep its summary and first_seen_at.
      const merged: JobRecord = {
        ...built.record,
        first_seen_at: existing.first_seen_at,
        posted_at: event.posted_at < existing.posted_at ? event.posted_at : existing.posted_at,
        summary: existing.summary,
        closed_at: null,
        location: { ...built.record.location, others: unionOthers(existing.location.others, built.record.location.others) },
        role_family: outcome.gate === 'tech_intern' ? family : existing.role_family,
        // Fields the rules could not determine keep the values the LLM summary filled in earlier.
        season: built.record.season ?? existing.season,
        grad_years: built.record.grad_years.length > 0 ? built.record.grad_years : existing.grad_years,
        citizenship_required: built.record.citizenship_required ?? existing.citizenship_required,
        sponsorship: built.record.sponsorship === 'unknown' ? existing.sponsorship : built.record.sponsorship,
      };
      await opts.store.put(merged);
      result.updated += 1;
      if (merged.summary === null) {
        opts.db.enqueueSummary(merged.id, nowIso);
        result.queuedForSummary.push(merged.id);
      }
      continue;
    }

    // Multi-location fan-out: fold into an open canonical record with the same title on the same board.
    const gkey = titleGroupKey(built.record.title_raw, event.ats, event.board_key);
    const canonical = groupCanonical.get(gkey);
    if (canonical && canonical.id !== event.job_id) {
      const loc = built.record.location.raw;
      if (loc && loc !== canonical.location.raw && !canonical.location.others.includes(loc)) {
        canonical.location.others = [...canonical.location.others, loc];
        await opts.store.put(canonical);
      }
      grouped[event.job_id] = { canonical: canonical.id, location: loc };
      result.counts.grouped += 1;
      await opts.pending.delete(event.job_id);
      continue;
    }

    if (outcome.gate === 'ambiguous') {
      const pendingExisting = await opts.pending.get(event.job_id);
      const pendingRecord: JobRecord = pendingExisting
        ? { ...built.record, first_seen_at: pendingExisting.first_seen_at, summary: pendingExisting.summary }
        : built.record;
      await opts.pending.put(pendingRecord);
      result.ambiguous.push(event.job_id);
      if (pendingRecord.summary === null) {
        opts.db.enqueueSummary(event.job_id, nowIso);
        result.queuedForSummary.push(event.job_id);
      }
      continue;
    }

    await opts.pending.delete(event.job_id);
    await opts.store.put(built.record);
    groupCanonical.set(gkey, built.record);
    result.published.push(built.record);
    if (event.kind === 'new') result.alertable.push(built.record);
    opts.db.enqueueSummary(built.record.id, nowIso);
    result.queuedForSummary.push(built.record.id);
  }

  // Gate verdicts live in the publish state DB (jobs_seen rows keyed by canonical key).
  opts.db.upsertJobs(
    gateRows.map(({ event, gate }) => ({
      canonical_key: event.canonical_key,
      job_id: event.job_id,
      internal_req_id: event.internal_req_id,
      content_hash: event.content_hash,
      posted_at: event.posted_at,
      posted_at_source: event.posted_at_source,
      first_seen_at: event.first_seen_at,
      last_seen_at: nowIso,
      closed_at: null,
      gate,
      gate_source: 'rule',
      board_id: event.board_id,
      title: null,
      apply_url: null,
    })),
  );

  // Closures and reopenings (plan 4.7): job ids derive from canonical keys, so no lookup is needed.
  const closingIds = new Set(opts.closedKeys.map((k) => jobIdFromKey(k)));
  const isOpen = (id: string): boolean => {
    if (closingIds.has(id)) return false;
    const row = opts.db.getJobById(id);
    return row !== null && row.closed_at === null;
  };
  for (const key of opts.closedKeys) {
    const id = jobIdFromKey(key);
    const folded = grouped[id];
    if (folded) {
      // A folded sibling closed: its location leaves the canonical record. When the canonical's
      // own posting is already closed and no other sibling is open, the record closes with it.
      delete grouped[id];
      const canonical = await opts.store.get(folded.canonical);
      if (canonical && canonical.closed_at === null) {
        const othersOpen = Object.entries(grouped).some(([sid, g]) => g.canonical === canonical.id && isOpen(sid));
        if (!othersOpen && !isOpen(canonical.id)) {
          await opts.store.put({ ...canonical, closed_at: nowIso });
          result.closed += 1;
        } else {
          await opts.store.put(withoutLocation(canonical, folded.location));
        }
      }
      continue;
    }
    const record = await opts.store.get(id);
    if (record && record.closed_at === null) {
      const siblings = Object.entries(grouped).filter(([, g]) => g.canonical === id);
      const openSiblings = siblings.filter(([sid]) => isOpen(sid));
      if (openSiblings.length > 0) {
        // The canonical posting closed but other locations of the requisition are still open:
        // keep the record, drop the closed location and promote the first open sibling's.
        let next = withoutLocation(record, record.location.raw);
        for (const [sid, g] of siblings) {
          if (!isOpen(sid)) {
            next = withoutLocation(next, g.location);
            delete grouped[sid];
          }
        }
        await opts.store.put(next);
        continue;
      }
      await opts.store.put({ ...record, closed_at: nowIso });
      result.closed += 1;
      for (const [sid] of siblings) delete grouped[sid];
    }
    if (await opts.pending.delete(id)) opts.db.removeSummary(id);
  }
  opts.db.markClosed([...opts.closedKeys], nowIso);
  for (const key of opts.reopenedKeys) {
    const id = jobIdFromKey(key);
    const record = await opts.store.get(id);
    if (record && record.closed_at !== null) {
      await opts.store.put({ ...record, closed_at: null, last_seen_at: nowIso });
      result.reopened += 1;
    }
  }
  opts.db.reopen([...opts.reopenedKeys], nowIso);

  log(
    `merge: events=${result.counts.events} published=${result.published.length} updated=${result.updated} ambiguous=${result.ambiguous.length} ` +
      `not_intern=${result.counts.not_intern} not_tech=${result.counts.not_tech} non_us=${result.counts.non_us} held=${result.counts.held} ` +
      `grouped=${result.counts.grouped} closed=${result.closed} reopened=${result.reopened}`,
  );
  return result;
}

function unionOthers(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Remove one location from a record; when it was the primary, the first remaining one takes its place. */
export function withoutLocation(record: JobRecord, location: string): JobRecord {
  if (record.location.raw === location) {
    const [next, ...rest] = record.location.others;
    if (next === undefined) return record;
    const loc = parseLocation(next);
    return {
      ...record,
      location: { ...record.location, raw: next, city: loc.city, state: loc.state, country: loc.country, others: rest },
    };
  }
  return { ...record, location: { ...record.location, others: record.location.others.filter((l) => l !== location) } };
}

/** A job that no longer qualifies leaves both stores and the summary queue. */
async function dropEverywhere(id: string, opts: MergeOptions): Promise<void> {
  const inStore = await opts.store.delete(id);
  const inPending = await opts.pending.delete(id);
  if (inStore || inPending) opts.db.removeSummary(id);
}

export interface LlmGateInput {
  is_internship: boolean;
  role_family: RoleFamily | 'not_tech';
  confidence: number;
}

export const LLM_GATE_MIN_CONFIDENCE = 0.7;

/**
 * Decide a pending record from the LLM's structured output (plan 4.5): publish when the model is
 * confident it is a tech internship, drop when it is confident it is not, else keep waiting
 * (the next summary attempt, if any, decides).
 */
export function llmGateVerdict(output: LlmGateInput): 'publish' | 'drop' | 'wait' {
  if (output.confidence < LLM_GATE_MIN_CONFIDENCE) return 'wait';
  if (output.is_internship && output.role_family !== 'not_tech') return 'publish';
  return 'drop';
}
