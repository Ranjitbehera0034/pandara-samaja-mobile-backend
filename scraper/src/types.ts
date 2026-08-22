// A single "What's New" row discovered on a notices page, before we know
// whether it's actually a vacancy notice (answer keys, results, interview
// notices show up in the same feed — structure.ts filters those out).
export interface DiscoveredNotice {
  // e.g. 'ossc:generic_masterpage1_ctl31' — stable per listing row (the
  // ASP.NET postback control's own id), doubles as job_submissions.source_ref.
  sourceRef: string;
  listingTitle: string;
  listingDate?: string;
  pdfBuffer: Buffer;
  // Set only by sources whose vacancy data is already structured HTML on
  // the page itself (IBPS: organization/post/date/apply-link are all
  // plain text, no PDF at all) — when present, index.ts uses this
  // directly and skips extractText()/structureNotice() entirely.
  // pdfBuffer is unused (an empty placeholder) for these.
  structuredOverride?: StructuredJob;
}

export interface StructuredJob {
  isVacancyNotice: boolean;
  title?: string;
  organization?: string;
  description?: string;
  location?: string;
  eligibility?: string;
  lastDate?: string;
  applicationInfo?: string;
}
