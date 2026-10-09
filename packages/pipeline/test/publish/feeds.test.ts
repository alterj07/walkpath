import { describe, expect, it } from 'vitest';
import { buildFeed, escapeXml, feedTargets, FEED_MAX_ITEMS, SAFETY_LINE } from '../../src/publish/feeds.ts';
import { makeRecord } from './record-fixture.ts';

/** Minimal well-formedness check: no stray `&`, no `<` inside text, balanced tags. */
function assertWellFormed(xml: string): void {
  const withoutDecl = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  expect(withoutDecl).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  const stack: string[] = [];
  for (const m of withoutDecl.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  // Text between tags must not contain a raw '<'.
  const text = withoutDecl.replace(/<[^>]+>/g, '');
  expect(text).not.toContain('<');
}

const hostile = makeRecord({
  id: 'bbbbbbbbbbbb',
  title: 'Intern <script>alert(1)</script> & "quotes"',
  company: { slug: 'evil', name: "Evil & Co <b>'x'</b>", domain: 'evil.example' },
  apply_url: 'https://evil.example/phish',
  summary: null,
  description_html: '<p>Plain &amp; <strong>bold</strong> description with a very long body.</p>',
});

describe('buildFeed', () => {
  const xml = buildFeed({
    title: 'WalkPath: all',
    siteUrl: 'https://walkpath.pages.dev/',
    selfPath: '/feeds/all.xml',
    updated: '2026-10-09T15:00:00.000Z',
    items: [makeRecord(), hostile],
  });

  it('is well-formed Atom with escaped fields', () => {
    assertWellFormed(xml);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<title>Intern &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; @ Evil &amp; Co &lt;b&gt;&apos;x&apos;&lt;/b&gt;</title>');
    expect(xml).toContain('<id>urn:walkpath:job:a9f3c2e17b04</id>');
    expect(xml).toContain('href="https://walkpath.pages.dev/job/a9f3c2e17b04"');
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://walkpath.pages.dev/feeds/all.xml"/>');
  });

  it('never contains an apply URL', () => {
    expect(xml).not.toContain('evil.example/phish');
    expect(xml).not.toContain('boards.greenhouse.io');
  });

  it('uses the summary text or a description preview and ends content with the safety line', () => {
    expect(xml).toContain('<summary type="text">Build flight software in C++ &amp; Rust. Work with the avionics team.</summary>');
    expect(xml).toContain('<summary type="text">Plain &amp; bold description with a very long body.</summary>');
    const contents = xml.match(/<content type="text">[\s\S]*?<\/content>/g) ?? [];
    expect(contents).toHaveLength(2);
    for (const c of contents) expect(c).toContain(escapeXml(SAFETY_LINE) + '</content>');
  });

  it('sorts newest first and caps at FEED_MAX_ITEMS', () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      makeRecord({ id: i.toString(16).padStart(12, '0'), posted_at: new Date(Date.UTC(2026, 9, 1, i)).toISOString() }),
    );
    const out = buildFeed({ title: 't', siteUrl: 'https://s', selfPath: '/f.xml', updated: '2026-10-09T15:00:00.000Z', items: many });
    const ids = [...out.matchAll(/urn:walkpath:job:([0-9a-f]{12})/g)].map((m) => m[1]);
    expect(ids).toHaveLength(FEED_MAX_ITEMS);
    expect(ids[0]).toBe((149).toString(16).padStart(12, '0'));
  });

  it('strips control characters that XML forbids', () => {
    const out = buildFeed({
      title: 'bad\u0000title\u0007',
      siteUrl: 'https://s',
      selfPath: '/f.xml',
      updated: '2026-10-09T15:00:00.000Z',
      items: [],
    });
    expect(out).toContain('<title>badtitle</title>');
  });
});

describe('feedTargets', () => {
  it('lists all, 7 families, open states and remote', () => {
    const records = [
      makeRecord(),
      makeRecord({ id: 'cccccccccccc', location: { raw: 'Remote', city: null, state: null, country: 'US', arrangement: 'remote', others: [] } }),
      makeRecord({ id: 'dddddddddddd', closed_at: '2026-10-01T00:00:00.000Z', location: { raw: 'Austin, TX', city: 'Austin', state: 'TX', country: 'US', arrangement: 'in_person', others: [] } }),
    ];
    const targets = feedTargets(records);
    const files = targets.map((t) => t.file);
    expect(files).toContain('feeds/all.xml');
    expect(files).toContain('feeds/software_engineering.xml');
    expect(files).toContain('feeds/state-CO.xml');
    expect(files).not.toContain('feeds/state-TX.xml'); // only closed job there
    expect(files).toContain('feeds/remote.xml');
    expect(files).toHaveLength(1 + 7 + 1 + 1);
    const remote = targets.find((t) => t.file === 'feeds/remote.xml')!;
    expect(records.filter(remote.matches).map((r) => r.id)).toEqual(['cccccccccccc']);
    const co = targets.find((t) => t.file === 'feeds/state-CO.xml')!;
    expect(records.filter(co.matches).map((r) => r.id)).toEqual(['a9f3c2e17b04']);
  });
});
