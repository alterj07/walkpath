/**
 * Company page island (plan section 2.6). Served from /company/index.html for
 * every /company/<slug> path; the slug comes from the URL and is validated
 * before anything is looked up.
 */
import { useEffect, useMemo, useState } from 'react';
import { ATS_LABELS, FAMILY_LABELS, loadIndexFile, relativeTime, type IndexRow } from '../lib/data.ts';
import { SLUG_RE, loadCompanies, type CompanyEntry } from '../lib/records.ts';
import { Avatar } from './Avatar.tsx';

export function slugFromPath(pathname: string): string | null {
  const m = /^\/company\/([a-z0-9-]{1,80})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; company: CompanyEntry; roles: IndexRow[] };

export function CompanyPage() {
  const slug = useMemo(() => (typeof location !== 'undefined' ? slugFromPath(location.pathname) : null), []);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!slug || !SLUG_RE.test(slug)) { setState({ kind: 'missing' }); return; }
    let cancelled = false;
    (async () => {
      const [companies, index] = await Promise.all([
        loadCompanies(),
        loadIndexFile('all').catch(() => ({ generated_at: '', rows: [] as IndexRow[] })),
      ]);
      if (cancelled) return;
      const roles = index.rows
        .filter((r) => r.slug === slug)
        .sort((a, b) => b.posted_at.localeCompare(a.posted_at));
      const company = companies[slug] ?? (roles[0]
        ? { name: roles[0].company, domain: roles[0].domain, blurb: null, ats: [...new Set(roles.map((r) => r.ats))], careers_url: null, open_count: roles.length }
        : null);
      if (!company) { setState({ kind: 'missing' }); return; }
      document.title = `${company.name} internships · WalkPath`;
      setState({ kind: 'ready', company, roles });
    })().catch(() => { if (!cancelled) setState({ kind: 'missing' }); });
    return () => { cancelled = true; };
  }, [slug]);

  if (state.kind === 'loading') return <p className="muted" aria-live="polite">Loading…</p>;
  if (state.kind === 'missing') {
    return (
      <div className="empty">
        <p>No company found at this address.</p>
        <p><a href="/">Back to the explore table</a></p>
      </div>
    );
  }
  const { company, roles } = state;
  // The domain was validated once by parseCompanies / parseJobRecord; only emptiness is checked here.
  const site = company.domain.length >= 3 ? `https://${company.domain}` : null;

  return (
    <article className="company">
      <header className="job-header">
        <div className="job-company">
          <Avatar name={company.name} domain={company.domain} size={48} />
          <div>
            <h1>{company.name}</h1>
            <p className="small muted">
              {site && <a href={site} rel="noopener noreferrer nofollow" target="_blank">{company.domain}</a>}
              {site && company.careers_url && ' · '}
              {company.careers_url && <a href={company.careers_url} rel="noopener noreferrer nofollow" target="_blank">careers site</a>}
              {company.ats.map((a) => <span key={a} className="badge">via {ATS_LABELS[a] ?? a}</span>)}
            </p>
          </div>
        </div>
        {company.blurb && <p>{company.blurb}</p>}
        <p className="count" aria-live="polite">{roles.length} open tech internship{roles.length === 1 ? '' : 's'}</p>
      </header>
      {roles.length === 0 ? (
        <div className="empty"><p>No open tech internships right now. Check the employer's careers site for other roles.</p></div>
      ) : (
        <ul className="similar">
          {roles.map((r) => (
            <li key={r.id}>
              <a className="job-link" href={`/job/${r.id}`}>{r.title}</a>
              <span className="muted small"> · {[r.city, r.state].filter(Boolean).join(', ') || (r.arrangement === 'remote' ? 'Remote (US)' : 'US')} · {FAMILY_LABELS[r.family]}{r.season ? ` · ${r.season}` : ''} · {relativeTime(r.posted_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
