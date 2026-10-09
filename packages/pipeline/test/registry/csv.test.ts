import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, parseCsvRecords, serializeCsv } from '../../src/registry/csv.ts';

describe('parseCsv', () => {
  it('parses a header and rows', () => {
    const t = parseCsv('a,b\n1,2\n3,4\n');
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles quoted fields with commas, doubled quotes and newlines, and CRLF', () => {
    const text = 'name,note\r\n"Acme, Inc.","She said ""hi""\nthen left"\r\nplain,\r\n';
    const t = parseCsv(text);
    expect(t.rows).toEqual([
      { name: 'Acme, Inc.', note: 'She said "hi"\nthen left' },
      { name: 'plain', note: '' },
    ]);
  });

  it('strips a BOM and skips blank lines', () => {
    expect(parseCsvRecords('﻿a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects ragged rows with the line number', () => {
    expect(() => parseCsv('a,b\n1,2,3\n')).toThrow(/line 2: expected 2 fields, got 3/);
  });

  it('rejects malformed quoting', () => {
    expect(() => parseCsvRecords('a,b\n"open,2\n')).toThrow(CsvError);
    expect(() => parseCsvRecords('a,b\nx"y,2\n')).toThrow(/quote inside an unquoted field/);
    expect(() => parseCsvRecords('a,b\n"x"y,2\n')).toThrow(/after closing quote/);
  });

  it('round-trips through serializeCsv', () => {
    const rows = [
      { a: 'plain', b: 'with, comma' },
      { a: 'with "quotes"', b: 'multi\nline' },
      { a: ' padded ', b: '' },
    ];
    const text = serializeCsv(['a', 'b'], rows);
    expect(text).toBe('a,b\nplain,"with, comma"\n"with ""quotes""","multi\nline"\n" padded ",\n');
    expect(parseCsv(text).rows).toEqual(rows);
  });

  it('serializes missing keys as empty fields', () => {
    expect(serializeCsv(['a', 'b'], [{ a: '1' }])).toBe('a,b\n1,\n');
  });
});
