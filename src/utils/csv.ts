// Minimal CSV serializer — no external dependency needed for this app's
// export sizes (a few thousand rows at most).
export interface CsvColumn {
  key: string;
  header: string;
}

const escapeCsvValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const toCsv = (rows: Record<string, unknown>[], columns: CsvColumn[]): string => {
  const header = columns.map((c) => escapeCsvValue(c.header)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escapeCsvValue(row[c.key])).join(','))
    .join('\r\n');
  return `${header}\r\n${body}`;
};
