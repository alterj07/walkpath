/**
 * Tiny typed flag parser for the pipeline scripts. Supports `--name value`, `--name=value`,
 * boolean `--flag` and `--no-flag`, and repeated flags (last one wins). Positional arguments
 * are collected in `_`. No dependencies.
 */
export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  _: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (body.startsWith('no-')) {
      flags[body.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, _: positional };
}

export class ArgError extends Error {}

export function stringFlag(args: ParsedArgs, name: string, fallback?: string): string {
  const v = args.flags[name];
  if (v === undefined) {
    if (fallback === undefined) throw new ArgError(`--${name} is required`);
    return fallback;
  }
  if (typeof v !== 'string' || v.length === 0) throw new ArgError(`--${name} needs a value`);
  return v;
}

export function intFlag(args: ParsedArgs, name: string, fallback: number, min = 0): number {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min) throw new ArgError(`--${name} must be an integer >= ${min}`);
  return n;
}

export function boolFlag(args: ParsedArgs, name: string, fallback = false): boolean {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ArgError(`--${name} must be true or false`);
}

export function listFlag(args: ParsedArgs, name: string, fallback: readonly string[]): string[] {
  const v = args.flags[name];
  if (v === undefined) return [...fallback];
  if (typeof v !== 'string') throw new ArgError(`--${name} needs a comma-separated value`);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function enumFlag<T extends string>(args: ParsedArgs, name: string, allowed: readonly T[], fallback: T): T {
  const v = stringFlag(args, name, fallback);
  if (!(allowed as readonly string[]).includes(v)) throw new ArgError(`--${name} must be one of ${allowed.join('|')}`);
  return v as T;
}
