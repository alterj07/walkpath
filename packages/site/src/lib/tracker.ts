/**
 * Saved / applied state lives only in the visitor's browser (plan section
 * 2.3). localStorage can be missing, full or blocked, so every access is
 * wrapped and the page must work without it. Values read back are validated:
 * ids must be 12 hex chars, stages come from the enum, notes are capped, and
 * anything else is dropped (plan section 11.6).
 */

export const STAGES = ['saved', 'applied', 'interviewing', 'offer', 'rejected'] as const;
export type Stage = (typeof STAGES)[number];

export interface TrackerEntry {
  stage: Stage;
  at: string;
  note?: string;
}
export type Tracker = Record<string, TrackerEntry>;

export const TRACKER_KEY = 'walkpath:tracker';
export const LAST_VISIT_KEY = 'walkpath:lastVisit';
export const NOTE_MAX = 500;
const ID_RE = /^[a-f0-9]{12}$/;
const MAX_ENTRIES = 5000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Drops C0 control characters except tab, newline and carriage return. */
function stripControl(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue;
    out += ch;
  }
  return out;
}

export function isStage(v: unknown): v is Stage {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v);
}

/** Validates an untrusted object (storage or an imported file) into a Tracker. */
export function sanitizeTracker(v: unknown): Tracker {
  const out: Tracker = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  let n = 0;
  for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_ENTRIES) break;
    if (!ID_RE.test(id)) continue;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!isStage(e.stage)) continue;
    const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : null;
    if (!at) continue;
    const clean: TrackerEntry = { stage: e.stage, at };
    if (typeof e.note === 'string' && e.note.trim()) clean.note = stripControl(e.note).slice(0, NOTE_MAX);
    out[id] = clean;
    n += 1;
  }
  return out;
}

export function getTracker(): Tracker {
  const raw = readRaw(TRACKER_KEY);
  if (!raw) return {};
  try {
    return sanitizeTracker(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveTracker(t: Tracker): boolean {
  const ok = writeRaw(TRACKER_KEY, JSON.stringify(sanitizeTracker(t)));
  // Lets the optional account sync (src/lib/sync.ts) push the change; harmless without a DOM.
  try {
    if (ok) globalThis.dispatchEvent?.(new CustomEvent('walkpath:changed'));
  } catch {
    // no event target available
  }
  return ok;
}

export function setStage(id: string, stage: Stage, now: Date = new Date()): Tracker {
  const t = getTracker();
  if (!ID_RE.test(id) || !isStage(stage)) return t;
  const prev = t[id];
  t[id] = { stage, at: now.toISOString(), ...(prev?.note ? { note: prev.note } : {}) };
  saveTracker(t);
  return t;
}

export function setNote(id: string, note: string): Tracker {
  const t = getTracker();
  const entry = t[id];
  if (!entry) return t;
  const clean = stripControl(note).slice(0, NOTE_MAX).trim();
  if (clean) entry.note = clean;
  else delete entry.note;
  saveTracker(t);
  return t;
}

export function removeEntry(id: string): Tracker {
  const t = getTracker();
  delete t[id];
  saveTracker(t);
  return t;
}

export function clearTracker(): void {
  try {
    const s = storage();
    s?.removeItem(TRACKER_KEY);
    s?.removeItem(LAST_VISIT_KEY);
  } catch {
    // nothing to clear
  }
}

/** Last visit as epoch ms, or null on first visit / blocked storage. */
export function getLastVisit(): number | null {
  const raw = readRaw(LAST_VISIT_KEY);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function touchLastVisit(now: Date = new Date()): void {
  writeRaw(LAST_VISIT_KEY, now.toISOString());
}
