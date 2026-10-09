import { describe, expect, it } from 'vitest';
import { createLogger, formatLine, redact } from '../../src/cli/log.ts';

describe('log redaction', () => {
  it('prints ids, counts and codes', () => {
    expect(redact('board', 'greenhouse:figma')).toBe('greenhouse:figma');
    expect(redact('count', 12)).toBe('12');
    expect(redact('code', 'timeout')).toBe('timeout');
    expect(redact('x', null)).toBe('null');
  });

  it('refuses urls, long strings and prose outside safe keys', () => {
    expect(redact('title', 'Apply at https://evil.example/x')).toBe('[redacted]');
    expect(redact('title', 'see www.example.com')).toBe('[redacted]');
    expect(redact('body', 'x'.repeat(201))).toBe('[redacted]');
    expect(redact('board', 'x'.repeat(201))).toBe('[redacted]');
    expect(redact('desc', 'a long sentence with many words '.repeat(4))).toBe('[redacted]');
  });

  it('allows long count-and-id messages from our own code but never a url in them', () => {
    const summary = 'run crawl-api-1: boards ok=20 failed=5 partial=0; jobs new=2244 changed=0 closed=0 reopened=0 reposts=0';
    expect(redact('message', summary)).toBe(summary);
    expect(redact('message', `${summary} https://leak.example`)).toBe('[redacted]');
  });

  it('formats lines with a timestamp and fields', () => {
    const at = new Date('2026-10-09T12:00:00Z');
    expect(formatLine('info', 'crawl done', { boards: 3, url: 'https://x.test' }, at)).toBe(
      '2026-10-09T12:00:00.000Z INFO crawl done boards=3 url=[redacted]',
    );
  });

  it('logger writes through the sink', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), () => new Date(0));
    log.warn('careful', { ats: 'lever' });
    log.line('plain');
    expect(lines).toEqual(['1970-01-01T00:00:00.000Z WARN careful ats=lever', '1970-01-01T00:00:00.000Z INFO plain']);
  });
});
