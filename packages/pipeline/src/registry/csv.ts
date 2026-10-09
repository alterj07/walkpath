/**
 * Minimal RFC 4180 CSV reader/writer. Dependency-free on purpose (see CONTRIBUTING.md).
 *
 * - Fields may be quoted with double quotes; a quote inside a quoted field is doubled.
 * - Records are separated by LF or CRLF; a quoted field may span lines.
 * - The first record is the header; `parseCsv` returns one object per data row.
 */

export interface CsvTable {
  header: string[];
  rows: Record<string, string>[];
}

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = 'CsvError';
    this.line = line;
  }
}

/** Split CSV text into records of fields. Empty trailing record (file ends with newline) is dropped. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let i = 0;
  // Strip a UTF-8 BOM.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        // After a closing quote only a separator, newline or EOF may follow.
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvError('unexpected character after closing quote', line);
        }
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length !== 0) throw new CsvError('quote inside an unquoted field', line);
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      fields.push(field);
      records.push(fields);
      fields = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      i += 1;
      line += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) throw new CsvError('unterminated quoted field', line);
  if (field.length !== 0 || fields.length !== 0) {
    fields.push(field);
    records.push(fields);
  }
  // Drop records that are entirely empty (blank lines).
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parse CSV text with a header row into objects keyed by header name. */
export function parseCsv(text: string): CsvTable {
  const records = parseCsvRecords(text);
  const header = records[0];
  if (!header) return { header: [], rows: [] };
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r] as string[];
    if (rec.length !== header.length) {
      throw new CsvError(`expected ${header.length} fields, got ${rec.length}`, r + 1);
    }
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = rec[idx] as string;
    });
    rows.push(row);
  }
  return { header, rows };
}

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** Serialize rows to CSV text (LF line endings, trailing newline). Missing keys become empty fields. */
export function serializeCsv(header: readonly string[], rows: readonly Record<string, string | undefined>[]): string {
  const lines = [header.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => escapeField(row[h] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}
