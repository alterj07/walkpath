/**
 * Job detail island (plan section 2.2). Served from /job/index.html for every
 * /job/<id> path (SPA fallback in public/_redirects); the id comes from the
 * URL. Everything rendered here is a text node except the twice-sanitized
 * description inside <Description>.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ARRANGEMENT_LABELS,
  ATS_LABELS,
  FAMILY_LABELS,
  absoluteTime,
  loadIndexFile,
  relativeTime,
  type IndexRow,
} from '../lib/data.ts';
import {
  applyHostLabel,
  loadCompanies,
  loadJob,
  postedLabel,
  reportUrl,
  salaryLabel,
  type Companies,
  type JobRecord,
} from '../lib/records.ts';
import { getTracker, setStage, removeEntry, type Stage } from '../lib/tracker.ts';
import { Avatar } from './Avatar.tsx';
import { Description } from './Description.tsx';

export const SAFETY_LINE = 'Legitimate employers never ask for payment, bank details, or your SSN before an offer.';

export function idFromPath(pathname: string): string | null {
  const m = /^\/job\/([a-f0-9]{12})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; job: JobRecord };

function locationText(job: JobRecord): string {
  const parts = [job.location.city, job.location.state].filter((p): p is string => !!p);
  if (parts.length) return parts.join(', ');
  return job.location.raw || (job.location.arrangement === 'remote' ? 'Remote (US)' : 'United States');
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </>
  );
}

function Skills({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <p>
      <strong>{title}: </strong>
      {items.map((s, i) => <span key={i} className="skill">{s}</span>)}
    </p>
  );
}

function ApplyBlock({ job, companies, onApplied }: { job: JobRecord; companies: Companies; onApplied: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const yesRef = useRef<HTMLButtonElement>(null);
  // Move focus to the confirm so keyboard and screen-reader users land on it.
  useEffect(() => { if (confirming) yesRef.current?.focus(); }, [confirming]);
  const company = companies[job.company.slug];
  const careers = company?.careers_url ?? null;
  const closed = job.closed_at !== null;

  // Only an https URL ever becomes a link; the publish job guarantees it, this re-checks.
  const href = /^https:\/\//i.test(job.apply_url) ? job.apply_url : '';
  const host = applyHostLabel(href);
  const useCareers = (!href || job.apply_url_downgraded) && careers && /^https:\/\//i.test(careers);
  const target = useCareers ? careers : href;
  const targetHost = useCareers ? applyHostLabel(careers) : host;

  if (!target) {
    return <p className="muted">No apply link is available for this listing. Search the employer's careers site for the title above.</p>;
  }

  return (
    <div className="apply-block">
      <a
        className="apply"
        href={target}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={() => { if (!closed) setConfirming(true); }}
      >
        {useCareers ? "Apply on the company's careers page" : closed ? 'View posting (applications closed)' : 'Apply on company site'}
      </a>
      <p className="small muted apply-note">
        You are leaving for {targetHost || 'the employer’s site'}. {SAFETY_LINE}
      </p>
      {confirming && (
        <div className="confirm" role="group" aria-label="Mark as applied">
          <span>Did you apply? Mark it in your tracker.</span>
          <button ref={yesRef} type="button" className="chip chip-on" onClick={() => { onApplied(); setConfirming(false); }}>Yes, applied</button>
          <button type="button" className="chip" onClick={() => setConfirming(false)}>Not yet</button>
        </div>
      )}
    </div>
  );
}

export function JobPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [companies, setCompanies] = useState<Companies>({});
  const [similar, setSimilar] = useState<IndexRow[]>([]);
  const [stage, setStageState] = useState<Stage | null>(null);
  const [now] = useState(() => Date.now());
  const id = useMemo(() => (typeof location !== 'undefined' ? idFromPath(location.pathname) : null), []);

  useEffect(() => {
    if (!id) { setState({ kind: 'missing' }); return; }
    let cancelled = false;
    loadJob(id)
      .then((job) => {
        if (cancelled) return;
        if (!job) { setState({ kind: 'missing' }); return; }
        setState({ kind: 'ready', job });
        document.title = `${job.title} at ${job.company.name} · WalkPath`;
      })
      .catch(() => { if (!cancelled) setState({ kind: 'missing' }); });
    loadCompanies().then((c) => { if (!cancelled) setCompanies(c); }).catch(() => {});
    setStageState(getTracker()[id]?.stage ?? null);
    return () => { cancelled = true; };
  }, [id]);

  const job = state.kind === 'ready' ? state.job : null;

  // Similar internships: same family + same state, newest 5, from the full index (lazy).
  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    loadIndexFile('all')
      .then((file) => {
        if (cancelled) return;
        const rows = file.rows
          .filter((r) => r.id !== job.id && r.family === job.role_family && (job.location.state ? r.state === job.location.state : true))
          .sort((a, b) => b.posted_at.localeCompare(a.posted_at) || b.first_seen_at.localeCompare(a.first_seen_at))
          .slice(0, 5);
        setSimilar(rows);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [job]);

  if (state.kind === 'loading') return <p className="muted" aria-live="polite">Loading…</p>;
  if (state.kind === 'missing' || !job) {
    return (
      <div className="empty">
        <p>This listing is not available. It may have closed and been removed, or the link is wrong.</p>
        <p><a href="/">Back to the explore table</a></p>
      </div>
    );
  }

  const saved = stage !== null;
  const toggleSave = () => {
    if (saved) { removeEntry(job.id); setStageState(null); }
    else { setStage(job.id, 'saved'); setStageState('saved'); }
  };
  const markApplied = () => { setStage(job.id, 'applied'); setStageState('applied'); };
  const closed = job.closed_at !== null;
  const salary = salaryLabel(job.salary);
  const company = companies[job.company.slug];

  return (
    <article className="job">
      <header className="job-header">
        <div className="job-company">
          <Avatar name={job.company.name} domain={job.company.domain} size={40} />
          <div>
            <a href={`/company/${job.company.slug}`}>{job.company.name}</a>
            {company?.careers_url && (
              <>
                {' · '}
                <a href={company.careers_url} rel="noopener noreferrer nofollow" target="_blank" className="small">careers site</a>
              </>
            )}
          </div>
        </div>
        <h1>{job.title}</h1>
        <p className="job-meta">
          <span>{locationText(job)}</span>
          {job.location.others.length > 0 && <span> · +{job.location.others.length} more location{job.location.others.length === 1 ? '' : 's'}</span>}
          <span> · {ARRANGEMENT_LABELS[job.location.arrangement]}</span>
          <span> · {FAMILY_LABELS[job.role_family]}</span>
          <span> · {job.employment_type === 'co_op' ? 'Co-op' : 'Internship'}</span>
          {job.season && <span> · {job.season}</span>}
          {salary && <span> · {salary}</span>}
        </p>
        <p className="job-meta small muted">
          <span title={absoluteTime(job.posted_at)}>{postedLabel(job, now)}</span>
          <span> · First seen by us {relativeTime(job.first_seen_at, now)} ({absoluteTime(job.first_seen_at)})</span>
          <span className="badge">via {ATS_LABELS[job.source.ats] ?? job.source.ats}</span>
          {closed
            ? <span className="badge badge-closed">Applications closed {job.closed_at ? relativeTime(job.closed_at, now) : ''}</span>
            : <span className="badge badge-open">Open</span>}
        </p>
        {job.location.others.length > 0 && (
          <p className="small muted">Also listed in: {job.location.others.join('; ')}</p>
        )}
        <div className="job-actions">
          <ApplyBlock job={job} companies={companies} onApplied={markApplied} />
          <button type="button" className={saved ? 'star star-on' : 'star'} aria-pressed={saved} aria-label={saved ? 'Remove from saved' : 'Save this job'} onClick={toggleSave}>
            {saved ? '★' : '☆'} <span className="small">{stage ? `In tracker: ${stage}` : 'Save'}</span>
          </button>
        </div>
      </header>

      <section className="summary" aria-labelledby="summary-h">
        <h2 id="summary-h">Smart summary</h2>
        <p className="small muted">AI summary, may be imperfect; read the posting.</p>
        {job.summary ? (
          <>
            <p>{job.summary.text}</p>
            <SummaryList title="Responsibilities" items={job.summary.responsibilities} />
            <SummaryList title="Qualifications" items={job.summary.qualifications} />
            <Skills title="Must-have skills" items={job.summary.must_have_skills} />
            <Skills title="Nice to have" items={job.summary.nice_to_have_skills} />
            <p className="small muted">Generated by {job.summary.model} at {absoluteTime(job.summary.generated_at)}.</p>
          </>
        ) : (
          <p className="muted">Summary pending. It is generated within a few hours of the posting appearing.</p>
        )}
        <p className="flags">
          {job.citizenship_required === true && <span className="badge badge-warn">US citizenship or clearance required</span>}
          {job.citizenship_required === false && <span className="badge">No citizenship requirement found</span>}
          {job.sponsorship === 'no' && <span className="badge badge-warn">No visa sponsorship</span>}
          {job.sponsorship === 'yes' && <span className="badge">Sponsorship available</span>}
          {job.grad_years.length > 0 && <span className="badge">Graduating {job.grad_years.join(', ')}</span>}
        </p>
      </section>

      <section aria-labelledby="desc-h">
        <h2 id="desc-h">Job description</h2>
        <p className="small muted">From the employer's posting via {ATS_LABELS[job.source.ats] ?? job.source.ats}. Links inside it are shown as text; use the Apply button above.</p>
        <Description html={job.description_html} />
      </section>

      {similar.length > 0 && (
        <section aria-labelledby="similar-h">
          <h2 id="similar-h">Similar internships</h2>
          <ul className="similar">
            {similar.map((r) => (
              <li key={r.id}>
                <a className="job-link" href={`/job/${r.id}`}>{r.title}</a>
                <span className="muted small"> · {r.company} · {[r.city, r.state].filter(Boolean).join(', ') || 'US'} · {relativeTime(r.posted_at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="job-footer small muted">
        <a href={reportUrl(job.id)} rel="noopener noreferrer" target="_blank">Report this listing</a>
        {' · '}
        <span>Listing id {job.id}</span>
      </footer>
    </article>
  );
}
