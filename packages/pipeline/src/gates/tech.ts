import type { RoleFamily } from '../schema/common.ts';

export type TechVerdict = 'tech' | 'not_tech' | 'ambiguous';

export interface TechGateResult {
  family: RoleFamily | null;
  verdict: TechVerdict;
  /** The keyword that decided the verdict, for the review file. */
  matched: string;
}

// Non-tech roles that override everything, including "engineer" in "Sales Engineer".
const NOT_TECH_RE =
  /\b(marketing|sales|account executive|account manag\w*|business development|finance|financial analyst|accounting|accountant|audit|tax|treasury|actuar\w*|hr|human resources|people (ops|operations|team)|talent|recruit\w*|legal|paralegal|attorney|compliance|nurse|nursing|medical|clinical|pharmac\w*|physician|dental|veterinar\w*|chef|culinary|retail|merchandis\w*|warehouse|logistics|supply chain|procurement|purchasing|driver|customer (service|success|support)|communications|public relations|journalis\w*|editorial|copywrit\w*|social media|brand|events?|hospitality|real estate|property|construction|civil engineer\w*|structural engineer\w*|mechanical engineer\w*|chemical engineer\w*|materials engineer\w*|manufacturing engineer\w*|industrial engineer\w*|process engineer\w*|environmental|sustainability|safety|ehs|quality engineer\w*|quality assurance engineer|test technician|lab technician|facilities|business operations|strategy|consulting|consultant|investment|banking|wealth|trading assistant|underwrit\w*|claims|insurance|teacher|teaching|tutor|education|curriculum|admissions|library|museum|graphic design|video|photograph\w*|animation|writer|content|policy|government affairs|economics|economist|biolog\w*|chemist\w*|physics|geolog\w*|agricultur\w*|food science|interior design|architect(ure|ural)?|urban planning|fashion|apparel|textile|sports|athletic|coaching)\b/i;

// Order matters: first family to match wins, except for the explicit overrides below.
const FAMILY_RULES: ReadonlyArray<readonly [RoleFamily, RegExp]> = [
  [
    'hardware_embedded',
    /\b(hardware|embedded|firmware|fpga|asic|rtl|verilog|vhdl|electrical( engineer\w*)?|ee\b|rf\b|silicon|chip|soc\b|vlsi|pcb|analog|mixed[- ]signal|digital design|circuit|semiconductor|photonics|optics|optical engineer\w*|robotics|mechatronics|controls? engineer\w*|avionics|flight software|gnc\b|power electronics|signal integrity|dft\b|physical design|validation engineer\w*|test engineer\w*|systems engineer\w*|electronics?)\b/i,
  ],
  [
    'quant_research',
    /\b(quant\w*|quantitative|trading tech\w*|trading systems?|algorithmic trading|research engineer|strategist|market mak\w*)\b/i,
  ],
  [
    'data_ml_ai',
    /\b(data|analytics|machine learning|ml\b|mle\b|ai\b|artificial intelligence|deep learning|nlp\b|natural language|computer vision|cv engineer|research scientist|applied scientist|applied science|statistic\w*|business intelligence|bi\b|llm\w*|generative|genai|perception|reinforcement learning|speech|recommendation|forecasting|bioinformatics|computational|database\w*|gis\b|sql\b|reporting analyst|data visuali\w*)\b/i,
  ],
  [
    'ux_design',
    /\b(ux\b|ui\b|ux\/ui|ui\/ux|product design\w*|interaction design\w*|experience design\w*|design technolog\w*|visual design\w*|user research\w*|ux research\w*|user experience)\b/i,
  ],
  [
    'product',
    /\b(product manag\w*|product management|apm\b|associate product|technical program|technical product|program manag\w*|product owner|product operations|product analyst|product strategy)\b/i,
  ],
  [
    'it_cloud_security',
    /\b(it\b|information technology|information systems|information security|infosec|cloud|security|cyber\w*|network\w*|systems? admin\w*|sysadmin|sre\b|site reliability|devops|platform engineer\w*|infrastructure|help ?desk|service desk|technical support|support engineer\w*|solutions? engineer\w*|solutions? architect|systems? analyst|database admin\w*|dba\b|identity|iam\b|soc analyst|penetration|pentest\w*|threat|vulnerabilit\w*|erp\b|sap\b|salesforce|servicenow|workday analyst|enterprise applications?|technology analyst|technology intern|tech(nology)? consult\w*)\b/i,
  ],
  [
    'software_engineering',
    /\b(software|swe\b|sde\b|sdet\b|developer|development engineer|engineering intern|engineer intern|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ios\b|android|web\b|devops|sre\b|qa\b|quality assurance|test automation|automation engineer\w*|game\w*|graphics|compiler|kernel|distributed systems|api\b|application engineer\w*|applications? developer|programmer|programming|coding|code\b|computer science|cs\b|technical intern|technology intern|solutions? engineer\w*|simulation|tooling|build engineer\w*|release engineer\w*|systems software|operating system|runtime|virtualization|blockchain|crypto(graphy)?|engineering|engineer)\b/i,
  ],
];

const TECH_DEPARTMENT_RE = /\b(engineering|r&d|research and development|technology|tech\b|data|software|product|it\b|information technology|platform|infrastructure|security|design)\b/i;
const TECHY_TITLE_RE = /\b(engineer\w*|developer|analyst|technolog\w*|technical|technician|scientist|architect|programmer|systems?)\b/i;

const UX_NOT_PRODUCT_RE = /\bproduct design\w*\b/i;
const SOFTWARE_OVERRIDE_RE = /\b(software|swe|sde|developer|full[- ]?stack|front[- ]?end|back[- ]?end|web developer|application developer|programmer)\b/i;
const HARDWARE_PRIMARY_RE =
  /\b(firmware|embedded|fpga|asic|rtl|verilog|vhdl|silicon|vlsi|pcb|analog|mixed[- ]signal|hardware|computer architecture|design verification|dv engineer\w*|verification engineer\w*|flight software|avionics|robotics|gnc)\b/i;
const DATA_PRIMARY_RE =
  /\b(machine learning|ml\b|mle\b|ai\b|artificial intelligence|deep learning|data scien\w*|data engineer\w*|data analy\w*|analytics|business intelligence|nlp\b|computer vision|research scientist|applied scientist|llm\w*|genai|generative ai)\b/i;
const QUANT_PRIMARY_RE = /\b(quant\w*|quantitative|algorithmic trading)\b/i;
const PRODUCT_PRIMARY_RE = /\b(product manag\w*|apm\b|technical program manag\w*)\b/i;

/** Rules-only tech gate (plan 4.5): assigns a role family or sends the title to the LLM as ambiguous. */
export function techGate(title: string, department?: string | null): TechGateResult {
  const t = title.replace(/\s+/g, ' ').trim();
  const dept = (department ?? '').trim();

  // A non-tech signal wins unless a strong software/data/hardware word is also present
  // ("Financial Software Engineer Intern" is software; "Sales Engineer Intern" is not).
  const notTech = t.match(NOT_TECH_RE);
  if (notTech) {
    const strong =
      t.match(SOFTWARE_OVERRIDE_RE) ??
      t.match(DATA_PRIMARY_RE) ??
      t.match(HARDWARE_PRIMARY_RE) ??
      t.match(QUANT_PRIMARY_RE) ??
      t.match(PRODUCT_PRIMARY_RE);
    if (!strong) {
      return { family: null, verdict: 'not_tech', matched: notTech[0] };
    }
  }

  // Explicit priorities before the ordered table.
  const hw = t.match(HARDWARE_PRIMARY_RE);
  if (hw) return { family: 'hardware_embedded', verdict: 'tech', matched: hw[0] };
  const quant = t.match(QUANT_PRIMARY_RE);
  if (quant) return { family: 'quant_research', verdict: 'tech', matched: quant[0] };
  const data = t.match(DATA_PRIMARY_RE);
  if (data) return { family: 'data_ml_ai', verdict: 'tech', matched: data[0] };
  const ux = t.match(UX_NOT_PRODUCT_RE);
  if (ux) return { family: 'ux_design', verdict: 'tech', matched: ux[0] };
  // "Software Engineer Intern - Network Security" is software; IT words there are qualifiers.
  const sw = t.match(SOFTWARE_OVERRIDE_RE);
  if (sw && !PRODUCT_PRIMARY_RE.test(t)) return { family: 'software_engineering', verdict: 'tech', matched: sw[0] };

  for (const [family, re] of FAMILY_RULES) {
    const m = t.match(re);
    if (m) return { family, verdict: 'tech', matched: m[0] };
  }

  if (TECH_DEPARTMENT_RE.test(dept) || TECHY_TITLE_RE.test(t)) {
    return { family: null, verdict: 'ambiguous', matched: dept ? `department: ${dept}` : 'techy title' };
  }
  return { family: null, verdict: 'not_tech', matched: 'no tech keyword' };
}
