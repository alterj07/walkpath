/**
 * Public transparency page (plan section 2.7), rendered from /data/meta.json.
 * It doubles as the impersonation guard (plan 11.8): it names the canonical
 * site URL and the source repository.
 */
import { useEffect, useState } from 'react';
import { ATS_LABELS, absoluteTime, loadMeta, relativeTime, type Meta } from '../lib/data.ts';
import { GITHUB_REPO } from '../lib/records.ts';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; meta: Meta };

function num(n: number | null, unit = ''): string {
  return n === null ? 'n/a' : `${Math.round(n)}${unit}`;
}

export function StatusPage({ siteUrl }: { siteUrl: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    loadMeta()
      .then((meta) => { if (!cancelled) setState(meta ? { kind: 'ready', meta } : { kind: 'missing' }); })
      .catch(() => { if (!cancelled) setState({ kind: 'missing' }); });
    return () => { cancelled = true; };
  }, []);

  if (state.kind === 'loading') return <p className="muted" aria-live="polite">Loading…</p>;
  if (state.kind === 'missing') return <p className="error">Status data is unavailable right now.</p>;
  const { meta } = state;
  const ats = Object.keys(meta.boards).sort();
  const llm = Object.keys(meta.llm).sort();
  const stale = now - Date.parse(meta.last_run_at) > 90 * 60_000;

  return (
    <div className="status">
      <p className={stale ? 'callout' : undefined}>
        <strong>Last run:</strong> {relativeTime(meta.last_run_at, now)} ({absoluteTime(meta.last_run_at)}), run id <code>{meta.run_id}</code>.
        {stale && ' This is more than 90 minutes ago; the hourly run may be delayed.'}
      </p>
      <p className="small muted">
        Scheduled start {absoluteTime(meta.schedule.started_at)}
        {meta.schedule.lateness_min !== null ? `, ${num(meta.schedule.lateness_min, ' min')} after the top-of-hour target` : ' (manual run)'}.
      </p>

      <h2>Jobs</h2>
      <dl className="status-stats">
        <div><dt>Open internships</dt><dd>{meta.jobs.open}</dd></div>
        <div><dt>New this run</dt><dd>{meta.jobs.new}</dd></div>
        <div><dt>Closed this run</dt><dd>{meta.jobs.closed}</dd></div>
        <div><dt>Discovery latency (median)</dt><dd>{num(meta.latency.median_min, ' min')}</dd></div>
        <div><dt>Discovery latency (p90)</dt><dd>{num(meta.latency.p90_min, ' min')}</dd></div>
        <div><dt>Summaries pending</dt><dd>{meta.pending_summaries}</dd></div>
        <div><dt>Held for review</dt><dd>{meta.held_for_review}</dd></div>
      </dl>
      <p className="small muted">Discovery latency is the time between the employer's publish timestamp and our first sighting, over jobs found this run whose job board reports a publish time.</p>

      <h2>Boards polled</h2>
      {ats.length === 0 ? <p className="muted">No board data in this run.</p> : (
        <div className="table-wrap">
          <table className="jobs">
            <thead><tr><th scope="col">Source</th><th scope="col">Polled</th><th scope="col">OK</th><th scope="col">Failed</th></tr></thead>
            <tbody>
              {ats.map((a) => {
                const b = meta.boards[a]!;
                return <tr key={a}><td>{ATS_LABELS[a] ?? a}</td><td>{b.polled}</td><td>{b.ok}</td><td>{b.failed}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Summarizer usage today</h2>
      {llm.length === 0 ? <p className="muted">No summaries generated today.</p> : (
        <div className="table-wrap">
          <table className="jobs">
            <thead><tr><th scope="col">Provider</th><th scope="col">Requests</th><th scope="col">Tokens</th></tr></thead>
            <tbody>
              {llm.map((p) => {
                const u = meta.llm[p]!;
                return <tr key={p}><td>{p}</td><td>{u.requests}</td><td>{u.tokens.toLocaleString('en-US')}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>How this works</h2>
      <p>
        Once an hour a GitHub Actions workflow polls the public job-board endpoints of each registered
        employer, diffs the result against what it has already seen, runs the internship and tech-role
        gates, summarizes new postings with a free-tier language model, and publishes the JSON files this
        site reads. The run log is public.
      </p>
      <p className="small muted">
        The only genuine address for this site is <a href={siteUrl}>{siteUrl}</a>; its source is at <a href={GITHUB_REPO} rel="noopener noreferrer">{GITHUB_REPO}</a>.
        WalkPath never emails students and never asks for personal information.
      </p>
    </div>
  );
}
