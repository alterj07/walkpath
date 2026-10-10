/**
 * Cross-device sync of the two localStorage documents (tracker and profile) through one
 * Firestore document per user, `users/{uid}`, whose fields are keyed by the storage key.
 *
 * localStorage stays the source of truth on each device; sync merges both sides with
 * "newest wins" per entry and writes the result back to both. Everything read from Firestore is
 * untrusted and goes through the same validators as an imported file.
 *
 * Writes happen on sign-in and, afterwards, 1 s after any `walkpath:changed` event that the
 * storage modules dispatch after they write.
 */
import { TRACKER_KEY, type Tracker, getTracker, sanitizeTracker, saveTracker } from './tracker.ts';

export const PROFILE_KEY = 'walkpath:profile';
export const SYNCED_KEYS = [TRACKER_KEY, PROFILE_KEY] as const;
export const CHANGED_EVENT = 'walkpath:changed';
export const SYNC_DEBOUNCE_MS = 1000;
const PROFILE_MAX_BYTES = 64 * 1024;

export type SyncedDoc = Partial<Record<(typeof SYNCED_KEYS)[number], unknown>>;

/** Same rule as the Saved page import: a newer entry wins but never erases a local note. */
export function mergeTrackers(local: Tracker, remote: Tracker): Tracker {
  const merged: Tracker = { ...local };
  for (const [id, entry] of Object.entries(remote)) {
    const prev = merged[id];
    if (!prev) {
      merged[id] = entry;
      continue;
    }
    if (Date.parse(entry.at) > Date.parse(prev.at)) {
      const note = entry.note ?? prev.note;
      merged[id] = note ? { ...entry, note } : { stage: entry.stage, at: entry.at };
    }
  }
  return merged;
}

/**
 * The profile module (owned by another engineer) validates its own shape on read; here it is
 * treated as an opaque object with an `updated_at` ISO string. Anything else is dropped.
 */
export function sanitizeProfileLike(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.updated_at !== 'string' || Number.isNaN(Date.parse(o.updated_at))) return null;
  if (Object.prototype.hasOwnProperty.call(o, '__proto__')) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(o);
  } catch {
    return null;
  }
  if (serialized.length > PROFILE_MAX_BYTES) return null;
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function mergeProfiles(
  local: Record<string, unknown> | null,
  remote: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!local) return remote;
  if (!remote) return local;
  return Date.parse(String(remote.updated_at)) > Date.parse(String(local.updated_at)) ? remote : local;
}

function readLocal(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the in-memory result is still used for the remote write
  }
}

/** Pure merge of the local documents with a (validated) remote document. */
export function mergeDocs(remote: SyncedDoc | null): SyncedDoc {
  const localTracker = getTracker();
  const remoteTracker = sanitizeTracker(remote?.[TRACKER_KEY]);
  const tracker = mergeTrackers(localTracker, remoteTracker);

  const localProfile = sanitizeProfileLike(readLocal(PROFILE_KEY));
  const remoteProfile = sanitizeProfileLike(remote?.[PROFILE_KEY]);
  const profile = mergeProfiles(localProfile, remoteProfile);

  const out: SyncedDoc = { [TRACKER_KEY]: tracker };
  if (profile) out[PROFILE_KEY] = profile;
  return out;
}

/** Applies a merged document to localStorage. */
export function applyLocal(doc: SyncedDoc): void {
  saveTracker(sanitizeTracker(doc[TRACKER_KEY]));
  const profile = sanitizeProfileLike(doc[PROFILE_KEY]);
  if (profile) writeLocal(PROFILE_KEY, profile);
}

export interface RemoteStore {
  read(uid: string): Promise<SyncedDoc | null>;
  write(uid: string, doc: SyncedDoc): Promise<void>;
}

/** Firestore-backed store; only loaded when an account is in use. */
export async function firestoreStore(): Promise<RemoteStore> {
  const { getFirebase } = await import('./firebase.ts');
  const { db } = await getFirebase();
  const { doc, getDoc, setDoc } = await import('firebase/firestore');
  return {
    async read(uid) {
      const snap = await getDoc(doc(db, 'users', uid));
      if (!snap.exists()) return null;
      const data = snap.data() as Record<string, unknown>;
      const out: SyncedDoc = {};
      for (const key of SYNCED_KEYS) if (key in data) out[key] = data[key];
      return out;
    },
    async write(uid, body) {
      const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const key of SYNCED_KEYS) if (body[key] !== undefined) payload[key] = body[key];
      await setDoc(doc(db, 'users', uid), payload, { merge: true });
    },
  };
}

/** Full two-way sync: read remote, merge with local, write both. Returns the merged document. */
export async function syncNow(uid: string, store: RemoteStore): Promise<SyncedDoc> {
  const remote = await store.read(uid);
  const merged = mergeDocs(remote);
  applyLocal(merged);
  await store.write(uid, merged);
  return merged;
}

/**
 * Keeps the remote document updated after local changes. Returns a stop function. The storage
 * modules dispatch `walkpath:changed` after each write; writes are debounced.
 */
export function watchChanges(uid: string, store: RemoteStore, onError: (e: unknown) => void = () => {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      store.write(uid, mergeDocs(null)).catch(onError);
    }, SYNC_DEBOUNCE_MS);
  };
  globalThis.addEventListener?.(CHANGED_EVENT, handler);
  return () => {
    globalThis.removeEventListener?.(CHANGED_EVENT, handler);
    if (timer) clearTimeout(timer);
  };
}

/** Called by the storage modules after a successful write. */
export function notifyChanged(): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(CHANGED_EVENT));
  } catch {
    // no DOM (tests, build)
  }
}
