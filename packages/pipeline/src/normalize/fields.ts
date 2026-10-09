import type { Arrangement, Salary, Season } from '../schema/common.ts';

export interface ArrangementInput {
  remoteFlag?: boolean | null | undefined;
  title?: string | null | undefined;
  locations?: readonly string[] | null | undefined;
  description?: string | null | undefined;
}

const REMOTE_RE = /\b(remote|work from home|wfh|telecommut\w*|fully distributed)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on-?site|in[- ]person|in[- ]office)\b/i;

/** ATS flag first, then title and locations, then the description (plan 4.5). */
export function parseArrangement(input: ArrangementInput): Arrangement {
  if (input.remoteFlag === true) return 'remote';
  const head = [input.title ?? '', ...(input.locations ?? [])].join(' | ');
  if (HYBRID_RE.test(head)) return 'hybrid';
  if (REMOTE_RE.test(head)) return 'remote';
  if (ONSITE_RE.test(head)) return 'in_person';
  if (input.remoteFlag === false) return 'in_person';
  const desc = stripTags(input.description ?? '').slice(0, 6000);
  if (HYBRID_RE.test(desc)) return 'hybrid';
  if (/\b(this (role|position|internship) is|work) (fully |100% )?remote\b/i.test(desc)) return 'remote';
  if (ONSITE_RE.test(desc)) return 'in_person';
  return 'unknown';
}

export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SalaryInput {
  structured?: Salary | null | undefined;
  description?: string | null | undefined;
  title?: string | null | undefined;
}

const BOUNDS: Record<NonNullable<Salary['period']>, readonly [number, number]> = {
  hour: [7, 250],
  day: [50, 2000],
  week: [250, 10_000],
  month: [1000, 30_000],
  year: [15_000, 500_000],
};

function inBounds(period: Salary['period'], value: number | null): boolean {
  if (value === null) return true;
  if (!period) return value >= 7 && value <= 500_000;
  const [lo, hi] = BOUNDS[period];
  return value >= lo && value <= hi;
}

function periodFrom(text: string): Salary['period'] {
  if (/(?:\b(?:per|an)\s+|\/\s*)(?:hour|hr)\b|\bhourly\b/i.test(text)) return 'hour';
  if (/(?:\b(?:per|a)\s+|\/\s*)(?:year|yr|annum)\b|\bannual(?:ly)?\b/i.test(text)) return 'year';
  if (/(?:\b(?:per|a)\s+|\/\s*)(?:month|mo)\b|\bmonthly\b/i.test(text)) return 'month';
  if (/(?:\b(?:per|a)\s+|\/\s*)(?:week|wk)\b|\bweekly\b/i.test(text)) return 'week';
  if (/(?:\b(?:per|a)\s+|\/\s*)day\b|\bdaily\b/i.test(text)) return 'day';
  return null;
}

// Dollar amounts near these words are not pay.
const NOT_PAY_RE =
  /\b(bonus|relocation|revenue|funding|raised|valuation|billion|million|budget|fee|tuition|credit|allowance|reimburse\w*|discount|award|grant|prize|scholarship|equipment|laptop|cost|spend|sales|arr\b|portfolio|assets?)\b/i;

function looksLikePay(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index);
  const after = text.slice(index + length, index + length + 40);
  return !NOT_PAY_RE.test(before) && !NOT_PAY_RE.test(after);
}

function amount(raw: string): number {
  const cleaned = raw.replace(/[,$\s]/g, '');
  const k = /k$/i.test(cleaned);
  const n = Number(cleaned.replace(/k$/i, ''));
  return k ? n * 1000 : n;
}

const AMOUNT = String.raw`\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s?[kK]?)`;
const RANGE_RE = new RegExp(`${AMOUNT}\\s*(?:-|–|—|to|and)\\s*${AMOUNT}([^.;\\n]{0,40})`, 'g');
const SINGLE_RE = new RegExp(`${AMOUNT}([^.;\\n]{0,30})`, 'g');

/** Structured ATS salary first, else a conservative regex over the description. */
export function parseSalary(input: SalaryInput): Salary | null {
  const s = input.structured;
  if (s && (s.min !== null || s.max !== null)) {
    const period = s.period ?? null;
    if (inBounds(period, s.min) && inBounds(period, s.max)) {
      return { min: s.min, max: s.max, currency: s.currency || 'USD', period };
    }
  }
  const text = stripTags(input.description ?? '');
  if (!text) return null;
  for (const m of text.matchAll(RANGE_RE)) {
    const min = amount(m[1] ?? '');
    const max = amount(m[2] ?? '');
    const tail = m[3] ?? '';
    const period = periodFrom(tail) ?? inferPeriod(min);
    const matchedLength = m[0].length - tail.length;
    if (!looksLikePay(text, m.index, matchedLength)) continue;
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max && inBounds(period, min) && inBounds(period, max)) {
      return { min, max, currency: 'USD', period };
    }
  }
  for (const m of text.matchAll(SINGLE_RE)) {
    const value = amount(m[1] ?? '');
    const tail = m[2] ?? '';
    const period = periodFrom(tail);
    const matchedLength = m[0].length - tail.length;
    if (!looksLikePay(text, m.index, matchedLength)) continue;
    if (period && Number.isFinite(value) && inBounds(period, value)) {
      return { min: value, max: value, currency: 'USD', period };
    }
  }
  return null;
}

function inferPeriod(value: number): Salary['period'] {
  if (value >= 7 && value <= 250) return 'hour';
  if (value >= 15_000) return 'year';
  if (value >= 1000) return 'month';
  return null;
}

const SEASON_RE = /\b(Summer|Fall|Autumn|Spring|Winter)\s*(?:of\s*)?['’]?(20\d\d|\d\d)\b/i;
const YEAR_INTERN_RE = /\b(20\d\d)\s*(?:summer\s*)?(?:internship|intern|co-?op|program)\b/i;
const INTERN_YEAR_RE = /\b(?:internship|intern|co-?op)\s*[-–—:]?\s*(20\d\d)\b/i;
const IMMEDIATE_RE = /\b(start(?:ing)? (?:immediately|asap|right away|as soon as possible)|immediate (?:start|opening)|asap start)\b/i;

/** "Summer 2027", "Fall 2026", ..., "Immediate", or null. The title wins over the description. */
export function parseSeason(
  title: string | null | undefined,
  description?: string | null | undefined,
  startDate?: string | Date | null | undefined,
): Season | null {
  const fromText = (text: string): Season | null => {
    const m = text.match(SEASON_RE);
    if (m && m[1] && m[2]) {
      const season = m[1].toLowerCase() === 'autumn' ? 'Fall' : capitalize(m[1]);
      const year = m[2].length === 2 ? `20${m[2]}` : m[2];
      return `${season} ${year}`;
    }
    const y = text.match(YEAR_INTERN_RE) ?? text.match(INTERN_YEAR_RE);
    if (y && y[1]) return `Summer ${y[1]}`;
    if (IMMEDIATE_RE.test(text)) return 'Immediate';
    return null;
  };
  const t = fromText(title ?? '');
  if (t) return t;
  if (startDate) {
    const d = typeof startDate === 'string' ? new Date(startDate) : startDate;
    if (!Number.isNaN(d.getTime())) {
      const month = d.getUTCMonth();
      const year = d.getUTCFullYear();
      const season = month <= 1 ? 'Winter' : month <= 4 ? 'Spring' : month <= 7 ? 'Summer' : month <= 10 ? 'Fall' : 'Winter';
      return `${season} ${year}`;
    }
  }
  return fromText(stripTags(description ?? '').slice(0, 8000));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export interface WorkAuth {
  citizenship_required: boolean | null;
  sponsorship: 'yes' | 'no' | 'unknown';
  signals: string[];
}

const AUTH_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['us_citizen', /\b(u\.?s\.? citizens?(ship)?|united states citizens?(ship)?|citizens? of the united states)\b/i],
  ['itar', /\bITAR\b/],
  ['ear', /\b(export control|EAR\b)/],
  ['clearance', /\b(security clearance|secret clearance|top secret|TS\/SCI|DoD clearance|clearance (is )?required|ability to obtain (a |and maintain a )?(security )?clearance)\b/i],
  ['no_sponsorship', /\b(no (visa |work |employment |immigration )?sponsorship|(will|do|does|can)\s?not (be able to |currently )?(provide|offer|sponsor|support)[^.]{0,40}(sponsorship|visa|work authorization)|without (the need for |requiring )?(visa )?sponsorship|not eligible for (visa )?sponsorship|unable to sponsor|sponsorship (is )?not available|not (able|willing) to sponsor)\b/i],
  ['sponsorship_ok', /\b(sponsorship (is )?available|will sponsor|able to sponsor|visa sponsorship (is )?(provided|offered)|we sponsor)\b/i],
  ['opt', /\bOPT\b/],
  ['cpt', /\bCPT\b/],
  ['permanent_resident', /\b(permanent residents?|green card)\b/i],
  ['authorized_to_work', /\b(authorized|authorization|eligible) to work in the (u\.?s\.?|united states)\b/i],
];

/** Work-authorization signals from the description. The LLM later confirms these. */
export function parseWorkAuth(description: string | null | undefined): WorkAuth {
  const text = stripTags(description ?? '');
  const signals: string[] = [];
  for (const [name, re] of AUTH_PATTERNS) if (re.test(text)) signals.push(name);
  const has = (s: string) => signals.includes(s);
  let citizenship_required: boolean | null = null;
  if (has('us_citizen') && !has('permanent_resident')) citizenship_required = true;
  else if (has('itar') || has('clearance')) citizenship_required = true;
  else if (has('us_citizen') && has('permanent_resident')) citizenship_required = false;
  else if (has('opt') || has('cpt') || has('sponsorship_ok')) citizenship_required = false;
  let sponsorship: WorkAuth['sponsorship'] = 'unknown';
  if (has('no_sponsorship')) sponsorship = 'no';
  else if (has('sponsorship_ok')) sponsorship = 'yes';
  else if (citizenship_required === true) sponsorship = 'no';
  return { citizenship_required, sponsorship, signals };
}

const GRAD_RES: readonly RegExp[] = [
  /\b(?:graduat(?:e|es|ing|ion)(?: date)?|class of|expected graduation|anticipated graduation|degree completion)\s*(?:in|of|by|date|between|:)?\s*((?:(?:spring|summer|fall|winter|may|june|december|dec|jun|august|aug)\s*)?20\d\d(?:\s*(?:,|-|–|—|to|or|and|\/)\s*(?:(?:spring|summer|fall|winter|may|june|december|dec|jun|august|aug)\s*)?20\d\d)*)/gi,
  /\b(?:class of|grads?|graduates?)\s*['’]?(\d\d)\b/gi,
];

/** Graduation years mentioned in the text ("graduating in 2027", "class of 2027/2028", "May 2027"). */
export function parseGradYears(text: string | null | undefined): number[] {
  const plain = stripTags(text ?? '');
  const years = new Set<number>();
  for (const re of GRAD_RES) {
    for (const m of plain.matchAll(re)) {
      const span = m[1] ?? '';
      for (const y of span.matchAll(/\b(20\d\d)\b/g)) years.add(Number(y[1]));
      const two = span.match(/^(\d\d)$/);
      if (two) years.add(2000 + Number(two[1]));
    }
  }
  for (const m of plain.matchAll(/\b(?:May|June|December|August)\s+(20\d\d)\b/g)) {
    if (/graduat|degree|class/i.test(plain)) years.add(Number(m[1]));
  }
  const now = new Date().getUTCFullYear();
  return [...years].filter((y) => y >= now - 1 && y <= now + 6).sort((a, b) => a - b);
}
