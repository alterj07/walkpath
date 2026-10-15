import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalLlamaProvider, summaryJsonSchema } from '../../src/llm/providers/local-llama.ts';
import { existingSummaryIds, inJobShard, listUnsummarized, selectRecords, summarizeRecords } from '../../src/llm/local-summarize.ts';
import { applySummaryFiles, SummaryFileSchema } from '../../src/publish/summary-files.ts';
import { openStore } from '../../src/publish/store.ts';
import { parseShard } from '../../src/cli/shard.ts';
import type { LlmFetch } from '../../src/llm/provider.ts';
import type { Summarizer } from '../../src/llm/chain.ts';
import type { SummaryOutput } from '../../src/llm/schema.ts';
import { makeRecord } from '../publish/record-fixture.ts';

const output: SummaryOutput = {
  summary: 'Builds compilers. Works with a mentor.',
  responsibilities: ['Write passes'],
  qualifications: ['CS student'],
  must_have_skills: ['C++'],
  nice_to_have_skills: ['LLVM'],
  role_family: 'software_engineering',
  is_internship: true,
  season: 'Summer 2027',
  grad_years: [2027],
  citizenship_required: null,
  sponsorship: 'unknown',
  confidence: 0.9,
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'walkpath-llm-'));
  dirs.push(d);
  return d;
}

describe('local llama provider', () => {
  it('posts an OpenAI-style body with a strict json_schema response format and no auth header', async () => {
    let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    const fetch: LlmFetch = async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = createLocalLlamaProvider({ baseUrl: 'http://127.0.0.1:8080/', fetch });
    const res = await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 600 });
    expect(JSON.parse(res.text)).toEqual(output);
    expect(seen).not.toBeNull();
    const s = seen as unknown as { url: string; body: Record<string, unknown>; headers: Record<string, string> };
    expect(s.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(s.headers['authorization']).toBeUndefined();
    const rf = s.body['response_format'] as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema['type']).toBe('object');
    expect(Object.keys(rf.json_schema.schema['properties'] as object)).toContain('must_have_skills');
    expect(provider.caps.requestsPerDay).toBeGreaterThan(1_000_000);
  });

  it('derives the JSON schema from the zod output schema with the enum families', () => {
    const schema = summaryJsonSchema();
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(schema['$schema']).toBeUndefined();
    expect(props['role_family']).toBeDefined();
    expect(JSON.stringify(props['role_family'])).toContain('software_engineering');
    expect((schema['required'] as string[]).sort()).toEqual(Object.keys(props).sort());
  });
});

describe('local summarize selection', () => {
  it('shards job ids deterministically and completely', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(12, '0'));
    const shards = [0, 1, 2].map((k) => ids.filter((id) => inJobShard(id, parseShard(`${k}/3`))));
    expect(shards.flat().sort()).toEqual([...ids].sort());
    expect(shards.every((s) => s.length > 40)).toBe(true);
    expect(ids.filter((id) => inJobShard(id, parseShard('0/1')))).toHaveLength(200);
  });

  it('lists unsummarized open records oldest-first from jobs and pending, skipping done ones', async () => {
    const dir = await tempDir();
    const jobs = openStore(join(dir, 'jobs'));
    const pending = openStore(join(dir, 'pending'));
    const a = makeRecord({ id: 'aaaaaaaaaaaa', summary: null, first_seen_at: '2026-10-09T10:00:00.000Z' });
    const b = makeRecord({ id: 'bbbbbbbbbbbb', summary: null, first_seen_at: '2026-10-08T10:00:00.000Z' });
    const c = makeRecord({ id: 'cccccccccccc', first_seen_at: '2026-10-07T10:00:00.000Z' }); // has a summary
    const d = makeRecord({ id: 'dddddddddddd', summary: null, closed_at: '2026-10-09T12:00:00.000Z' });
    await jobs.put(a);
    await jobs.put(c);
    await jobs.put(d);
    await pending.put(b);
    await jobs.writeChanged();
    await pending.writeChanged();
    const list = await listUnsummarized(dir);
    expect(list.map((r) => r.id)).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
    await mkdir(join(dir, 'summaries'), { recursive: true });
    await writeFile(join(dir, 'summaries', 'bbbbbbbbbbbb.json'), '{}');
    const done = await existingSummaryIds(dir);
    expect(selectRecords(list, parseShard('0/1'), done, 10).map((r) => r.id)).toEqual(['aaaaaaaaaaaa']);
    expect(selectRecords(list, parseShard('0/1'), new Set(), 1)).toHaveLength(1);
  });

  it('writes one validated file per summarized record and stops on exhaustion or deadline', async () => {
    const dir = await tempDir();
    const records = [makeRecord({ id: '111111111111', summary: null }), makeRecord({ id: '222222222222', summary: null }), makeRecord({ id: '333333333333', summary: null })];
    let calls = 0;
    const summarizer: Summarizer = {
      summarize: async () => {
        calls += 1;
        if (calls === 2) return { ok: false, reason: 'invalid' };
        if (calls === 3) return { ok: false, reason: 'exhausted' };
        return { ok: true, output, provider: 'local_llama', model: 'qwen' };
      },
      availableProviders: () => ['local_llama'],
    };
    const result = await summarizeRecords({ records, summarizer, outDir: dir, now: () => 1_760_000_000_000 });
    expect(result).toMatchObject({ attempted: 2, written: 1, invalid: 1, exhausted: true, timedOut: false });
    const files = await readdir(join(dir, 'summaries'));
    expect(files).toEqual(['111111111111.json']);
    const parsed = SummaryFileSchema.parse(JSON.parse(await readFile(join(dir, 'summaries', '111111111111.json'), 'utf8')));
    expect(parsed.content_hash).toBe(records[0]?.content_hash);
    expect(parsed.summary.model).toBe('local_llama/qwen');

    const past = await summarizeRecords({ records, summarizer, outDir: dir, deadlineMs: 1, now: () => 2 });
    expect(past).toMatchObject({ attempted: 0, written: 0, timedOut: true });
  });
});

describe('summary files fold-in', () => {
  it('applies matching files, drops hash mismatches and invalid ones, and is idempotent', async () => {
    const dir = await tempDir();
    const store = openStore(join(dir, 'jobs'));
    const pending = openStore(join(dir, 'pending'));
    const ok = makeRecord({ id: 'aaaaaaaaaaaa', summary: null });
    const stale = makeRecord({ id: 'bbbbbbbbbbbb', summary: null, content_hash: 'ffffffffffffffffffffffffffffffff' });
    await store.put(ok);
    await store.put(stale);
    await store.writeChanged();
    const summariesDir = join(dir, 'summaries');
    await mkdir(summariesDir, { recursive: true });
    const base = { summary: { ...output, text: output.summary, model: 'local_llama/qwen', generated_at: '2026-10-10T00:00:00.000Z' }, output, generated_at: '2026-10-10T00:00:00.000Z' };
    const summaryRecord = {
      text: output.summary,
      responsibilities: output.responsibilities,
      qualifications: output.qualifications,
      must_have_skills: output.must_have_skills,
      nice_to_have_skills: output.nice_to_have_skills,
      model: 'local_llama/qwen',
      generated_at: '2026-10-10T00:00:00.000Z',
    };
    await writeFile(join(summariesDir, 'aaaaaaaaaaaa.json'), JSON.stringify({ ...base, summary: summaryRecord, id: 'aaaaaaaaaaaa', content_hash: ok.content_hash }));
    await writeFile(join(summariesDir, 'bbbbbbbbbbbb.json'), JSON.stringify({ ...base, summary: summaryRecord, id: 'bbbbbbbbbbbb', content_hash: 'deadbeefdeadbeef' }));
    await writeFile(join(summariesDir, 'cccccccccccc.json'), JSON.stringify({ ...base, summary: summaryRecord, id: 'cccccccccccc', content_hash: 'deadbeefdeadbeef' }));
    await writeFile(join(summariesDir, 'dddddddddddd.json'), JSON.stringify({ ...base, summary: summaryRecord, output: { ...output, summary: 'visit http://evil.example' }, id: 'dddddddddddd', content_hash: ok.content_hash }));
    await writeFile(join(summariesDir, 'eeeeeeeeeeee.json'), '{not json');
    await writeFile(join(summariesDir, 'ignored.txt'), 'x');

    const applied: string[] = [];
    const run = () => applySummaryFiles({ dataDir: dir, store, pending, apply: async (id) => { applied.push(id); } });
    const first = await run();
    expect(first).toEqual({ files: 5, applied: 1, invalid: 2, hash_mismatch: 1, missing: 1 });
    expect(applied).toEqual(['aaaaaaaaaaaa']);
    expect(await readdir(summariesDir)).toEqual(['ignored.txt']);
    const second = await run();
    expect(second).toEqual({ files: 0, applied: 0, invalid: 0, hash_mismatch: 0, missing: 0 });
    expect(applied).toHaveLength(1);
  });
});
