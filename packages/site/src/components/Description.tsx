/**
 * The one place on the site that injects HTML: the employer's job description,
 * sanitized once at publish time and again here with DOMPurify (plan section
 * 11.2). Everything else on every page renders as text nodes.
 */
import { useMemo } from 'react';
import { sanitizeHtml } from '../lib/sanitize.ts';

export function Description({ html }: { html: string }) {
  const clean = useMemo(() => sanitizeHtml(html), [html]);
  if (!clean) {
    return <p className="muted">The full description could not be displayed. Open the posting on the employer's site.</p>;
  }
  return (
    <div
      className="description"
      // eslint-disable-next-line react/no-danger -- the single documented exception, see docs/security.md
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
