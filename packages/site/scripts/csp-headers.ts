/**
 * Post-build step: Astro emits a tiny inline <style> and two inline <script>
 * blocks (the astro-island hydration runtime) on every page that has an
 * island. Our Content Security Policy allows no 'unsafe-inline', so this
 * script hashes exactly those blocks and writes the hashes into the CSP in
 * dist/_headers. Only the runtime Astro itself generates is ever authorized;
 * any other inline block fails the build so a regression cannot ship.
 *
 * Run after `astro build`: node packages/site/scripts/csp-headers.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MAX_DISTINCT_SCRIPTS = 3;
const MAX_DISTINCT_STYLES = 1;
/** Inline blocks must look like Astro's island runtime, never like page data. */
const ALLOWED_SCRIPT_MARKERS = ['astro', 'customElements'];

function* htmlFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (name.endsWith('.html')) yield p;
  }
}

function hash(content: string): string {
  return `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;
}

const scripts = new Map<string, string>();
const styles = new Map<string, string>();
const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/g;
/**
 * JSON-LD blocks (category pages) are data, not code: per the CSP spec a script
 * element with a non-JavaScript type is never executed, so the policy does not
 * apply and no hash is needed. They are skipped by the audit, not authorized.
 */
const dataTypeRe = /\stype="application\/ld\+json"/;
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/g;
const styleAttrRe = /\sstyle="[^"]*"/;

for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(scriptRe)) {
    const attrs = m[1] ?? '';
    if (/\ssrc=/.test(attrs) || dataTypeRe.test(attrs)) continue;
    const body = m[2] ?? '';
    if (!ALLOWED_SCRIPT_MARKERS.some((k) => body.includes(k))) {
      throw new Error(`csp-headers: unexpected inline script in ${file}: ${body.slice(0, 60)}`);
    }
    scripts.set(hash(body), body.slice(0, 48));
  }
  for (const m of html.matchAll(styleRe)) styles.set(hash(m[1] ?? ''), (m[1] ?? '').slice(0, 48));
  if (styleAttrRe.test(html)) throw new Error(`csp-headers: inline style attribute in ${file}`);
}

if (scripts.size > MAX_DISTINCT_SCRIPTS || styles.size > MAX_DISTINCT_STYLES) {
  throw new Error(`csp-headers: too many distinct inline blocks (${scripts.size} scripts, ${styles.size} styles)`);
}

const headersPath = join(dist, '_headers');
let headers = readFileSync(headersPath, 'utf8');
const scriptHashes = [...scripts.keys()].join(' ');
const styleHashes = [...styles.keys()].join(' ');
headers = headers
  .replace(/script-src 'self'/, `script-src 'self'${scriptHashes ? ` ${scriptHashes}` : ''}`)
  .replace(/style-src 'self'/, `style-src 'self'${styleHashes ? ` ${styleHashes}` : ''}`);
writeFileSync(headersPath, headers);

// robots.txt needs an absolute Sitemap URL, which is only known at deploy time.
const siteUrl = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
const robotsPath = join(dist, 'robots.txt');
if (/^https:\/\/[a-z0-9.-]+$/i.test(siteUrl)) {
  const robots = readFileSync(robotsPath, 'utf8').replace(/\n?Sitemap:.*\n?/g, '\n').trimEnd();
  writeFileSync(robotsPath, `${robots}\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
  console.log(`csp-headers: robots.txt sitemap set to ${siteUrl}/sitemap.xml`);
} else {
  console.log('csp-headers: SITE_URL not set; robots.txt has no Sitemap line');
}

// vercel.json carries a static copy of the policy for hosts that build from git; it must list
// the same hashes, otherwise the island runtime would be blocked there.
const vercelPath = join(dist, '..', 'vercel.json');
try {
  const vercel = readFileSync(vercelPath, 'utf8');
  const missing = [...scripts.keys(), ...styles.keys()].filter((h) => !vercel.includes(h));
  if (missing.length > 0) {
    throw new Error(`csp-headers: vercel.json is missing CSP hash(es) ${missing.join(' ')}; update its Content-Security-Policy`);
  }
  console.log('csp-headers: vercel.json CSP hashes verified');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

console.log(`csp-headers: authorized ${scripts.size} inline script hash(es) and ${styles.size} inline style hash(es)`);
for (const [h, preview] of scripts) console.log(`  script ${h}  ${JSON.stringify(preview)}`);
for (const [h, preview] of styles) console.log(`  style  ${h}  ${JSON.stringify(preview)}`);
