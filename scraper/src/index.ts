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
import { discoverNhm } from './sources/nhm';
import { discoverOdishaPolice } from './sources/odishaPolice';
import { discoverIbps } from './sources/ibps';
import { extractText } from './extract';
import { structureNotice } from './structure';
import { fetchSeenSourceRefs, submitJob } from './submit';
import { DiscoveredNotice } from './types';

const SOURCES: { name: string; discover: (isSeen: (ref: string) => boolean) => Promise<DiscoveredNotice[]> }[] = [
  { name: 'ossc', discover: discoverOssc },
  { name: 'opsc', discover: discoverOpsc },
  { name: 'ssc', discover: discoverSsc },
  { name: 'railway', discover: discoverRailway },
  { name: 'nhm', discover: discoverNhm },
  { name: 'odisha_police', discover: discoverOdishaPolice },
  { name: 'ibps', discover: discoverIbps },
];

async function run() {
  let submitted = 0;
  let skipped = 0;
  const failedSources: string[] = [];

  for (const source of SOURCES) {
    try {
      console.log(`\n[${source.name}] Fetching already-ingested source_refs...`);
      const seen = await fetchSeenSourceRefs(source.name);
      console.log(`[${source.name}] ${seen.size} already ingested`);

      console.log(`[${source.name}] Discovering new notices...`);
      const notices = await source.discover((ref) => seen.has(ref));
      console.log(`[${source.name}] Found ${notices.length} new notice(s)`);

      for (const notice of notices) {
        try {
          console.log(`[${source.name}] Processing ${notice.sourceRef}: "${notice.listingTitle}"`);
          // IBPS's data is already structured plain text on the page, no
          // PDF at all — skip OCR/keyword-classification entirely for it.
          const structured = notice.structuredOverride
            ?? structureNotice(await extractText(notice.pdfBuffer), notice, source.name);

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
    } catch (err) {
      // A single source's site being down/slow/rate-limiting (the govt
      // sites here time out often, and not always the same one) must
      // never take down the sources after it in the list — this loop is
      // the only thing standing between one bad `page.goto` and the
      // whole daily run submitting nothing at all.
      console.error(`[${source.name}] Source failed, skipping:`, (err as Error).message);
      failedSources.push(source.name);
    }
  }

  console.log(`\nDone. Submitted: ${submitted}, skipped: ${skipped}, failed sources: ${failedSources.join(', ') || 'none'}`);
  if (failedSources.length > 0) {
    // Non-zero exit so a persistently broken source is still visible in
    // the Action's status, without preventing the other sources' notices
    // (already submitted above) from going through.
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('[scraper] Fatal error:', err);
  process.exit(1);
});
