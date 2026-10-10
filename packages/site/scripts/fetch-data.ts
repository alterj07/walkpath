/**
 * Vercel build step: pull the published data from the `data` branch of the repository into
 * public/ before `astro build`, so a host that builds from git (Vercel) serves real listings.
 *
 * Source: a tarball of the `data` branch. Public repositories need no credentials; a private
 * repository needs a read-only token in GITHUB_TOKEN (set as a Vercel environment variable).
 * When the data cannot be fetched the committed samples stay in place and the build logs why.
 *
 * Mapping mirrors DEPLOY_MAP in packages/pipeline/src/publish/orchestrate.ts:
 *   data/feeds/*  -> public/feeds/*        everything else -> public/data/*
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.env.WALKPATH_DATA_REPO ?? 'alterj07/walkpath';
const BRANCH = process.env.WALKPATH_DATA_BRANCH ?? 'data';
const token = process.env.GITHUB_TOKEN ?? '';
const siteDir = process.cwd();
const publicDir = join(siteDir, 'public');

function count(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      const sub = count(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += s.size;
    }
  }
  return { files, bytes };
}

async function download(): Promise<string | null> {
  const url = token
    ? `https://api.github.com/repos/${REPO}/tarball/${BRANCH}`
    : `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;
  const headers: Record<string, string> = { 'user-agent': 'walkpath-site-build' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    console.log(`fetch-data: ${BRANCH} branch not fetched (HTTP ${res.status}); keeping the committed samples`);
    return null;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'walkpath-data-'));
  const tarPath = join(tmp, 'data.tar.gz');
  writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
  const out = join(tmp, 'tree');
  mkdirSync(out);
  execFileSync('tar', ['-xzf', tarPath, '--strip-components=1', '-C', out]);
  return out;
}

const tree = await download().catch((err: unknown) => {
  console.log(`fetch-data: ${err instanceof Error ? err.name : 'error'}; keeping the committed samples`);
  return null;
});

if (tree && existsSync(join(tree, 'meta.json'))) {
  rmSync(join(publicDir, 'data'), { recursive: true, force: true });
  rmSync(join(publicDir, 'feeds'), { recursive: true, force: true });
  mkdirSync(join(publicDir, 'data'), { recursive: true });
  for (const name of readdirSync(tree)) {
    if (name.startsWith('.')) continue;
    const from = join(tree, name);
    const to = name === 'feeds' ? join(publicDir, 'feeds') : join(publicDir, 'data', name);
    cpSync(from, to, { recursive: true });
  }
  const d = count(join(publicDir, 'data'));
  const f = count(join(publicDir, 'feeds'));
  console.log(`fetch-data: staged ${d.files} data files (${d.bytes} bytes) and ${f.files} feeds (${f.bytes} bytes) from ${REPO}@${BRANCH}`);
} else if (tree) {
  console.log('fetch-data: tarball has no meta.json (empty data branch); keeping the committed samples');
}
