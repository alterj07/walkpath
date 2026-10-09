import sanitizeHtml from 'sanitize-html';

/**
 * Publish-time sanitization of employer descriptions (plan section 11.2).
 * Nothing from a posting is trusted: only this allowlist survives, no attributes at
 * all, links become their text, and the result is capped at 20 KB. The browser
 * sanitizes the same HTML a second time with DOMPurify before injecting it.
 */

export const ALLOWED_TAGS: readonly string[] = [
  'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

/** Tags whose content is dropped along with the tag. */
const NON_TEXT_TAGS: readonly string[] = [
  'script', 'style', 'iframe', 'svg', 'form', 'input', 'object', 'embed', 'textarea', 'noscript',
  'select', 'button', 'template', 'math', 'video', 'audio', 'canvas',
];

export const DESCRIPTION_MAX_BYTES = 20 * 1024;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: {},
  allowedSchemes: [],
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: [...NON_TEXT_TAGS],
  // Heading levels fold into the two we allow; anchors become plain text (no attributes survive).
  transformTags: {
    h1: 'h3',
    h2: 'h3',
    h5: 'h4',
    h6: 'h4',
  },
  parser: { decodeEntities: true, lowerCaseTags: true },
};

const EMPTY_PARAGRAPH = /<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/g;

function tidy(html: string): string {
  let out = html.replace(EMPTY_PARAGRAPH, '<p></p>');
  out = out.replace(/(?:<p><\/p>\s*){2,}/g, '<p></p>');
  out = out.replace(/^(?:\s*<p><\/p>)+/, '').replace(/(?:<p><\/p>\s*)+$/, '');
  return out.trim();
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Cut at the last tag boundary before the byte cap and re-sanitize so unclosed
 * elements are closed by the parser rather than shipped broken.
 */
function cutAtTagBoundary(html: string, bytes: number): string {
  let cut = Buffer.from(html, 'utf8').subarray(0, bytes).toString('utf8');
  cut = cut.replace(/�+$/, '');
  const lastOpen = cut.lastIndexOf('<');
  const lastClose = cut.lastIndexOf('>');
  if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);
  return cut;
}

function capAtTagBoundary(html: string): string {
  if (byteLength(html) <= DESCRIPTION_MAX_BYTES) return html;
  // Closing tags added by the parser can push the result over the cap; shrink the
  // budget by a fixed step each round so the loop always terminates.
  let budget = DESCRIPTION_MAX_BYTES;
  for (;;) {
    const out = tidy(dropOrphans(sanitizeHtml(cutAtTagBoundary(html, budget), OPTIONS)));
    if (byteLength(out) <= DESCRIPTION_MAX_BYTES) return out;
    budget -= 512;
    if (budget <= 0) return '';
  }
}

/** Remove C0 control characters (except tab, LF, CR) that some ATS payloads carry. */
function stripControls(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return out;
}

const CELL_TAGS = new Set(['td', 'th', 'tr', 'thead', 'tbody']);
const ITEM_TAGS = new Set(['li']);

/**
 * Drop table-cell tags outside a table and list items outside a list, keeping their
 * text. sanitize-html does not enforce nesting, and browsers render orphan cells oddly.
 */
function dropOrphans(html: string): string {
  let tableDepth = 0;
  let listDepth = 0;
  let dropped = false;
  const out = html.replace(/<(\/?)([a-z0-9]+)([^>]*)>/g, (tag, close: string, name: string) => {
    if ((CELL_TAGS.has(name) && tableDepth === 0) || (ITEM_TAGS.has(name) && listDepth === 0)) dropped = true;
    if (name === 'table') {
      tableDepth += close ? -1 : 1;
      if (tableDepth < 0) tableDepth = 0;
      return tag;
    }
    if (name === 'ul' || name === 'ol') {
      listDepth += close ? -1 : 1;
      if (listDepth < 0) listDepth = 0;
      return tag;
    }
    if (CELL_TAGS.has(name) && tableDepth === 0) return close ? ' ' : '';
    if (ITEM_TAGS.has(name) && listDepth === 0) return close ? ' ' : '';
    return tag;
  });
  // Dropped closing tags become spaces; collapse the runs they leave (HTML renders them as one anyway).
  return dropped ? out.replace(/ {2,}/g, ' ') : out;
}

/** Allowlist-sanitize an employer description and cap it at DESCRIPTION_MAX_BYTES. */
export function sanitizeDescription(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  const clean = tidy(dropOrphans(sanitizeHtml(stripControls(html), OPTIONS)));
  return capAtTagBoundary(clean);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntity(m: string): string {
  const known = ENTITIES[m.toLowerCase()];
  if (known !== undefined) return known;
  if (m.startsWith('&#x') || m.startsWith('&#X')) return String.fromCodePoint(parseInt(m.slice(3, -1), 16));
  if (m.startsWith('&#')) return String.fromCodePoint(Number(m.slice(2, -1)));
  return m;
}

/** Plain text of (sanitized or raw) HTML: tags dropped, entities decoded, whitespace collapsed. */
export function htmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, nonTextTags: [...NON_TEXT_TAGS] })
    .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain-text preview of HTML, at most `n` characters (plus an ellipsis when cut). */
export function textPreview(html: string, n: number): string {
  const text = htmlToPlainText(html);
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return (space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}
