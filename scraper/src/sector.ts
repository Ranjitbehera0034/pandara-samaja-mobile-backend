// scraper/src/sector.ts
// Best-effort sector classification for a government job notice — "under
// government we have banking, police, teacher, doctor etc" was the actual
// ask. Keys here must exactly match Pandara_mobile/src/data/jobSectors.ts
// (JOB_SECTORS[].key) since the mobile filter UI does an exact string
// match against job_postings.sector, not a fuzzy one.
//
// Title checked before organization: OPSC/SSC run recruitment for many
// professions at once (a "Lecturer" post and an "Ayurvedic Medical
// Officer" post can both come from Odisha Public Service Commission), so
// the specific role in the title is a stronger signal than the generic
// recruiting body issuing it. Organization is checked second for sources
// where it alone is unambiguous (a bank, Odisha Police, Railway
// Recruitment Board, AIIMS/a health mission, a named PSU).
//
// Same discipline as eligibility/dates elsewhere in this scraper: return
// undefined rather than force a confident-looking guess when nothing
// matches — an admin can set it by hand at approval time instead.
// Note: no trailing \b on words like "lecturer"/"teacher" — a plural
// ("Lecturers in Govt. College...", a real OPSC posting title) has no
// word boundary between "r" and "s", so a strict \bteacher\b would miss
// "Teachers". The leading \b is enough to avoid matching inside an
// unrelated longer word.
const TITLE_RULES: [RegExp, string][] = [
  [/medical officer|\bdoctors?\b|physician|surgeon|\bnurses?\b|nursing|pharmacist|\bhealth\b/i, 'Medical & Health'],
  [/\bteachers?|\blecturers?|\bprofessors?|\bprincipals?|education officer/i, 'Teaching & Education'],
  [/\bpolice\b|\bconstables?\b|\binspectors?\b|\bsi\/asi\b/i, 'Police & Defence'],
  [/\brailway\b/i, 'Railway'],
];

const ORGANIZATION_RULES: [RegExp, string][] = [
  [/\bpolice\b/i, 'Police & Defence'],
  [/\brailway\b/i, 'Railway'],
  [/\b(sbi|iob|bob|nbl|pfrda|iifcl|uiicl|bank|insurance)\b/i, 'Banking & Finance'],
  [/\baiims\b|health mission|\bnhm\b/i, 'Medical & Health'],
  [/\b(rrvun|rcf|\baai\b|iocl|gpcb|nmdfc)\b/i, 'Engineering & PSU'],
  [/public service commission|\bopsc\b|staff selection commission|\bssc\b|\bupsc\b/i, 'Administrative & Civil Services'],
];

export function classifySector(organization: string, title: string): string | undefined {
  for (const [pattern, sector] of TITLE_RULES) {
    if (pattern.test(title)) return sector;
  }
  for (const [pattern, sector] of ORGANIZATION_RULES) {
    if (pattern.test(organization)) return sector;
  }
  return undefined;
}
