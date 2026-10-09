import {
  CANADIAN_PROVINCES,
  NON_US_CITIES,
  NON_US_COUNTRIES,
  citiesByName,
  normalizePlaceKey,
  resolveCityAlias,
  resolveState,
} from '../data/us-gazetteer.ts';

export interface ParsedLocation {
  city: string | null;
  state: string | null;
  country: 'US' | 'other' | null;
  remote: boolean;
  /** The raw string named several places; `city`/`state` describe the first. */
  multiple: boolean;
  /** True when `city` was confirmed against the gazetteer (false when kept from the raw text). */
  matched: boolean;
}

const EMPTY: ParsedLocation = {
  city: null,
  state: null,
  country: null,
  remote: false,
  multiple: false,
  matched: false,
};

const US_COUNTRY_KEYS = new Set(['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america']);
const REMOTE_RE = /\b(remote|work from home|wfh|telecommute|telecommuting|virtual|anywhere)\b/i;
const MULTI_RE = /\b(multiple locations|various locations|multiple cities|various|several locations|many locations|nationwide)\b/i;
// Case-sensitive on purpose: "OR", "IN" and "LA" are state codes.
const NOISE_RE = /\b(hybrid|Hybrid|on-?site|On-?site|Onsite|in[- ]person|In[- ]person|office|Office|HQ|headquarters|Headquarters|campus|Campus|metro area|Metro Area|metropolitan area|Metropolitan Area|area|Area|greater|Greater|region|Region|based|Based|only|Only|location|Location|locations|Locations)\b/g;
const LEADING_FILLER_RE = /^(?:in|from|within|the|located in|based in)\s+/i;
const MIN_POP_FOR_UNQUALIFIED_CITY = 100_000;

function tokensOf(segment: string): string[] {
  return segment
    .replace(/\(([^)]*)\)/g, ', $1')
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '')
    .split(/\s*(?:,|\s[-–—]\s|\s\/\s|\s\|\s|;|\s>\s|\s•\s)\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function cleanToken(token: string): string {
  // "San Francisco Bay Area", "Greater Seattle Area": an alias wins before noise words are removed.
  if (resolveCityAlias(token.trim())) return token.trim();
  return token
    .replace(NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_FILLER_RE, '')
    .replace(/^[-–—:\s]+|[-–—:\s]+$/g, '')
    .trim();
}

function isUsCountry(key: string): boolean {
  return US_COUNTRY_KEYS.has(key);
}

function isForeignCountry(key: string): boolean {
  return NON_US_COUNTRIES.has(key) || CANADIAN_PROVINCES.has(key);
}

/**
 * Parse an ATS location string against the static US gazetteer. Misses return nulls so
 * the caller can record them for review; nothing here calls a geocoding API.
 */
export function parseLocation(raw: string | null | undefined): ParsedLocation {
  if (!raw) return { ...EMPTY };
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ...EMPTY };

  const result: ParsedLocation = { ...EMPTY };
  if (REMOTE_RE.test(text)) result.remote = true;
  if (MULTI_RE.test(text)) result.multiple = true;

  // "New York, NY / Austin, TX", "Boston, MA | Remote", "Seattle; Denver"
  // Lowercase "or" only: "Portland, OR 97201" must not split.
  const multiSplit = text.split(/\s*(?:\s\/\s|\s\|\s|;|\s\+\s\d+\s+more|\sor\s)\s*/).filter(Boolean);
  if (multiSplit.length > 1) {
    result.multiple = true;
    const firstReal = multiSplit.find((s) => !REMOTE_RE.test(s) && !MULTI_RE.test(s)) ?? multiSplit[0];
    text = firstReal ?? text;
  }

  // "US-CA-Sunnyvale", "USA-Texas-Austin"
  const dashed = text.match(/^(US|USA)-([A-Za-z ]+)-([A-Za-z .'-]+)$/i);
  if (dashed) {
    text = `${dashed[3]}, ${dashed[2]}, US`;
  }

  let tokens = tokensOf(text).map(cleanToken).filter(Boolean);
  tokens = tokens.filter((t) => !REMOTE_RE.test(t) || cleanToken(t.replace(REMOTE_RE, '')).length > 0).map((t) =>
    cleanToken(t.replace(REMOTE_RE, '')),
  );
  tokens = tokens.filter(Boolean);
  if (tokens.length === 0) {
    if (result.remote && /\b(us|usa|united states)\b/i.test(raw)) result.country = 'US';
    return result;
  }

  // Country signals. A foreign CITY name only counts when nothing says US ("Paris, TX" is Texas);
  // foreign countries and Canadian provinces always count.
  const keys = tokens.map(normalizePlaceKey);
  for (const key of keys) {
    if (isUsCountry(key)) result.country = 'US';
  }
  const usSignal = result.country === 'US' || tokens.some((t) => resolveState(t) !== null);
  for (const key of keys) {
    if (isForeignCountry(key) || (!usSignal && NON_US_CITIES.has(key))) {
      result.country = 'other';
      return result;
    }
  }
  tokens = tokens.filter((_, i) => !isUsCountry(keys[i] ?? ''));

  // State: the last token that resolves to a state (never the only token when it is also a city alias).
  let stateIndex = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] ?? '';
    if (i === 0 && tokens.length === 1 && resolveCityAlias(t)) break;
    const code = resolveState(t);
    if (code) {
      result.state = code;
      stateIndex = i;
      break;
    }
  }
  if (result.state) result.country = 'US';

  // City: the first token that is not the state.
  const cityCandidates = tokens.filter((_, i) => i !== stateIndex);
  const candidate = cityCandidates[0];
  if (!candidate) return result;
  const alias = resolveCityAlias(candidate);
  const byName = citiesByName();
  if (alias) {
    result.city = alias[0];
    if (!result.state) result.state = alias[1];
    result.country = 'US';
    result.matched = true;
    return result;
  }
  const key = normalizePlaceKey(candidate);
  const matches = byName.get(key) ?? [];
  if (result.state) {
    const inState = matches.find((c) => c.state === result.state);
    if (inState) {
      result.city = inState.name;
      result.matched = true;
    } else {
      // Keep the employer's spelling; the review file catches it.
      result.city = candidate;
      result.matched = false;
    }
    return result;
  }
  // An unqualified name resolves only when it is unique, or clearly dominant: ≥ 100k people and
  // at least 3× the runner-up ("Portland" → OR; "Springfield" stays null for review).
  const top = matches[0];
  const runnerUp = matches[1];
  const dominant =
    top !== undefined &&
    top.population >= MIN_POP_FOR_UNQUALIFIED_CITY &&
    (runnerUp === undefined || top.population >= 3 * runnerUp.population);
  if (top && (matches.length === 1 || dominant)) {
    result.city = top.name;
    result.state = top.state;
    result.country = 'US';
    result.matched = true;
  }
  return result;
}
