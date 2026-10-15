/**
 * Client-side resume parsing. The file never leaves the browser: PDF text comes
 * from pdfjs-dist (its worker is bundled from node_modules via Vite's `?url`
 * import so the CSP's script-src 'self' holds), plain text is read directly, and
 * `parseResume` turns the text into a partial Profile with word-boundary matches
 * against a curated skill dictionary. Nothing here guesses: a field the resume
 * does not state stays absent.
 */
import type { Profile } from './profile.ts';

export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
export const RESUME_MAX_CHARS = 60_000;
export const RESUME_MAX_PAGES = 10;

/** Lazily loads pdfjs so the chunk is only fetched on the profile page when a PDF is chosen. */
async function pdfText(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // pdfjs 5 dropped isEvalSupported from the options type; our CSP has no 'unsafe-eval'
  // anyway, so the only hardening left to ask for here is disabling font loading.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true }).promise;
  const pages = Math.min(doc.numPages, RESUME_MAX_PAGES);
  const parts: string[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line: string[] = [];
    for (const item of content.items) {
      if ('str' in item) {
        line.push(item.str);
        if (item.hasEOL) line.push('\n');
      }
    }
    parts.push(line.join(' '));
  }
  await doc.destroy();
  return parts.join('\n');
}

export async function extractResumeText(file: File): Promise<string> {
  if (file.size > RESUME_MAX_BYTES) throw new Error('Resume is larger than 5 MB');
  const name = file.name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
  const text = isPdf ? await pdfText(await file.arrayBuffer()) : await file.text();
  return stripNulls(text).slice(0, RESUME_MAX_CHARS);
}

/** Drops NUL bytes a malformed PDF text layer can carry, without a control-character literal. */
function stripNulls(s: string): string {
  let out = '';
  for (const ch of s) if (ch.charCodeAt(0) !== 0) out += ch;
  return out;
}

/** Curated skill vocabulary (display name → aliases matched on word boundaries, case-insensitive). */
export const SKILL_DICTIONARY: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Languages
  ['Python', ['python']], ['Java', ['java']], ['C', ['\\bc\\b(?!\\+|#)']], ['C++', ['c\\+\\+', 'cpp']], ['C#', ['c#', 'csharp']],
  ['JavaScript', ['javascript', 'js']], ['TypeScript', ['typescript', 'ts']], ['Go', ['golang', 'go']], ['Rust', ['rust']],
  ['Kotlin', ['kotlin']], ['Swift', ['swift']], ['Scala', ['scala']], ['Ruby', ['ruby']], ['PHP', ['php']], ['R', ['\\br\\b']],
  ['MATLAB', ['matlab']], ['SQL', ['sql']], ['Bash', ['bash', 'shell scripting']], ['Perl', ['perl']], ['Lua', ['lua']],
  ['Haskell', ['haskell']], ['OCaml', ['ocaml']], ['Dart', ['dart']], ['Elixir', ['elixir']], ['Julia', ['julia']],
  ['Verilog', ['verilog']], ['VHDL', ['vhdl']], ['SystemVerilog', ['systemverilog']], ['Assembly', ['assembly', 'x86', 'arm assembly']],
  ['Solidity', ['solidity']], ['Objective-C', ['objective-c']], ['Groovy', ['groovy']], ['Zig', ['zig']],
  // Web / frontend
  ['React', ['react', 'react\\.js', 'reactjs']], ['Next.js', ['next\\.js', 'nextjs']], ['Vue', ['vue', 'vue\\.js']], ['Angular', ['angular']],
  ['Svelte', ['svelte']], ['HTML', ['html', 'html5']], ['CSS', ['css', 'css3']], ['Tailwind', ['tailwind']], ['Redux', ['redux']],
  ['Node', ['node', 'node\\.js', 'nodejs']], ['Express', ['express', 'express\\.js']], ['Django', ['django']], ['Flask', ['flask']],
  ['FastAPI', ['fastapi']], ['Spring', ['spring', 'spring boot']], ['Rails', ['rails', 'ruby on rails']], ['GraphQL', ['graphql']],
  ['REST', ['rest', 'restful']], ['gRPC', ['grpc']], ['WebSockets', ['websockets?']], ['Webpack', ['webpack']], ['Vite', ['vite']],
  ['React Native', ['react native']], ['Flutter', ['flutter']], ['Android', ['android']], ['iOS', ['ios']], ['SwiftUI', ['swiftui']],
  ['Electron', ['electron']], ['jQuery', ['jquery']], ['Astro', ['astro']], ['Storybook', ['storybook']], ['Figma', ['figma']],
  // Data / ML
  ['Machine Learning', ['machine learning', 'ml']], ['Deep Learning', ['deep learning']], ['NLP', ['nlp', 'natural language processing']],
  ['Computer Vision', ['computer vision']], ['PyTorch', ['pytorch', 'torch']], ['TensorFlow', ['tensorflow']], ['Keras', ['keras']],
  ['scikit-learn', ['scikit-learn', 'sklearn']], ['pandas', ['pandas']], ['NumPy', ['numpy']], ['SciPy', ['scipy']], ['Matplotlib', ['matplotlib']],
  ['Spark', ['spark', 'pyspark']], ['Hadoop', ['hadoop']], ['Kafka', ['kafka']], ['Airflow', ['airflow']], ['dbt', ['dbt']],
  ['Snowflake', ['snowflake']], ['BigQuery', ['bigquery']], ['Redshift', ['redshift']], ['Databricks', ['databricks']],
  ['Tableau', ['tableau']], ['Power BI', ['power bi']], ['Excel', ['excel']], ['Jupyter', ['jupyter']], ['Hugging Face', ['hugging ?face']],
  ['LLMs', ['llms?', 'large language models?']], ['LangChain', ['langchain']], ['OpenCV', ['opencv']], ['XGBoost', ['xgboost']],
  ['Reinforcement Learning', ['reinforcement learning']], ['Statistics', ['statistics', 'statistical modeling']], ['A/B Testing', ['a/b testing']],
  ['MLOps', ['mlops']], ['CUDA', ['cuda']], ['JAX', ['jax']], ['ONNX', ['onnx']], ['Ray', ['\\bray\\b']],
  // Databases
  ['PostgreSQL', ['postgres', 'postgresql']], ['MySQL', ['mysql']], ['SQLite', ['sqlite']], ['MongoDB', ['mongodb', 'mongo']],
  ['Redis', ['redis']], ['DynamoDB', ['dynamodb']], ['Cassandra', ['cassandra']], ['Elasticsearch', ['elasticsearch']],
  ['Neo4j', ['neo4j']], ['Firebase', ['firebase', 'firestore']], ['Supabase', ['supabase']], ['Oracle DB', ['oracle']],
  // Cloud / infra / devops
  ['AWS', ['aws', 'amazon web services']], ['GCP', ['gcp', 'google cloud']], ['Azure', ['azure']], ['Docker', ['docker']],
  ['Kubernetes', ['kubernetes', 'k8s']], ['Terraform', ['terraform']], ['Ansible', ['ansible']], ['Linux', ['linux', 'unix']],
  ['Git', ['git', 'github', 'gitlab']], ['CI/CD', ['ci/cd', 'continuous integration', 'github actions', 'jenkins', 'circleci']],
  ['Nginx', ['nginx']], ['Serverless', ['serverless', 'lambda', 'cloud functions']], ['Prometheus', ['prometheus']], ['Grafana', ['grafana']],
  ['Datadog', ['datadog']], ['Cloudflare', ['cloudflare']], ['Vercel', ['vercel']], ['Helm', ['helm']], ['Networking', ['tcp/ip', 'networking']],
  // Systems / hardware / embedded
  ['Embedded Systems', ['embedded', 'embedded systems']], ['FPGA', ['fpga']], ['RTOS', ['rtos', 'freertos']], ['Firmware', ['firmware']],
  ['PCB Design', ['pcb', 'altium', 'kicad', 'eagle']], ['ROS', ['\\bros\\b', 'ros2']], ['Arduino', ['arduino']], ['Raspberry Pi', ['raspberry pi']],
  ['Microcontrollers', ['microcontrollers?', 'stm32', 'esp32']], ['Signal Processing', ['dsp', 'signal processing']], ['Simulink', ['simulink']],
  ['LabVIEW', ['labview']], ['SPICE', ['spice', 'ltspice']], ['Cadence', ['cadence', 'virtuoso']], ['Operating Systems', ['operating systems']],
  ['Distributed Systems', ['distributed systems']], ['Compilers', ['compilers?', 'llvm']], ['Multithreading', ['multithreading', 'concurrency']],
  ['Computer Architecture', ['computer architecture']], ['OpenGL', ['opengl']], ['Vulkan', ['vulkan']], ['Unity', ['unity']], ['Unreal', ['unreal']],
  // Security
  ['Cybersecurity', ['cybersecurity', 'information security', 'infosec']], ['Penetration Testing', ['penetration testing', 'pentesting']],
  ['Cryptography', ['cryptography']], ['Wireshark', ['wireshark']], ['Burp Suite', ['burp suite']], ['Metasploit', ['metasploit']],
  ['SIEM', ['siem', 'splunk']], ['OWASP', ['owasp']], ['Active Directory', ['active directory']], ['IAM', ['\\biam\\b']],
  // Product / design / quant
  ['Product Management', ['product management', 'product manager']], ['Agile', ['agile', 'scrum']], ['Jira', ['jira']],
  ['UX Research', ['ux research', 'user research']], ['Wireframing', ['wireframing', 'prototyping']], ['Sketch', ['sketch']],
  ['Adobe XD', ['adobe xd']], ['Photoshop', ['photoshop']], ['Illustrator', ['illustrator']],
  ['Quantitative Analysis', ['quantitative analysis', 'quant']], ['Options Pricing', ['options pricing', 'derivatives']],
  ['Time Series', ['time series']], ['Probability', ['probability']], ['Linear Algebra', ['linear algebra']], ['Optimization', ['optimization']],
  ['Bloomberg', ['bloomberg']], ['KDB', ['kdb', 'q/kdb']], ['Backtesting', ['backtesting']],
  // Testing / misc
  ['Unit Testing', ['unit testing', 'jest', 'pytest', 'junit', 'vitest']], ['Selenium', ['selenium']], ['Cypress', ['cypress']],
  ['Playwright', ['playwright']], ['Postman', ['postman']], ['OAuth', ['oauth']], ['Microservices', ['microservices']],
  ['System Design', ['system design']], ['Data Structures', ['data structures']], ['Algorithms', ['algorithms']],
  ['Object-Oriented Programming', ['object-oriented', 'oop']], ['Functional Programming', ['functional programming']],
  ['Technical Writing', ['technical writing']], ['Salesforce', ['salesforce']], ['SAP', ['\\bsap\\b']], ['ServiceNow', ['servicenow']],
];

const MAJORS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Computer Science', /computer science|\bcs\b(?= major| degree| student)|\bb\.?s\.?\s*(?:in\s+)?computer science/i],
  ['Computer Engineering', /computer engineering/i],
  ['Electrical Engineering', /electrical (?:and computer )?engineering|\bee\b(?= major| degree)/i],
  ['Software Engineering', /software engineering(?= major| degree|,| and|\n)/i],
  ['Data Science', /data science/i],
  ['Information Systems', /information systems|management information/i],
  ['Information Technology', /information technology/i],
  ['Mathematics', /\bmathematics\b|applied math/i],
  ['Statistics', /\bstatistics\b(?= major| degree|,| and)/i],
  ['Physics', /\bphysics\b(?= major| degree|,| and)/i],
  ['Mechanical Engineering', /mechanical engineering/i],
  ['Aerospace Engineering', /aerospace engineering/i],
  ['Robotics', /\brobotics\b(?= major| degree| engineering)/i],
  ['Cybersecurity', /cybersecurity(?= major| degree)/i],
  ['Economics', /\beconomics\b(?= major| degree|,| and)/i],
  ['Finance', /\bfinance\b(?= major| degree)/i],
  ['Business', /business administration|\bbusiness\b(?= major| degree)/i],
  ['Human-Computer Interaction', /human[- ]computer interaction|\bhci\b/i],
  ['Cognitive Science', /cognitive science/i],
  ['Bioinformatics', /bioinformatics/i],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasRegex(alias: string): RegExp {
  // Aliases that already carry anchors or escapes are regex fragments; plain words get boundaries.
  const isFragment = /[\\()?]/.test(alias) && !/^[a-z0-9 .#+/-]+$/i.test(alias);
  const body = isFragment ? alias : escapeRe(alias);
  const lead = /^[a-z0-9]/i.test(alias) ? '(?<![a-z0-9])' : '';
  const trail = /[a-z0-9+#]$/i.test(alias) ? '(?![a-z0-9])' : '';
  return new RegExp(`${lead}${body}${trail}`, 'i');
}

const COMPILED_SKILLS: ReadonlyArray<readonly [string, readonly RegExp[]]> = SKILL_DICTIONARY.map(([name, aliases]) => [
  name,
  aliases.map(aliasRegex),
]);

export function extractSkills(text: string): string[] {
  const out: string[] = [];
  for (const [name, res] of COMPILED_SKILLS) {
    if (res.some((re) => re.test(text))) out.push(name);
  }
  return out;
}

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

/**
 * The graduation year a resume states, or null. Explicit phrasing ("Expected May 2028",
 * "Class of '29") and education date ranges ("Aug 2025 - May 2027") all count; with several
 * degrees the latest plausible year is the one still ahead of the candidate.
 */
export function extractGradYear(text: string, now = new Date()): number | null {
  const thisYear = now.getFullYear();
  const ok = (y: number) => (y >= thisYear - 1 && y <= thisYear + 8 ? y : null);
  const patterns: RegExp[] = [
    new RegExp(`(?:expected|anticipated|graduating|graduation)[^\\n]{0,30}?(?:${MONTHS}\\s*)?(20\\d\\d)`, 'gi'),
    /class of\s*'?(20\d\d|\d\d)\b/gi,
    /\bexp\.?\s*(?:grad\.?)?\s*(?:[a-z]+\s*)?(20\d\d)/gi,
    // Education date range "2026 – 2030" or "Aug 2026 - May 2030": the later year is graduation.
    new RegExp(`20\\d\\d\\s*[-\\u2013\\u2014]\\s*(?:${MONTHS}\\s*)?(20\\d\\d)`, 'gi'),
  ];
  let best: number | null = null;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const raw = m[1] ?? '';
      const y = raw.length === 2 ? 2000 + Number(raw) : Number(raw);
      const v = ok(y);
      if (v !== null && (best === null || v > best)) best = v;
    }
  }
  return best;
}

export function extractDegreeLevel(text: string): Profile['degree_level'] {
  if (/\b(?:ph\.?d|doctor of philosophy|doctoral)\b/i.test(text)) return 'phd';
  if (/\b(?:m\.?s\.?|m\.?eng|master(?:'s| of)|msc|mba|m\.?a\.?)\b(?!.*intern)/i.test(text) && /master|m\.?s\.?c?\b|m\.?eng|mba/i.test(text)) return 'masters';
  if (/\b(?:b\.?s\.?|b\.?a\.?|b\.?eng|b\.?tech|bachelor(?:'s| of)|bsc)\b/i.test(text)) return 'bachelors';
  if (/\b(?:a\.?s\.?|a\.?a\.?|associate(?:'s| of| degree))\b/i.test(text)) return 'associate';
  if (/high school diploma/i.test(text)) return 'high_school';
  return null;
}

export function extractMajors(text: string): string[] {
  const out: string[] = [];
  for (const [name, re] of MAJORS) if (re.test(text)) out.push(name);
  return out.slice(0, 10);
}

/** Only explicit statements count; absence stays null. */
export function extractCitizenship(text: string): { citizen: boolean | null; needs_sponsorship: boolean | null } {
  const t = text.toLowerCase();
  let citizen: boolean | null = null;
  let needs: boolean | null = null;
  if (/\b(?:u\.?s\.?|united states) citizen\b/.test(t) || /\bpermanent resident\b|\bgreen card\b/.test(t)) {
    citizen = /\bu\.?s\.? citizen\b|\bunited states citizen\b/.test(t) ? true : citizen;
    needs = false;
  }
  if (/\b(?:f-1|f1 visa|opt|cpt|require(?:s)? (?:visa )?sponsorship|will require sponsorship)\b/.test(t)) {
    needs = true;
    if (/\bf-1\b|\bf1 visa\b/.test(t)) citizen = false;
  }
  if (/\b(?:do(?:es)? not|no) (?:need|require) (?:visa )?sponsorship\b|authorized to work in the (?:u\.?s\.?|united states)/.test(t)) needs = false;
  return { citizen, needs_sponsorship: needs };
}

/** Everything the resume states, nothing more. */
export function parseResume(text: string, now = new Date()): Partial<Profile> {
  const out: Partial<Profile> = {};
  const grad = extractGradYear(text, now);
  if (grad !== null) out.grad_year = grad;
  const degree = extractDegreeLevel(text);
  if (degree !== null) out.degree_level = degree;
  const majors = extractMajors(text);
  if (majors.length > 0) out.majors = majors;
  const skills = extractSkills(text);
  if (skills.length > 0) out.skills = skills;
  const c = extractCitizenship(text);
  if (c.citizen !== null) out.citizen = c.citizen;
  if (c.needs_sponsorship !== null) out.needs_sponsorship = c.needs_sponsorship;
  if (grad !== null && grad >= now.getFullYear()) out.enrolled = true;
  return out;
}
