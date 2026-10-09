/**
 * Saved / applied tracker (plan section 2.3). One localStorage map, five
 * stages shown as tabs, export/import as JSON so a student can move between
 * devices. Rows are resolved from the full index; ids no longer listed fall
 * back to their bucket file, then to a bare id.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadIndexFile, relativeTime, type IndexRow } from '../lib/data.ts';
import { loadJob } from '../lib/records.ts';
import {
  NOTE_MAX,
  STAGES,
  clearTracker,
  getTracker,
  removeEntry,
  sanitizeTracker,
  saveTracker,
  setNote,
  setStage,
  type Stage,
  type Tracker,
} from '../lib/tracker.ts';

const STAGE_LABELS: Record<Stage, string> = {
  saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Rejected',
};

interface Resolved {
  title: string;
  company: string;
  location: string;
  posted_at: string | null;
  listed: boolean;
}

/** Merges an imported tracker into the current one; the newer `at` wins per id. */
export function mergeTrackers(current: Tracker, imported: Tracker): { merged: Tracker; added: number; updated: number } {
  const merged: Tracker = { ...current };
  let added = 0;
  let updated = 0;
  for (const [id, entry] of Object.entries(imported)) {
    const prev = merged[id];
    if (!prev) { merged[id] = entry; added += 1; continue; }
    if (Date.parse(entry.at) > Date.parse(prev.at)) {
      // A newer entry without a note must not erase the note written on this device.
      const note = entry.note ?? prev.note;
      merged[id] = note ? { ...entry, note } : { stage: entry.stage, at: entry.at };
      updated += 1;
    }
  }
  return { merged, added, updated };
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SavedPage() {
  const [tracker, setTracker] = useState<Tracker>({});
  const [tab, setTab] = useState<Stage>('saved');
  const [rows, setRows] = useState<Map<string, Resolved>>(new Map());
  const [message, setMessage] = useState<string>('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [now] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTracker(getTracker()); }, []);

  const ids = useMemo(() => Object.keys(tracker), [tracker]);

  // Resolve titles from the full index; fall back to the bucket for ids no longer listed.
  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const resolved = new Map<string, Resolved>();
      let index: IndexRow[] = [];
      try { index = (await loadIndexFile('all')).rows; } catch { /* offline: fall through */ }
      const byId = new Map(index.map((r) => [r.id, r]));
      const missing: string[] = [];
      for (const id of ids) {
        const r = byId.get(id);
        if (r) resolved.set(id, { title: r.title, company: r.company, location: [r.city, r.state].filter(Boolean).join(', ') || 'US', posted_at: r.posted_at, listed: true });
        else missing.push(id);
      }
      await Promise.all(missing.slice(0, 50).map(async (id) => {
        try {
          const job = await loadJob(id);
          if (job) resolved.set(id, { title: job.title, company: job.company.name, location: job.location.raw, posted_at: job.posted_at, listed: job.closed_at === null });
        } catch { /* leave unresolved */ }
      }));
      if (!cancelled) setRows(resolved);
    })();
    return () => { cancelled = true; };
  }, [ids]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    for (const e of Object.values(tracker)) c[e.stage] += 1;
    return c;
  }, [tracker]);

  const visible = useMemo(
    () => Object.entries(tracker).filter(([, e]) => e.stage === tab).sort((a, b) => b[1].at.localeCompare(a[1].at)),
    [tracker, tab],
  );

  const onStage = (id: string, stage: Stage) => setTracker(setStage(id, stage));
  const onNote = (id: string, note: string) => setTracker(setNote(id, note));
  const onRemove = (id: string) => setTracker(removeEntry(id));

  const onExport = () => {
    download('walkpath-tracker.json', JSON.stringify({ version: 1, exported_at: new Date().toISOString(), tracker }, null, 2));
    setMessage(`Exported ${ids.length} entries.`);
  };

  const onImportFile = async (file: File) => {
    if (file.size > 2_000_000) { setMessage('Import failed: file is too large.'); return; }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const payload = typeof parsed === 'object' && parsed !== null && 'tracker' in parsed ? (parsed as { tracker: unknown }).tracker : parsed;
      const imported = sanitizeTracker(payload);
      const rawCount = typeof payload === 'object' && payload !== null ? Object.keys(payload as object).length : 0;
      const dropped = Math.max(0, rawCount - Object.keys(imported).length);
      const { merged, added, updated } = mergeTrackers(getTracker(), imported);
      saveTracker(merged);
      setTracker(getTracker());
      setMessage(`Imported ${added} new and ${updated} updated entries; ${dropped} invalid entries dropped.`);
    } catch {
      setMessage('Import failed: the file is not valid JSON.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onClear = () => {
    clearTracker();
    setTracker({});
    setRows(new Map());
    setConfirmClear(false);
    setMessage('Your saved jobs and notes were removed from this browser.');
  };

  return (
    <div className="saved-page">
      <div className="toolbar">
        <div className="chips" role="tablist" aria-label="Stage">
          {STAGES.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={tab === s} className={tab === s ? 'chip chip-on' : 'chip'} onClick={() => setTab(s)}>
              {STAGE_LABELS[s]} ({counts[s]})
            </button>
          ))}
        </div>
        <div className="chips">
          <button type="button" className="chip" onClick={onExport} disabled={ids.length === 0}>Export JSON</button>
          <button type="button" className="chip" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); }}
          />
          {confirmClear ? (
            <span className="confirm" role="group" aria-label="Confirm clear">
              <span>Remove everything?</span>
              <button type="button" className="chip chip-on" onClick={onClear}>Yes, clear</button>
              <button type="button" className="chip" onClick={() => setConfirmClear(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="chip" onClick={() => setConfirmClear(true)} disabled={ids.length === 0}>Clear my data</button>
          )}
        </div>
      </div>
      {message && <p className="small muted" aria-live="polite">{message}</p>}

      {visible.length === 0 ? (
        <div className="empty">
          <p>Nothing in “{STAGE_LABELS[tab]}” yet. Star a job on the <a href="/">explore table</a> to save it here.</p>
          <p className="small muted">Saved jobs live only in this browser. Use Export to move them to another device.</p>
        </div>
      ) : (
        <ul className="tracker-list">
          {visible.map(([id, entry]) => {
            const r = rows.get(id);
            return (
              <li key={id} className="tracker-row">
                <div className="tracker-main">
                  {r ? (
                    <>
                      <a className="job-link" href={`/job/${id}`}>{r.title}</a>
                      <span className="muted small"> · {r.company} · {r.location}{r.posted_at ? ` · posted ${relativeTime(r.posted_at, now)}` : ''}</span>
                      {!r.listed && <span className="badge badge-closed">no longer listed</span>}
                    </>
                  ) : (
                    <>
                      <a className="job-link" href={`/job/${id}`}>Listing {id}</a>
                      <span className="muted small"> · no longer listed</span>
                    </>
                  )}
                  <span className="muted small"> · {STAGE_LABELS[entry.stage].toLowerCase()} {relativeTime(entry.at, now)}</span>
                </div>
                <div className="tracker-controls">
                  <label className="small">
                    Stage{' '}
                    <select value={entry.stage} onChange={(e) => { const v = e.target.value; if ((STAGES as readonly string[]).includes(v)) onStage(id, v as Stage); }}>
                      {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                    </select>
                  </label>
                  <label className="small note-label">
                    Note{' '}
                    <input
                      type="text"
                      className="note"
                      maxLength={NOTE_MAX}
                      defaultValue={entry.note ?? ''}
                      placeholder="e.g. referred by Sam, OA due Friday"
                      onBlur={(e) => onNote(id, e.target.value)}
                    />
                  </label>
                  <button type="button" className="linkish" onClick={() => onRemove(id)}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
