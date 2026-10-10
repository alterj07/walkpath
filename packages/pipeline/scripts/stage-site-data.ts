/**
 * Copy the published data directory into the site's `public/` tree before `astro build`
 * (plan 5.1, 8.1). Paths follow `DEPLOY_MAP` from the orchestrator: `feeds/` is served at
 * `/feeds/*`, everything else under `/data/*`.
 *
 *   node packages/pipeline/scripts/stage-site-data.ts --data data --site packages/site [--clean]
 *
 * `--clean` first removes the committed development samples under `public/data` and
 * `public/feeds` so a stale sample can never ship; CI always passes it. Logs print file
 * counts and byte totals only.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ArgError, boolFlag, parseArgs, stringFlag } from '../src/cli/args.ts';
import { createLogger } from '../src/cli/log.ts';
import { DEPLOY_MAP } from '../src/publish/orchestrate.ts';

function walk(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      const sub = walk(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += s.size;
    }
  }
  return { files, bytes };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const log = createLogger();
  const args = parseArgs(argv);
  const dataDir = stringFlag(args, 'data', 'data');
  const siteDir = stringFlag(args, 'site', 'packages/site');
  const clean = boolFlag(args, 'clean', false);
  const publicDir = join(siteDir, 'public');

  // --clean deletes directories, so the site dir must stay inside the working directory.
  if (!resolve(siteDir).startsWith(resolve(process.cwd()))) {
    log.error('site directory must be inside the working directory', { site: siteDir });
    return 1;
  }

  if (!(await exists(dataDir))) {
    log.error('data directory missing', { data: dataDir });
    return 1;
  }

  if (clean) {
    for (const sub of ['data', 'feeds']) {
      await rm(join(publicDir, sub), { recursive: true, force: true });
    }
    log.info('removed dev samples', { targets: 2 });
  }

  let copied = 0;
  let missing = 0;
  for (const entry of DEPLOY_MAP) {
    const from = join(dataDir, entry.from);
    const to = join(publicDir, entry.to);
    if (!(await exists(from))) {
      missing += 1;
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
    copied += 1;
  }

  const dataStats = (await exists(join(publicDir, 'data'))) ? walk(join(publicDir, 'data')) : { files: 0, bytes: 0 };
  const feedStats = (await exists(join(publicDir, 'feeds'))) ? walk(join(publicDir, 'feeds')) : { files: 0, bytes: 0 };
  log.info('staged site data', {
    entries_copied: copied,
    entries_missing: missing,
    data_files: dataStats.files,
    data_bytes: dataStats.bytes,
    feed_files: feedStats.files,
    feed_bytes: feedStats.bytes,
  });
  if (copied === 0) {
    log.error('nothing staged: the data directory has none of the published paths');
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const code = err instanceof ArgError ? 'bad_args' : err instanceof Error ? err.constructor.name : 'error';
    process.stderr.write(`stage-site-data failed code=${code}\n`);
    process.exit(1);
  },
);
