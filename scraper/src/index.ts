// Entry point — run via `npm run scrape` (or the GitHub Action). For each
// source: fetch already-ingested source_refs, discover new notices, extract
// text (OCR — see extract.ts), structure via keyword/regex heuristics (see
// structure.ts), submit vacancy notices into the backend's job_submissions
// review queue. Non-vacancy items (answer keys, results, etc.) and
// extraction failures are logged and skipped, never crash the whole run —
// one bad notice shouldn't block the rest.
import 'dotenv/config';
import { discoverOssc } from './sources/ossc';
import { discoverOpsc } from './sources/opsc';
import { discoverSsc } from './sources/ssc';
import { discoverRailway } from './sources/railway';
import { extractText } from './extract';
import { structureNotice } from './structure';
import { fetchSeenSourceRefs, submitJob } from './submit';
import { DiscoveredNotice } from './types';

const SOURCES: { name: string; discover: (isSeen: (ref: string) => boolean) => Promise<DiscoveredNotice[]> }[] = [
  { name: 'ossc', discover: discoverOssc },
  { name: 'opsc', discover: discoverOpsc },
  { name: 'ssc', discover: discoverSsc },
  { name: 'railway', discover: discoverRailway },
];

async function run() {
  let submitted = 0;
  let skipped = 0;

  for (const source of SOURCES) {
    console.log(`\n[${source.name}] Fetching already-ingested source_refs...`);
    const seen = await fetchSeenSourceRefs(source.name);
    console.log(`[${source.name}] ${seen.size} already ingested`);

    console.log(`[${source.name}] Discovering new notices...`);
    const notices = await source.discover((ref) => seen.has(ref));
    console.log(`[${source.name}] Found ${notices.length} new notice(s)`);

    for (const notice of notices) {
      try {
        console.log(`[${source.name}] Processing ${notice.sourceRef}: "${notice.listingTitle}"`);
        const text = await extractText(notice.pdfBuffer);
        const structured = structureNotice(text, notice, source.name);

        if (!structured.isVacancyNotice) {
          console.log(`[${source.name}] Skipping ${notice.sourceRef} — not a vacancy notice`);
          skipped++;
          continue;
        }

        const ok = await submitJob(structured, notice.sourceRef, notice.listingTitle);
        if (ok) {
          console.log(`[${source.name}] Submitted ${notice.sourceRef}`);
          submitted++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[${source.name}] Failed processing ${notice.sourceRef}:`, (err as Error).message);
        skipped++;
      }
    }
  }

  console.log(`\nDone. Submitted: ${submitted}, skipped: ${skipped}`);
}

run().catch((err) => {
  console.error('[scraper] Fatal error:', err);
  process.exit(1);
});
