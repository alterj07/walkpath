/**
 * Line logger for the pipeline scripts. Actions run logs are public, so every value is
 * passed through a redaction guard (plan 11.5): a value is printed only if it is short and
 * contains no URL, unless its key is on the allowlist of fields that are known to be safe
 * (ids, counts, codes). Anything else is replaced by `[redacted]`.
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;

export const MAX_VALUE_LENGTH = 200;

/** Keys whose values are ids, counts, codes or repo-relative paths and may always be printed (length-capped). */
const SAFE_KEYS = new Set([
  'run',
  'run_id',
  'board',
  'board_id',
  'ats',
  'code',
  'error',
  'mode',
  'kind',
  'path',
  'file',
  'out',
  'state',
  'boards',
  'sources',
]);

export function redact(key: string, value: LogValue): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value.length > MAX_VALUE_LENGTH) return '[redacted]';
  if (SAFE_KEYS.has(key)) return value;
  if (/https?:/i.test(value) || /\bwww\./i.test(value)) return '[redacted]';
  // Messages are written by our own code (counts and ids); other free-text values are not.
  if (key !== 'message' && /\s/.test(value) && value.length > 80) return '[redacted]';
  return value;
}

export function formatLine(
  level: LogLevel,
  message: string,
  fields: Record<string, LogValue> = {},
  at: Date = new Date(),
): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${redact(k, v)}`);
  const msg = redact('message', message);
  return `${at.toISOString()} ${level.toUpperCase()} ${msg}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

export interface Logger {
  info(message: string, fields?: Record<string, LogValue>): void;
  warn(message: string, fields?: Record<string, LogValue>): void;
  error(message: string, fields?: Record<string, LogValue>): void;
  /** Adapter for modules that take a `(message: string) => void` log callback. */
  line(message: string): void;
}

export function createLogger(
  write: (line: string) => void = (l) => process.stdout.write(l + '\n'),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, LogValue>): void =>
    write(formatLine(level, message, fields, now()));
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    line: (m) => emit('info', m),
  };
}
