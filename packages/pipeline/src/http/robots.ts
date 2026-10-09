/** Minimal robots.txt parser: Disallow/Allow/Crawl-delay for one agent, with `*` fallback. */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number | null;
}

const EMPTY: RobotsRules = { allow: [], disallow: [], crawlDelayMs: null };

/** Parse robots.txt and return the rules that apply to `agentToken` (case-insensitive substring match), else `*`. */
export function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups = new Map<string, RobotsRules>();
  let current: RobotsRules[] = [];
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      const name = value.toLowerCase();
      let rules = groups.get(name);
      if (!rules) {
        rules = { allow: [], disallow: [], crawlDelayMs: null };
        groups.set(name, rules);
      }
      current = lastWasAgent ? [...current, rules] : [rules];
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    for (const rules of current) {
      if (field === 'disallow' && value !== '') rules.disallow.push(value);
      else if (field === 'allow' && value !== '') rules.allow.push(value);
      else if (field === 'crawl-delay') {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) rules.crawlDelayMs = Math.round(n * 1000);
      }
    }
  }
  const token = agentToken.toLowerCase();
  // A group claims us only when its name is a whole token of our product token
  // ("walkpathbot" or "walkpath"), never a bare substring such as "bot".
  for (const [name, rules] of groups) {
    if (name !== '*' && matchesAgentToken(token, name)) return rules;
  }
  return groups.get('*') ?? EMPTY;
}

function matchesAgentToken(token: string, groupName: string): boolean {
  if (groupName === '' || !token.startsWith(groupName)) return false;
  const rest = token.slice(groupName.length);
  // "walkpathbot" and "walkpath" claim us; "walk" or "bot" do not.
  return rest === '' || rest === 'bot' || !/^[a-z0-9]/.test(rest);
}

function patternToRegExp(pattern: string): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}`);
}

/** Longest matching rule wins; Allow beats Disallow on equal length (Google semantics). */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let best: { allow: boolean; len: number } = { allow: true, len: -1 };
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (patternToRegExp(p).test(path)) {
        if (p.length > best.len || (p.length === best.len && allow)) best = { allow, len: p.length };
      }
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best.allow;
}
