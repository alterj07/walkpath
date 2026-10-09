/**
 * Scam-signal screen (plan section 11.3). A job that trips any signal is held for
 * review rather than published; counts appear on /status and in a maintainer issue.
 * Patterns use word boundaries and short context windows to keep ordinary postings
 * ("cryptography", "wire harness", "fee waiver", EEO boilerplate) from tripping.
 */

export interface ScamInput {
  title: string;
  /** Plain text of the description (tags already removed). */
  descriptionText: string;
  /** False when the company has no registry entry. */
  companyKnown: boolean;
}

export interface ScamResult {
  held: boolean;
  signals: string[];
}

interface Signal {
  name: string;
  pattern: RegExp;
  /** A match is ignored when this pattern matches the text just before it. */
  negatedBy?: RegExp;
  /** A match is ignored when this pattern matches within `contextChars` around it. */
  excusedBy?: RegExp;
  contextChars?: number;
}

const MONEY = String.raw`\$\s?\d[\d,]*(?:\.\d+)?k?`;

/** Each pattern is tested against the title + description (case-insensitive). */
const SIGNALS: readonly Signal[] = [
  {
    name: 'fee_request',
    // "pay a $50 registration fee", "training fee required", "processing fee of", "small deposit"
    pattern: new RegExp(
      String.raw`\b(?:(?:pay|send|submit|require[sd]?|charge[sd]?|collect)\b[^.\n]{0,40}\b(?:registration|processing|training|application|background[- ]check|onboarding|activation|admin(?:istration)?)\s+fee)|(?:\b(?:registration|processing|training|application|activation|admin(?:istration)?)\s+fee\s+(?:of|is)\s+${MONEY})|(?:\b(?:refundable|security|upfront|initial)\s+deposit\s+(?:of|is|required)\b)`,
      'gi',
    ),
    // "We will never ask you to pay a registration fee" is the opposite of a scam.
    negatedBy: /\b(?:never|not|no|don'?t|won'?t)\b[^.\n]{0,20}$/i,
  },
  {
    name: 'wire_transfer',
    // Needs request context: "send a wire transfer", "payment via wire transfer", "wire transfer of $500";
    // not "payment rails: ACH, wire transfer, RTP" or "wire transfer fraud models".
    pattern: /\b(?:(?:send|make|via|by|through)\s+(?:an?\s+)?wire\s+transfer|wire\s+transfer\s+(?:of|for)\s+\$|western\s+union|moneygram|send\s+(?:us\s+)?(?:money|funds|a\s+payment))\b/gi,
  },
  {
    name: 'gift_card',
    pattern: /\bgift\s*cards?\b[^.\n]{0,60}\b(?:purchase|buy|send|payment|pay|redeem)\b|\b(?:purchase|buy|send)\b[^.\n]{0,40}\bgift\s*cards?\b/i,
  },
  {
    name: 'crypto_payment',
    // "paid in bitcoin", "payment via crypto", "send USDT" — not "cryptography" or a crypto employer
    pattern: /\b(?:pa(?:id|yment|y)\b[^.\n]{0,30}\b(?:in|via|with|through)\s+(?:bitcoin|btc|ethereum|eth|usdt|crypto(?:currency)?)\b|\b(?:send|transfer)\s+(?:bitcoin|btc|usdt|crypto(?:currency)?)\b)/i,
  },
  {
    name: 'chat_app_to_apply',
    // "contact us on WhatsApp to apply", "message +1 ... on Telegram", "apply via WhatsApp"
    pattern: /\b(?:apply|contact|message|text|reach|interview|chat)\b[^.\n]{0,40}\b(?:on|via|through|over|using)\s+(?:whatsapp|telegram|signal|google\s+chat|hangouts)\b|\b(?:whatsapp|telegram)\b[^.\n]{0,40}\b(?:to\s+apply|for\s+(?:an?\s+)?interview|to\s+(?:get\s+)?start)/i,
  },
  {
    name: 'ssn_request',
    // "send your SSN", "provide social security number" before an offer; EEO text says "without regard to"
    pattern: /\b(?:send|provide|submit|share|email|upload|enter)\b[^.\n]{0,40}\b(?:ssn|social\s+security\s+(?:number|card)|bank\s+(?:account|details|login)|routing\s+number|driver'?s\s+licen[cs]e\s+(?:copy|scan|photo))/gi,
    // Post-offer paperwork legitimately mentions these: "SSN required for payroll after your offer".
    excusedBy: /\b(?:offer|i-9|payroll|hired|employment\s+eligibility)\b/i,
    contextChars: 60,
  },
  {
    name: 'earn_from_home',
    pattern: new RegExp(
      String.raw`\b(?:earn|make)\s+(?:up\s+to\s+)?${MONEY}\s*(?:\/|per|a|each)\s*(?:day|week|hour)\b[^.\n]{0,60}\b(?:from\s+home|no\s+experience|work\s+from\s+anywhere)|\b(?:from\s+home|no\s+experience\s+(?:needed|required))\b[^.\n]{0,60}\b(?:earn|make)\s+(?:up\s+to\s+)?${MONEY}\s*(?:\/|per|a|each)\s*(?:day|week|hour)\b`,
      'i',
    ),
  },
  {
    name: 'pay_for_equipment',
    pattern: /\b(?:pay|purchase|buy)\b[^.\n]{0,30}\b(?:your\s+own\s+)?(?:equipment|laptop|software\s+licen[cs]e|starter\s+kit|materials)\b[^.\n]{0,30}\b(?:upfront|in\s+advance|before\s+(?:you\s+)?start|reimburse[d]?\s+later)|\b(?:equipment|laptop|starter\s+kit)\s+(?:fee|cost)\s+(?:of|is)\s+\$/i,
  },
  {
    name: 'check_cashing',
    pattern: /\b(?:cash|deposit)\s+(?:the|a|our)\s+(?:cashier'?s\s+)?check\b[^.\n]{0,60}\b(?:send|forward|transfer|keep)\b/i,
  },
];

export const SCAM_SIGNAL_NAMES: readonly string[] = [...SIGNALS.map((s) => s.name), 'unknown_company'];

/** True when at least one match of the signal survives its negation and context exclusions. */
function fires(signal: Signal, text: string): boolean {
  // Global patterns so every match is checked; a non-global pattern is treated as a single match.
  const re = signal.pattern.global ? signal.pattern : new RegExp(signal.pattern.source, signal.pattern.flags + 'g');
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (signal.negatedBy && signal.negatedBy.test(text.slice(Math.max(0, start - 40), start))) continue;
    if (signal.excusedBy) {
      const window = signal.contextChars ?? 60;
      const around = text.slice(Math.max(0, start - window), Math.min(text.length, end + window));
      if (signal.excusedBy.test(around)) continue;
    }
    return true;
  }
  return false;
}

/** Run every scam signal over a posting. `held` is true when any signal fires. */
export function scamSignals(input: ScamInput): ScamResult {
  const text = `${input.title}\n${input.descriptionText}`.replace(/\s+/g, ' ');
  const signals: string[] = [];
  for (const s of SIGNALS) {
    if (fires(s, text)) signals.push(s.name);
  }
  if (!input.companyKnown) signals.push('unknown_company');
  return { held: signals.length > 0, signals };
}
