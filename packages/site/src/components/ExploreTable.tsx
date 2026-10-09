/**
 * The explore table (plan sections 2.1, 5.2, 5.3, 5.4). A React island over the
 * pre-built index files: filters are predicates over rows, keyword search runs
 * in MiniSearch, the URL query string is the state, and saved jobs live in
 * localStorage. Every string from the data files is rendered as a text node.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
// TanStack Table adds ~15 KB gzipped for the column model alone; kept because the
// job/company pages will reuse the same column definitions.
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import MiniSearch from 'minisearch';
import {
  ARRANGEMENTS,
  ARRANGEMENT_LABELS,
  ATS_LABELS,
  FAMILIES,
  FAMILY_LABELS,
  US_STATES,
  WINDOWS,
  absoluteTime,
  indexFileFor,
  loadIndexFile,
  locationLabel,
  logoUrl,
  relativeTime,
  windowStartMs,
} from '../lib/data.ts';
import type { Arrangement, Family, IndexFileName, IndexRow, TimeWindow } from '../lib/data.ts';
import { DEFAULT_FILTERS, filtersToSearch, parseFilters } from '../lib/url-state.ts';
import type { ExploreFilters } from '../lib/url-state.ts';
import { getLastVisit, getTracker, removeEntry, setStage, touchLastVisit } from '../lib/tracker.ts';
import type { Tracker } from '../lib/tracker.ts';

const PAGE_SIZE = 50;
const WINDOW_LABELS: Record<TimeWindow, string> = {
  '1h': 'Last hour', '6h': '6 h', '24h': '24 h', '3d': '3 d', '7d': '7 d', '30d': '30 d',
};
const FILE_RANK: Record<IndexFileName, number> = { latest: 0, '7d': 1, all: 2 };
const URL_DEBOUNCE_MS = 200;

/** Current time (epoch ms), ticked once a minute while the tab is visible. */
const NowContext = createContext<number>(0);

function RelTime({ iso, firstSeen }: { iso: string; firstSeen: string }) {
  const now = useContext(NowContext);
  const absolute = `Posted ${absoluteTime(iso)}, first seen by us ${absoluteTime(firstSeen)}`;
  return (
    <time dateTime={iso} title={absolute}>
      {relativeTime(iso, now)}
      <span className="visually-hidden">. {absolute}</span>
    </time>
  );
}

function Avatar({ company, domain }: { company: string; domain: string }) {
  const url = logoUrl(domain);
  const [broken, setBroken] = useState(false);
  const letter = (company.trim()[0] ?? '?').toUpperCase();
  if (url && !broken) {
    return <img className="avatar" src={url} alt="" width={28} height={28} loading="lazy" onError={() => setBroken(true)} />;
  }
  return <span className="avatar avatar-letter" aria-hidden="true">{letter}</span>;
}

function Chips<T extends string>({
  options, value, onChange, labels, name, single,
}: {
  options: readonly T[]; value: T[]; onChange: (next: T[]) => void; labels: Record<T, string>; name: string; single?: boolean;
}) {
  return (
    <div className="chips" role="group" aria-label={name}>
      {options.map((opt) => {
        const on = value.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            className={on ? 'chip chip-on' : 'chip'}
            aria-pressed={on}
            onClick={() => {
              if (single) onChange([opt]);
              else onChange(on ? value.filter((v) => v !== opt) : [...value, opt]);
            }}
          >
            {labels[opt]}
          </button>
        );
      })}
    </div>
  );
}

function CheckList({
  title, options, value, onChange, labels,
}: {
  title: string; options: string[]; value: string[]; onChange: (next: string[]) => void; labels?: Record<string, string>;
}) {
  return (
    <details className="filter-dd">
      <summary>{title}{value.length ? ` (${value.length})` : ''}</summary>
      <div className="filter-dd-body">
        {options.length === 0 && <span className="muted">None in this window</span>}
        {options.map((opt) => (
          <label key={opt} className="check">
            <input
              type="checkbox"
              checked={value.includes(opt)}
              onChange={(e) => onChange(e.target.checked ? [...value, opt] : value.filter((v) => v !== opt))}
            />
            {labels?.[opt] ?? opt}
          </label>
        ))}
        {value.length > 0 && (
          <button type="button" className="linkish" onClick={() => onChange([])}>Clear</button>
        )}
      </div>
    </details>
  );
}

const col = createColumnHelper<IndexRow>();

export default function ExploreTable() {
  const [filters, setFilters] = useState<ExploreFilters>(DEFAULT_FILTERS);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<Partial<Record<IndexFileName, IndexRow[]>>>({});
  const [loading, setLoading] = useState<IndexFileName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracker, setTracker] = useState<Tracker>({});
  const [lastVisit, setLastVisit] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef<Set<IndexFileName>>(new Set());
  const urlTimer = useRef<number | null>(null);

  // Restore state from the URL and the browser once, then watch back/forward.
  useEffect(() => {
    const read = () => setFilters(parseFilters(new URLSearchParams(window.location.search)));
    read();
    setTracker(getTracker());
    setLastVisit(getLastVisit());
    touchLastVisit();
    setReady(true);
    window.addEventListener('popstate', read);
    // Relative times only need refreshing while someone is looking.
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('popstate', read);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(tick);
      if (urlTimer.current !== null) window.clearTimeout(urlTimer.current);
    };
  }, []);

  const needed = indexFileFor(filters.window);

  // Load the smallest file that covers the window; keep every loaded file.
  useEffect(() => {
    if (!ready || files[needed] || inflight.current.has(needed)) return;
    inflight.current.add(needed);
    setLoading(needed);
    setError(null);
    loadIndexFile(needed)
      .then((f) => setFiles((prev) => ({ ...prev, [needed]: f.rows })))
      .catch(() => setError('Could not load the job index. Try again in a minute.'))
      .finally(() => {
        inflight.current.delete(needed);
        setLoading((l) => (l === needed ? null : l));
      });
  }, [ready, needed, files]);

  // React state updates immediately; the URL write is debounced so typing in
  // the search box does not hammer history.replaceState.
  const update = useCallback((patch: Partial<ExploreFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch, page: patch.page ?? 1 };
      if (typeof window !== 'undefined') {
        if (urlTimer.current !== null) window.clearTimeout(urlTimer.current);
        const search = filtersToSearch(next);
        urlTimer.current = window.setTimeout(() => {
          urlTimer.current = null;
          try {
            window.history.replaceState(null, '', `${window.location.pathname}${search}`);
          } catch {
            // Some embedded browsers throw on rapid history writes; the view is already updated.
          }
        }, URL_DEBOUNCE_MS);
      }
      return next;
    });
  }, []);

  // Use the widest loaded file that covers the window, so widening then
  // narrowing never refetches.
  const rows = useMemo(() => {
    const candidates = (Object.keys(files) as IndexFileName[]).filter((f) => FILE_RANK[f] >= FILE_RANK[needed]);
    candidates.sort((a, b) => FILE_RANK[a] - FILE_RANK[b]);
    const pick = candidates[0];
    return pick ? files[pick] ?? [] : [];
  }, [files, needed]);

  const search = useMemo(() => {
    const ms = new MiniSearch<IndexRow>({
      fields: ['title', 'company', 'city'],
      storeFields: [],
      idField: 'id',
      searchOptions: {
        // Short terms are exact so "C" or "ML" do not prefix-match everything;
        // fuzziness only kicks in on longer words where typos are likely.
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
        boost: { company: 2 },
        combineWith: 'AND',
      },
    });
    ms.addAll(rows);
    return ms;
  }, [rows]);

  const stateOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.state).filter((s): s is string => !!s && s in US_STATES))).sort(),
    [rows],
  );
  const seasonOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.season).filter((s): s is string => !!s))).sort(),
    [rows],
  );
  const companyOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.company))).sort((a, b) => a.localeCompare(b)).slice(0, 2000),
    [rows],
  );

  const visible = useMemo(() => {
    const start = windowStartMs(filters.window, now);
    const q = filters.q.trim();
    const hits = q ? new Set(search.search(q).map((h) => String(h.id))) : null;
    const company = filters.company.toLowerCase();
    const out = rows.filter((r) => {
      if (Date.parse(r.posted_at) < start) return false;
      if (filters.family.length && !filters.family.includes(r.family)) return false;
      if (filters.state.length && (!r.state || !filters.state.includes(r.state))) return false;
      if (filters.arr.length && !filters.arr.includes(r.arrangement)) return false;
      if (filters.season.length && (!r.season || !filters.season.includes(r.season))) return false;
      if (filters.nocit && r.citizenship_required === true) return false;
      if (company && !r.company.toLowerCase().includes(company)) return false;
      if (hits && !hits.has(r.id)) return false;
      return true;
    });
    out.sort((a, b) => {
      const p = Date.parse(b.posted_at) - Date.parse(a.posted_at);
      return p !== 0 ? p : Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at);
    });
    return out;
  }, [rows, filters, now, search]);

  const shown = useMemo(() => visible.slice(0, filters.page * PAGE_SIZE), [visible, filters.page]);

  const toggleSave = useCallback((id: string) => {
    setTracker((t) => (t[id] ? removeEntry(id) : setStage(id, 'saved')));
  }, []);

  const columns = useMemo(
    () => [
      col.accessor('title', {
        header: 'Internship',
        cell: (info) => {
          const r = info.row.original;
          const isNew = lastVisit !== null && Date.parse(r.first_seen_at) > lastVisit;
          return (
            <div className="cell-title">
              <Avatar company={r.company} domain={r.domain} />
              <div>
                <a className="job-link" href={`/job/${r.id}`}>
                  {isNew && <span className="dot" title="New since your last visit" />}
                  {r.title}
                </a>
                <div className="muted small">
                  {r.company}
                  {r.season ? ` · ${r.season}` : ''}
                  {r.has_salary ? ' · pay listed' : ''}
                  {r.citizenship_required ? ' · citizenship required' : ''}
                </div>
              </div>
            </div>
          );
        },
      }),
      col.accessor('city', {
        header: 'Location',
        cell: (info) => {
          const r = info.row.original;
          return (
            <span>
              {locationLabel(r)}
              {r.others > 0 ? <span className="muted small"> +{r.others} more</span> : null}
              {r.arrangement === 'remote' ? <span className="badge">Remote</span> : null}
              {r.arrangement === 'hybrid' ? <span className="badge">Hybrid</span> : null}
            </span>
          );
        },
      }),
      col.accessor('posted_at', {
        header: 'Posted',
        cell: (info) => {
          const r = info.row.original;
          return <RelTime iso={r.posted_at} firstSeen={r.first_seen_at} />;
        },
      }),
      col.accessor('ats', {
        header: 'Source',
        cell: (info) => <span className="muted small">via {ATS_LABELS[info.getValue()] ?? info.getValue()}</span>,
      }),
      col.display({
        id: 'save',
        header: 'Save',
        cell: (info) => {
          const id = info.row.original.id;
          const saved = Boolean(tracker[id]);
          return (
            <button
              type="button"
              className={saved ? 'star star-on' : 'star'}
              aria-pressed={saved}
              aria-label={saved ? 'Remove from saved' : 'Save this internship'}
              onClick={() => toggleSave(id)}
            >
              {saved ? '★' : '☆'}
            </button>
          );
        },
      }),
    ],
    [lastVisit, tracker, toggleSave],
  );

  const companyDatalist = useMemo(
    () => (
      <datalist id="company-options">
        {companyOptions.map((c) => <option key={c} value={c} />)}
      </datalist>
    ),
    [companyOptions],
  );

  const table = useReactTable({ data: shown, columns, getCoreRowModel: getCoreRowModel() });

  const isLoading = loading !== null && !files[needed];

  return (
    <NowContext.Provider value={now}>
    <section className="explore">
      <div className="toolbar">
        <Chips<TimeWindow>
          name="Posted within"
          options={WINDOWS}
          value={[filters.window]}
          labels={WINDOW_LABELS}
          single
          onChange={(v) => update({ window: v[0] ?? '24h' })}
        />
        <input
          type="search"
          className="search"
          placeholder="Search title, company, city"
          aria-label="Keyword search"
          value={filters.q}
          maxLength={100}
          onChange={(e) => update({ q: e.target.value })}
        />
      </div>

      <Chips<Family> name="Role family" options={FAMILIES} value={filters.family} labels={FAMILY_LABELS} onChange={(v) => update({ family: v })} />

      <div className="filters">
        <CheckList title="State" options={stateOptions} value={filters.state} labels={US_STATES} onChange={(v) => update({ state: v })} />
        <CheckList title="Season" options={seasonOptions} value={filters.season} onChange={(v) => update({ season: v })} />
        <details className="filter-dd">
          <summary>Work arrangement{filters.arr.length ? ` (${filters.arr.length})` : ''}</summary>
          <div className="filter-dd-body">
            <Chips<Arrangement> name="Work arrangement" options={ARRANGEMENTS} value={filters.arr} labels={ARRANGEMENT_LABELS} onChange={(v) => update({ arr: v })} />
          </div>
        </details>
        <label className="check">
          <input type="checkbox" checked={filters.nocit} onChange={(e) => update({ nocit: e.target.checked })} />
          No citizenship requirement
        </label>
        <input
          className="company"
          list="company-options"
          placeholder="Company"
          aria-label="Company"
          value={filters.company}
          maxLength={100}
          onChange={(e) => update({ company: e.target.value })}
        />
        {companyDatalist}
        <button type="button" className="linkish" onClick={() => update({ ...DEFAULT_FILTERS, window: filters.window })}>
          Reset filters
        </button>
      </div>

      <p className="muted small count" aria-live="polite">
        {isLoading ? 'Loading…' : `${visible.length} internship${visible.length === 1 ? '' : 's'}`}
        {loading && files[needed] ? ' · loading wider window…' : ''}
      </p>

      {error && <p className="error" role="alert">{error}</p>}

      {!isLoading && !error && visible.length === 0 && (
        <div className="empty">
          <p>No internships match in this window.</p>
          {filters.window !== '30d' && (
            <button type="button" className="chip" onClick={() => update({ window: '7d' })}>Widen to 7 days</button>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="jobs">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} scope="col" className={`col-${h.id}`}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={`col-${cell.column.id}`}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown.length < visible.length && (
        <div className="more">
          <button type="button" className="chip" onClick={() => update({ page: filters.page + 1 })}>
            Load more ({visible.length - shown.length} remaining)
          </button>
        </div>
      )}
    </section>
    </NowContext.Provider>
  );
}
