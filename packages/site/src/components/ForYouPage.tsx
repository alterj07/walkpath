/**
 * "For you": every open posting scored deterministically against the visitor's
 * profile (docs/matching.md). Ineligible postings are hidden by default; a toggle
 * reveals them greyed out with the reasons. All strings render as text nodes.
 */
import { useEffect, useMemo, useState } from 'react';
import { ARRANGEMENT_LABELS, FAMILY_LABELS, loadIndexFile, locationLabel, relativeTime, type IndexRow } from '../lib/data.ts';
import { rankJobs, type MatchResult } from '../lib/match.ts';
import { getProfile, hasProfile, type Profile } from '../lib/profile.ts';
import { Avatar } from './Avatar.tsx';

const PAGE = 50;

function windowChip(row: IndexRow): string | null {
  if (row.grad_min === null && row.grad_max === null) return null;
  if (row.grad_min !== null && row.grad_max !== null) return row.grad_min === row.grad_max ? `Grad ${row.grad_min}` : `Grad ${row.grad_min}–${row.grad_max}`;
  if (row.grad_min !== null) return `Grad ${row.grad_min}+`;
  return `Grad by ${row.grad_max}`;
}

function Row({ row, match, now, dim }: { row: IndexRow; match: MatchResult; now: number; dim: boolean }) {
  return (
    <li className={dim ? 'fy-row fy-dim' : 'fy-row'}>
      <div className="fy-main">
        <Avatar name={row.company} domain={row.domain} />
        <div>
          <a className="job-link" href={`/job/${row.id}`}>{row.title}</a>
          <div className="small muted">
            {row.company} · {locationLabel(row)} · {ARRANGEMENT_LABELS[row.arrangement]} · {FAMILY_LABELS[row.family]}
            {row.season ? ` · ${row.season}` : ''} · <time dateTime={row.posted_at}>{relativeTime(row.posted_at, now)}</time>
          </div>
          <div className="chips small">
            <span className="badge">{match.score}/100</span>
            {match.breakdown.matched_skills.slice(0, 6).map((s) => <span key={s} className="skill">{s}</span>)}
            {windowChip(row) && <span className="badge">{windowChip(row)}</span>}
            {row.degree && row.degree !== 'any' && <span className="badge">{row.degree === 'phd' ? 'PhD' : row.degree.replace('_', ' ')}+</span>}
          </div>
          {dim && match.reasons.length > 0 && (
            <ul className="small fy-reasons">{match.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
      </div>
    </li>
  );
}

export function ForYouPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rows, setRows] = useState<IndexRow[] | null>(null);
  const [error, setError] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const p = getProfile();
    setProfile(hasProfile(p) ? p : null);
    loadIndexFile('all')
      .then((f) => setRows(f.rows))
      .catch(() => setError(true));
  }, []);

  const ranked = useMemo(() => (profile && rows ? rankJobs(profile, rows) : []), [profile, rows]);
  const eligible = useMemo(() => ranked.filter((r) => r.match.eligible), [ranked]);
  const hidden = useMemo(() => ranked.filter((r) => !r.match.eligible), [ranked]);

  if (!profile) {
    return (
      <div className="empty">
        <p>No profile yet. Add your graduation year, degree and skills, or let your resume fill them in.</p>
        <p><a className="chip chip-on" href="/profile">Set up your profile</a></p>
      </div>
    );
  }
  if (error) return <p className="error" role="alert">Could not load the listings. Try again in a minute.</p>;
  if (!rows) return <p className="muted" aria-live="polite">Scoring listings…</p>;

  const shown = (showHidden ? ranked : eligible).slice(0, limit);
  const total = showHidden ? ranked.length : eligible.length;

  return (
    <div className="foryou">
      <p className="count" aria-live="polite">
        {eligible.length} of {rows.length} open postings fit your profile
        {hidden.length > 0 && (
          <>
            {' · '}
            <button type="button" className="linkish" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? `Hide ${hidden.length} that don’t fit` : `Show ${hidden.length} hidden (why)`}
            </button>
          </>
        )}
        {' · '}<a href="/profile">Edit profile</a>
      </p>
      <p className="small muted">Scored from skills, role family and location; postings whose graduation window, degree level, citizenship, sponsorship or enrollment rules exclude you are hidden. Read each posting before applying.</p>
      {shown.length === 0 ? (
        <div className="empty"><p>Nothing fits yet. Loosen your profile or check back after the next hourly update.</p></div>
      ) : (
        <ul className="fy-list">
          {shown.map(({ job, match }) => <Row key={job.id} row={job} match={match} now={now} dim={!match.eligible} />)}
        </ul>
      )}
      {total > limit && (
        <p><button type="button" className="chip" onClick={() => setLimit((l) => l + PAGE)}>Load more ({total - limit} remaining)</button></p>
      )}
    </div>
  );
}
