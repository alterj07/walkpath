/**
 * Second sanitization pass, in the browser, before a job description is
 * injected (plan section 11.2). The publish job already sanitized the HTML
 * with the same allowlist; two independent passes mean a bug in one is not a
 * hole. DOMPurify needs a DOM, so on the server (or if it is unavailable) the
 * result is '' and nothing is rendered.
 */
import DOMPurify, { type Config } from 'dompurify';

export const ALLOWED_TAGS = [
  'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
] as const;

export const FORBID_TAGS = [
  'a', 'img', 'svg', 'style', 'script', 'iframe', 'form', 'input', 'object', 'embed',
  'math', 'video', 'audio', 'template', 'textarea', 'select', 'button', 'noscript',
] as const;

/** DOMPurify configuration. Exported so tests can pin it. */
export const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [] as string[],
  FORBID_TAGS: [...FORBID_TAGS],
  FORBID_ATTR: ['style', 'href', 'src', 'srcset', 'action', 'formaction', 'xlink:href'],
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  SAFE_FOR_TEMPLATES: true,
  RETURN_TRUSTED_TYPE: false,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  WHOLE_DOCUMENT: false,
  USE_PROFILES: { html: true },
};

/** The sanitized output is capped so a huge description cannot stall the page. */
export const SANITIZED_MAX_CHARS = 64 * 1024;

/** The slice of DOMPurify we rely on; tests pass a fake, the page passes the real module. */
export interface Purifier {
  readonly isSupported: boolean;
  sanitize?: (html: string, config: Config) => unknown;
}

export function purifierAvailable(purifier: Purifier = DOMPurify): boolean {
  try {
    return typeof window !== 'undefined' && purifier.isSupported === true && typeof purifier.sanitize === 'function';
  } catch {
    return false;
  }
}

/** Returns allowlisted markup only, or '' when sanitization cannot run. */
export function sanitizeHtml(html: string, purifier: Purifier = DOMPurify): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (!purifierAvailable(purifier)) return '';
  const input = html.length > SANITIZED_MAX_CHARS ? html.slice(0, SANITIZED_MAX_CHARS) : html;
  try {
    const out = purifier.sanitize!(input, PURIFY_CONFIG);
    // Belt and braces: the purifier must still report support after the call and hand back a string.
    if (purifier.isSupported !== true || typeof out !== 'string') return '';
    return out;
  } catch {
    return '';
  }
}
