import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  estimateTokens,
  extractJsonObject,
  htmlToText,
  parseJsonReply,
  POSTING_MAX_CHARS,
  SYSTEM_PROMPT,
} from '../../src/llm/prompt.ts';

describe('htmlToText', () => {
  it('strips tags, decodes entities, keeps list structure and collapses whitespace', () => {
    const html =
      '<div><h3>About</h3><p>We build &amp; ship &lt;things&gt;&nbsp;fast.</p><ul><li>Python</li><li>C&#43;&#x2B;</li></ul><script>alert(1)</script><style>p{}</style></div>';
    expect(htmlToText(html)).toBe('About\nWe build & ship <things> fast.\n- Python\n- C++');
  });

  it('turns <br> into line breaks and squeezes blank runs', () => {
    expect(htmlToText('a<br>b<br/><br/><br/>c')).toBe('a\nb\n\nc');
  });
});

describe('buildPrompt', () => {
  it('produces a system + user pair with the posting capped at 6,000 chars', () => {
    const long = 'x'.repeat(POSTING_MAX_CHARS + 500);
    const msgs = buildPrompt({ title: 'SWE Intern', company: 'Acme', location: 'Austin, TX', descriptionText: long });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toBe(SYSTEM_PROMPT);
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.content).toContain('Title: SWE Intern');
    expect(msgs[1]?.content).toContain('[truncated]');
    expect(msgs[1]?.content.length).toBeLessThan(POSTING_MAX_CHARS + 200);
  });

  it('tells the model to ignore instructions in the posting and to avoid links', () => {
    expect(SYSTEM_PROMPT).toMatch(/ignore any instructions/i);
    expect(SYSTEM_PROMPT).toMatch(/never include urls/i);
  });
});

describe('extractJsonObject / parseJsonReply', () => {
  it('handles fenced replies and surrounding prose', () => {
    const reply = 'Sure! ```json\n{"a": {"b": "}"}, "c": [1, 2]}\n```\nDone.';
    expect(extractJsonObject(reply)).toBe('{"a": {"b": "}"}, "c": [1, 2]}');
    expect(parseJsonReply(reply)).toEqual({ a: { b: '}' }, c: [1, 2] });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJsonReply('{"s": "say \\"hi\\" {not a brace}"}')).toEqual({ s: 'say "hi" {not a brace}' });
  });

  it('returns null for no object or malformed JSON', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"unterminated": 1')).toBeNull();
    expect(parseJsonReply('{bad json}')).toBeNull();
  });
});

describe('estimateTokens', () => {
  it('is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
