// Static US gazetteer: states, common state spellings, city aliases and the GeoNames city list.
// Contains data from GeoNames (geonames.org), CC BY 4.0 (see us-cities.ts).
import { US_CITIES_RAW } from './us-cities.ts';

export interface GazetteerCity {
  name: string;
  state: string;
  population: number;
}

/** State and district names keyed by USPS code. */
export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

/** Extra spellings of state names (lowercase, punctuation stripped) → USPS code. */
const STATE_ALIASES: Readonly<Record<string, string>> = {
  calif: 'CA',
  cal: 'CA',
  'n y': 'NY',
  'n j': 'NJ',
  'n c': 'NC',
  's c': 'SC',
  'n d': 'ND',
  's d': 'SD',
  'n h': 'NH',
  'n m': 'NM',
  'w v': 'WV',
  'd c': 'DC',
  'washington dc': 'DC',
  'washington d c': 'DC',
  'district of columbia': 'DC',
  mass: 'MA',
  penn: 'PA',
  penna: 'PA',
  fla: 'FL',
  tex: 'TX',
  ill: 'IL',
  wash: 'WA',
  conn: 'CT',
  colo: 'CO',
  ariz: 'AZ',
  mich: 'MI',
  minn: 'MN',
  wisc: 'WI',
  wis: 'WI',
  okla: 'OK',
  oreg: 'OR',
  ore: 'OR',
  tenn: 'TN',
  nev: 'NV',
  neb: 'NE',
  nebr: 'NE',
  ind: 'IN',
  kans: 'KS',
  'u s virgin islands': 'VI',
  'puerto rico': 'PR',
};

/** City nicknames and alternate names → canonical gazetteer name + state. */
const CITY_ALIASES: Readonly<Record<string, readonly [string, string]>> = {
  nyc: ['New York City', 'NY'],
  'new york': ['New York City', 'NY'],
  'new york city': ['New York City', 'NY'],
  manhattan: ['New York City', 'NY'],
  sf: ['San Francisco', 'CA'],
  'san fran': ['San Francisco', 'CA'],
  la: ['Los Angeles', 'CA'],
  dc: ['Washington', 'DC'],
  'washington dc': ['Washington', 'DC'],
  'washington d c': ['Washington', 'DC'],
  philly: ['Philadelphia', 'PA'],
  'st louis': ['St. Louis', 'MO'],
  'saint louis': ['St. Louis', 'MO'],
  'st paul': ['Saint Paul', 'MN'],
  'st petersburg': ['St. Petersburg', 'FL'],
  'ft worth': ['Fort Worth', 'TX'],
  'ft lauderdale': ['Fort Lauderdale', 'FL'],
  'ft collins': ['Fort Collins', 'CO'],
  'mt view': ['Mountain View', 'CA'],
  'silicon valley': ['San Jose', 'CA'],
  'bay area': ['San Francisco', 'CA'],
  'sf bay area': ['San Francisco', 'CA'],
  'san francisco bay area': ['San Francisco', 'CA'],
  'research triangle': ['Raleigh', 'NC'],
  'research triangle park': ['Durham', 'NC'],
  rtp: ['Durham', 'NC'],
  'greater seattle area': ['Seattle', 'WA'],
  'greater boston area': ['Boston', 'MA'],
  'greater chicago area': ['Chicago', 'IL'],
  'greater los angeles area': ['Los Angeles', 'CA'],
  'new york metro': ['New York City', 'NY'],
  'new york metro area': ['New York City', 'NY'],
};

/** Countries and regions that are clearly not the US (lowercase). */
export const NON_US_COUNTRIES = new Set([
  'canada',
  'uk',
  'u k',
  'united kingdom',
  'england',
  'scotland',
  'wales',
  'ireland',
  'germany',
  'france',
  'spain',
  'italy',
  'netherlands',
  'the netherlands',
  'belgium',
  'switzerland',
  'austria',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'poland',
  'czech republic',
  'czechia',
  'portugal',
  'greece',
  'hungary',
  'romania',
  'israel',
  'india',
  'china',
  'japan',
  'south korea',
  'korea',
  'singapore',
  'australia',
  'new zealand',
  'mexico',
  'brazil',
  'argentina',
  'colombia',
  'chile',
  'united arab emirates',
  'uae',
  'saudi arabia',
  'qatar',
  'turkey',
  'türkiye',
  'south africa',
  'nigeria',
  'kenya',
  'egypt',
  'taiwan',
  'hong kong',
  'vietnam',
  'thailand',
  'malaysia',
  'indonesia',
  'philippines',
  'pakistan',
  'bangladesh',
  'europe',
  'emea',
  'apac',
  'latam',
]);

/** Canadian provinces and territories (codes and names, lowercase). */
export const CANADIAN_PROVINCES = new Set([
  'on',
  'qc',
  'bc',
  'ab',
  'mb',
  'sk',
  'ns',
  'nb',
  'nl',
  'pe',
  'yt',
  'nt',
  'nu',
  'ontario',
  'quebec',
  'québec',
  'british columbia',
  'alberta',
  'manitoba',
  'saskatchewan',
  'nova scotia',
  'new brunswick',
  'newfoundland',
  'newfoundland and labrador',
  'prince edward island',
]);

/** The ~60 largest non-US tech cities, so "London" alone is never treated as a US city. */
export const NON_US_CITIES = new Set([
  'london',
  'toronto',
  'vancouver',
  'montreal',
  'montréal',
  'ottawa',
  'waterloo',
  'calgary',
  'edmonton',
  'dublin',
  'berlin',
  'munich',
  'münchen',
  'hamburg',
  'frankfurt',
  'paris',
  'amsterdam',
  'eindhoven',
  'rotterdam',
  'brussels',
  'zurich',
  'zürich',
  'geneva',
  'lausanne',
  'stockholm',
  'oslo',
  'copenhagen',
  'helsinki',
  'warsaw',
  'krakow',
  'kraków',
  'prague',
  'vienna',
  'madrid',
  'barcelona',
  'lisbon',
  'milan',
  'rome',
  'athens',
  'tel aviv',
  'haifa',
  'bangalore',
  'bengaluru',
  'hyderabad',
  'pune',
  'mumbai',
  'chennai',
  'delhi',
  'new delhi',
  'gurgaon',
  'gurugram',
  'noida',
  'beijing',
  'shanghai',
  'shenzhen',
  'hangzhou',
  'hong kong',
  'taipei',
  'hsinchu',
  'tokyo',
  'osaka',
  'seoul',
  'singapore',
  'sydney',
  'melbourne',
  'brisbane',
  'auckland',
  'mexico city',
  'guadalajara',
  'monterrey',
  'são paulo',
  'sao paulo',
  'buenos aires',
  'bogotá',
  'bogota',
  'santiago',
  'dubai',
  'abu dhabi',
  'riyadh',
  'doha',
  'cairo',
  'cape town',
  'johannesburg',
  'nairobi',
  'lagos',
  'manila',
  'kuala lumpur',
  'jakarta',
  'bangkok',
  'ho chi minh city',
  'hanoi',
  'edinburgh',
  'manchester',
  'cambridge uk',
  'oxford',
  'bristol',
  'reading',
  'belfast',
]);

let citiesCache: GazetteerCity[] | null = null;
let byNameCache: Map<string, GazetteerCity[]> | null = null;

export function normalizePlaceKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function usCities(): GazetteerCity[] {
  if (citiesCache) return citiesCache;
  const out: GazetteerCity[] = [];
  for (const line of US_CITIES_RAW.split('\n')) {
    if (!line) continue;
    const [name, state, pop] = line.split('|');
    if (!name || !state || !pop) continue;
    out.push({ name, state, population: Number(pop) });
  }
  citiesCache = out;
  return out;
}

/** Cities keyed by normalized name, largest population first. */
export function citiesByName(): Map<string, GazetteerCity[]> {
  if (byNameCache) return byNameCache;
  const map = new Map<string, GazetteerCity[]>();
  for (const c of usCities()) {
    const key = normalizePlaceKey(c.name);
    const list = map.get(key);
    if (list) list.push(c);
    else map.set(key, [c]);
  }
  for (const list of map.values()) list.sort((a, b) => b.population - a.population);
  byNameCache = map;
  return map;
}

/** Resolve a state token (code, full name or alias) to a USPS code. */
export function resolveState(token: string): string | null {
  const key = normalizePlaceKey(token);
  if (!key) return null;
  const upper = key.toUpperCase();
  if (key.length === 2 && US_STATES[upper]) return upper;
  const alias = STATE_ALIASES[key];
  if (alias) return alias;
  for (const [code, name] of Object.entries(US_STATES)) {
    if (normalizePlaceKey(name) === key) return code;
  }
  return null;
}

/** Resolve a city alias such as "NYC" or "SF" to a canonical city. */
export function resolveCityAlias(token: string): readonly [string, string] | null {
  return CITY_ALIASES[normalizePlaceKey(token)] ?? null;
}
