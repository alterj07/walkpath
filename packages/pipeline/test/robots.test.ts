import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots } from '../src/http/robots.ts';

const sample = `
# comment
User-agent: *
Disallow: /embed/
Crawl-delay: 2

User-agent: WalkPathBot
Disallow: /private/
Allow: /private/ok
Crawl-delay: 5

User-agent: Googlebot
User-agent: Bingbot
Disallow: /
`;

describe('parseRobots', () => {
  it('prefers the bot-specific group over *', () => {
    const r = parseRobots(sample, 'WalkPathBot');
    expect(r.disallow).toEqual(['/private/']);
    expect(r.allow).toEqual(['/private/ok']);
    expect(r.crawlDelayMs).toBe(5000);
  });
  it('falls back to * and ignores other agents', () => {
    const r = parseRobots(sample, 'OtherBot');
    expect(r.disallow).toEqual(['/embed/']);
    expect(r.crawlDelayMs).toBe(2000);
  });
  it('matches agent groups on token boundaries only', () => {
    const txt = 'User-agent: bot\nDisallow: /a\n\nUser-agent: walk\nDisallow: /b\n\nUser-agent: *\nDisallow: /c\n';
    expect(parseRobots(txt, 'WalkPathBot').disallow).toEqual(['/c']);
    expect(parseRobots('User-agent: walkpath\nDisallow: /x\n', 'WalkPathBot').disallow).toEqual(['/x']);
    expect(parseRobots('User-agent: walkpathbot\nDisallow: /y\n', 'WalkPathBot').disallow).toEqual(['/y']);
    expect(parseRobots('User-agent: walkpathbot/1.0\nDisallow: /z\n', 'WalkPathBot').disallow).toEqual([]);
  });
  it('stacked user-agent lines share rules', () => {
    expect(parseRobots(sample, 'Bingbot').disallow).toEqual(['/']);
  });
  it('empty file allows everything', () => {
    const r = parseRobots('', 'WalkPathBot');
    expect(isPathAllowed(r, '/anything')).toBe(true);
  });
});

describe('isPathAllowed', () => {
  const rules = parseRobots(sample, 'WalkPathBot');
  it('honours Disallow prefixes and longer Allow overrides', () => {
    expect(isPathAllowed(rules, '/private/secret')).toBe(false);
    expect(isPathAllowed(rules, '/private/ok/thing')).toBe(true);
    expect(isPathAllowed(rules, '/v1/boards/figma/jobs')).toBe(true);
  });
  it('supports * and $ in patterns', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /api/*/raw', '*');
    expect(isPathAllowed(r, '/a/b.pdf')).toBe(false);
    expect(isPathAllowed(r, '/a/b.pdfx')).toBe(true);
    expect(isPathAllowed(r, '/api/v1/raw')).toBe(false);
    expect(isPathAllowed(r, '/api/v1/cooked')).toBe(true);
  });
});
