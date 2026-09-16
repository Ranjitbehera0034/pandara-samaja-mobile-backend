// Best-effort parse of the free-text `last_date` field on job postings (see
// migration 017's comment: source text is OCR'd/hand-typed and never
// reliably machine-parseable in general) into a real Date, so it can drive
// the existing `expires_at`-based member visibility filter and deadline
// reminders without requiring every admin/scraper/member submission to
// separately fill in a structured date. Returns null when the text doesn't
// match a known pattern — callers must treat null as "can't derive, leave
// expires_at as-is", not "no expiry", since an admin may have set
// expires_at manually and independently of this text.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parseLastDateToExpiry(lastDate: string | null | undefined): Date | null {
  if (!lastDate) return null;
  const cleaned = lastDate.replace(/\(.*?\)/g, ' ').trim();

  const numeric = cleaned.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (numeric) {
    const [, d, mo, y] = numeric;
    const day = Number(d);
    const month = Number(mo);
    const year = Number(y);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(year, month - 1, day, 23, 59, 59);
      if (!isNaN(date.getTime())) return date;
    }
  }

  const named = cleaned.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)[,]?\s+(\d{4})/);
  if (named) {
    const [, d, monStr, y] = named;
    const idx = MONTHS.findIndex(m => m.startsWith(monStr.toLowerCase().slice(0, 3)));
    if (idx >= 0) {
      const date = new Date(Number(y), idx, Number(d), 23, 59, 59);
      if (!isNaN(date.getTime())) return date;
    }
  }

  return null;
}
