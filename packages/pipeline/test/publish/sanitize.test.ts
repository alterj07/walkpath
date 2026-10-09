import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TAGS,
  DESCRIPTION_MAX_BYTES,
  htmlToPlainText,
  sanitizeDescription,
  textPreview,
} from '../../src/publish/sanitize.ts';

const malicious = readFileSync(fileURLToPath(new URL('../fixtures/malicious/description.html', import.meta.url)), 'utf8');

function tagNames(html: string): Set<string> {
  const names = new Set<string>();
  for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi)) names.add(m[1]!.toLowerCase());
  return names;
}

describe('sanitizeDescription', () => {
  const out = sanitizeDescription(malicious);

  it('keeps only the allowlisted tags and nothing else', () => {
    const seen = tagNames(out);
    for (const t of seen) expect(ALLOWED_TAGS).toContain(t);
    for (const bad of ['script', 'img', 'a', 'iframe', 'svg', 'form', 'input', 'button', 'object', 'embed', 'textarea', 'noscript', 'style', 'div', 'math', 'h1', 'h2', 'h5', 'h6', 'span']) {
      expect(seen.has(bad)).toBe(false);
    }
  });

  it('strips every attribute', () => {
    expect(out).not.toMatch(/<[a-z0-9]+\s+[a-z-]+=/i);
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onload');
    expect(out).not.toContain('style=');
  });

  it('drops the content of script, style, iframe, svg, form, textarea and noscript', () => {
    expect(out).not.toContain("alert('xss')");
    expect(out).not.toContain('display:none');
    expect(out).not.toContain('hidden');
    expect(out).not.toContain('no js');
    expect(out).not.toContain('Send');
    expect(out).not.toContain('evil.example');
  });

  it('unwraps anchors to their text and drops javascript:/data: destinations', () => {
    expect(out).toContain('click');
    expect(out).toContain('this link');
    expect(out).toContain('data link');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('href');
  });

  it('keeps entity-encoded script as literal text', () => {
    expect(out).toContain('&lt;script&gt;alert(5)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('folds headings into h3/h4 and keeps lists and tables', () => {
    expect(out).toContain('<h3>Flight Software Intern</h3>');
    expect(out).toContain('<h3>About the role</h3>');
    expect(out).toContain('<h4>Benefits</h4>');
    expect(out).toContain('<h4>More</h4>');
    expect(out).toContain('<ul><li>C++</li><li>Python</li></ul>');
    expect(out).toContain('<table><thead><tr><th>Skill</th></tr></thead><tbody><tr><td>Rust</td></tr></tbody></table>');
    expect(out).toContain('<strong>flight software</strong>');
    expect(out).toContain('<b>bold</b> <i>italic</i><br />line');
  });

  it('keeps text from disallowed-but-textual wrappers like div', () => {
    expect(out).toContain('nested text survives');
  });

  it('collapses runs of empty paragraphs', () => {
    expect(out).not.toMatch(/<p><\/p>\s*<p><\/p>/);
  });

  it('strips C0 control characters', () => {
    expect(sanitizeDescription('<p>\u0000nul\u0007bell\ttab</p>')).toBe('<p>nulbell\ttab</p>');
  });

  it('drops table cells outside a table and list items outside a list, keeping text', () => {
    expect(sanitizeDescription('<td>cell</td><tr><th>head</th></tr> <li>item</li>')).toBe('cell head item');
    expect(sanitizeDescription('<table><tr><td>in</td></tr></table><li>out</li><ul><li>in</li></ul>')).toBe(
      '<table><tr><td>in</td></tr></table>out <ul><li>in</li></ul>',
    );
  });

  it('returns empty for empty or non-string input', () => {
    expect(sanitizeDescription('')).toBe('');
    expect(sanitizeDescription(undefined as unknown as string)).toBe('');
  });

  it('caps at 20 KB on a tag boundary and stays well-formed', () => {
    const para = '<p>' + 'word '.repeat(50) + '<strong>bold</strong></p>';
    const big = para.repeat(600); // ~160 KB
    const capped = sanitizeDescription(big);
    const bytes = Buffer.byteLength(capped, 'utf8');
    expect(bytes).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(bytes).toBeGreaterThan(DESCRIPTION_MAX_BYTES - 1024);
    const opens = (capped.match(/<p>/g) ?? []).length;
    const closes = (capped.match(/<\/p>/g) ?? []).length;
    expect(opens).toBe(closes);
    const bolds = (capped.match(/<strong>/g) ?? []).length;
    expect(bolds).toBe((capped.match(/<\/strong>/g) ?? []).length);
    expect(capped.endsWith('</p>')).toBe(true);
  });

  it('survives a 100 KB hostile body', () => {
    const hostile = (malicious + '<script>x</script>').repeat(90);
    expect(hostile.length).toBeGreaterThan(100_000);
    const capped = sanitizeDescription(hostile);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(capped).not.toContain('<script');
    expect(capped).not.toContain('onerror');
  });

  it('does not split a multi-byte character at the cap', () => {
    const capped = sanitizeDescription('<p>' + 'é'.repeat(30_000) + '</p>');
    expect(capped).not.toContain('�');
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
  });
});

describe('textPreview / htmlToPlainText', () => {
  it('drops tags, decodes entities and collapses whitespace', () => {
    expect(htmlToPlainText('<p>Rust &amp; C++&nbsp;<b>fun</b>\n\n  now</p><script>x</script>')).toBe('Rust & C++ fun now');
    expect(htmlToPlainText('&#169; &#x1F600; &lt;b&gt;')).toBe('© 😀 <b>');
  });

  it('cuts at a word boundary with an ellipsis', () => {
    const p = textPreview('<p>The quick brown fox jumps over the lazy dog again and again</p>', 25);
    expect(p.length).toBeLessThanOrEqual(26);
    expect(p.endsWith('…')).toBe(true);
    expect(p).toBe('The quick brown fox…');
    expect(textPreview('<p>short</p>', 25)).toBe('short');
  });
});
