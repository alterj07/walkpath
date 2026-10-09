import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBoards, loadSourcesConfig, isSourceEnabled } from '../../src/registry/boards.ts';

// Guards against schema drift between src/schema/common.ts and the committed registry files
// (a narrower AtsSchema once made the crawl exit on sources.json; see commit history).
const root = fileURLToPath(new URL('../../../../', import.meta.url));

describe('committed registry files', () => {
  it('registry/sources.json parses and every API source is enabled', async () => {
    const cfg = await loadSourcesConfig(`${root}registry/sources.json`);
    for (const ats of ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday'] as const) {
      expect(isSourceEnabled(cfg, ats)).toBe(true);
    }
  });

  it('registry/sample.csv loads through the core Board schema', async () => {
    const boards = await loadBoards(`${root}registry/sample.csv`);
    expect(boards.length).toBe(25);
    expect(new Set(boards.map((b) => b.ats)).size).toBe(5);
  });
});
