import { describe, expect, it } from 'vitest';
import { ArgError, boolFlag, enumFlag, intFlag, listFlag, parseArgs, stringFlag } from '../../src/cli/args.ts';

describe('parseArgs', () => {
  it('parses --name value, --name=value, booleans and positionals', () => {
    const a = parseArgs(['--ats', 'lever,ashby', '--limit=5', '--verbose', '--no-color', 'pos', '--', '--literal']);
    expect(a.flags).toEqual({ ats: 'lever,ashby', limit: '5', verbose: true, color: false });
    expect(a._).toEqual(['pos', '--literal']);
  });

  it('last repeated flag wins', () => {
    expect(parseArgs(['--x', '1', '--x', '2']).flags['x']).toBe('2');
  });

  it('typed accessors validate', () => {
    const a = parseArgs(['--n', '7', '--mode', 'backfill', '--flag', 'false', '--list', 'a, b,,c']);
    expect(intFlag(a, 'n', 1)).toBe(7);
    expect(intFlag(a, 'missing', 3)).toBe(3);
    expect(() => intFlag(parseArgs(['--n', 'x']), 'n', 1)).toThrow(ArgError);
    expect(() => intFlag(parseArgs(['--n', '-1']), 'n', 1)).toThrow(ArgError);
    expect(enumFlag(a, 'mode', ['normal', 'backfill'], 'normal')).toBe('backfill');
    expect(() => enumFlag(parseArgs(['--mode', 'nope']), 'mode', ['normal'], 'normal')).toThrow(ArgError);
    expect(boolFlag(a, 'flag')).toBe(false);
    expect(boolFlag(parseArgs(['--flag']), 'flag')).toBe(true);
    expect(listFlag(a, 'list', [])).toEqual(['a', 'b', 'c']);
    expect(listFlag(a, 'none', ['z'])).toEqual(['z']);
    expect(stringFlag(a, 'mode')).toBe('backfill');
    expect(() => stringFlag(a, 'absent')).toThrow(ArgError);
    expect(stringFlag(a, 'absent', 'd')).toBe('d');
    expect(() => stringFlag(parseArgs(['--empty']), 'empty')).toThrow(ArgError);
  });
});
