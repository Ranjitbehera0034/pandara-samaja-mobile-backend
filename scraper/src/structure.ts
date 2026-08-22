// Turns raw OCR'd notice text into structured fields — pure keyword/regex
// heuristics, no external API or model. Deliberately conservative on
// isVacancyNotice: OSSC/OPSC's "What's New" feed mixes real vacancy
// announcements with answer-keys, results, interview notices, and exam-
// schedule updates about EXISTING recruitments — a false positive here
// (flagging noise as a new job) is worse than a false negative (missing a
// real one an admin can still add by hand), so classification requires a
// clear positive signal AND no negative signal, favoring under-detection.
// Field extraction (eligibility/lastDate/applicationInfo) is best-effort
// against messy OCR text — every result still goes through admin review
// before publishing (see AdminJobSubmissionsScreen), which is the actual
// accuracy safety net, not this file.
import { DiscoveredNotice, StructuredJob } from './types';

const POSITIVE_TITLE_PATTERNS = [
  /invit(e|ing)\s+applications?/i,
  /recruitment\s+(to|of|for)\s+the\s+posts?/i,
  /\bvacanc(y|ies)\b/i,
  /engagement\s+of/i,
  /appointment\s+to\s+the\s+posts?/i,
  // Verified against a live OPSC notice: "Assistant Executive Engineer
  // (Civil) (Advt. No. 07 of 2026-27) - Advertisement Notice" is a real
  // new vacancy but matched none of the patterns above. "Advt. No." alone
  // isn't a safe signal (process-update notices about an EXISTING
  // advertisement also carry it, e.g. "Advt. No. 35... - Interview
  // Notice") — only the literal "Advertisement Notice" phrasing is.
  /advertisement\s+notice/i,
  // Railway (RRB): verified against a live notice, "CEN No. 04/2026
  // Recruitment for Various posts of Junior Engineer..." — doesn't match
  // the generic "recruitment ... the post(s)" pattern above ("various
  // posts of", not "the posts"). "CEN" (Centralized Employment Notice)
  // is distinctly Railway vocabulary, safe as its own signal. Note:
  // railway.ts's own VACANCY_LINK_PATTERN already pre-filters candidates
  // before they reach here — this is defense in depth, not the only gate.
  /CEN[\s-]?(?:No\.?)?\s*\d+.*recruit/i,
];

const NEGATIVE_TITLE_PATTERNS = [
  /answer\s*keys?/i,
  /\bresults?\b/i,
  /interview\s*(notice|call|letter)/i,
  /admit\s*card/i,
  /reject(ion)?\s*(list|notice)?/i,
  /merit\s*list/i,
  /corrigendum/i,
  /conduct\s+of.*examination/i,
  /postpone(ment)?/i,
  /cut[\s-]?off/i,
  /short\s*list/i,
  /\bschedule\b/i,
  /extension\s+of\s+(the\s+)?date/i,
];

const ORG_BY_SOURCE: Record<string, string> = {
  ossc: 'Odisha Staff Selection Commission',
  opsc: 'Odisha Public Service Commission',
  ssc: 'Staff Selection Commission',
  railway: 'Railway Recruitment Board',
};

const HOMEPAGE_BY_SOURCE: Record<string, string> = {
  ossc: 'https://ossc.gov.in',
  opsc: 'https://opsc.gov.in',
  ssc: 'https://ssc.gov.in',
  railway: 'https://www.rrbapply.gov.in',
};

export function structureNotice(rawText: string, notice: DiscoveredNotice, sourcePrefix: string): StructuredJob {
  const isVacancyNotice =
    POSITIVE_TITLE_PATTERNS.some((p) => p.test(notice.listingTitle)) &&
    !NEGATIVE_TITLE_PATTERNS.some((p) => p.test(notice.listingTitle));

  if (!isVacancyNotice) {
    return { isVacancyNotice: false };
  }

  const normalized = rawText.replace(/\s+/g, ' ').trim();

  return {
    isVacancyNotice: true,
    title: notice.listingTitle,
    organization: ORG_BY_SOURCE[sourcePrefix] || 'Government of India',
    description: buildDescription(normalized, notice),
    eligibility: extractAround(normalized, /eligibilit(y|ies)|educational\s+qualification/i),
    lastDate: extractAround(normalized, /last\s*date|closing\s*date|deadline/i),
    applicationInfo: extractApplicationInfo(normalized, sourcePrefix),
  };
}

// Captures ~180 chars around the first match of `pattern` — OCR text has
// no reliable paragraph structure to key off, so a fixed window around
// the keyword is the most robust option available without a real parser.
function extractAround(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return undefined;
  const start = Math.max(0, match.index - 20);
  const end = Math.min(text.length, match.index + 160);
  return text.slice(start, end).trim();
}

function extractApplicationInfo(text: string, sourcePrefix: string): string {
  const urlMatch = text.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) return urlMatch[0];

  const howToApply = extractAround(text, /how\s*to\s*apply|mode\s*of\s*application/i);
  if (howToApply) return howToApply;

  return `See the full notice on the ${sourcePrefix.toUpperCase()} website: ${HOMEPAGE_BY_SOURCE[sourcePrefix] || ''}`;
}

function buildDescription(normalized: string, notice: DiscoveredNotice): string {
  const snippet = normalized.slice(0, 500);
  return `${snippet}\n\n(Auto-extracted via OCR from an official ${notice.listingDate || ''} notice — verify details against the source before approving.)`.trim();
}
