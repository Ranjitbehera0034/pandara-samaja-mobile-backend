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
