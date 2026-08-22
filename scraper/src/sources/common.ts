// Shared discovery logic for the "click a notice, it triggers a real
// browser file download" pattern — used by OSSC, OPSC (ASP.NET
// __doPostBack links) and SSC (Angular click-handler rows, no href at
// all). Verified directly against each live site (not assumed) that
// clicking never navigates to a viewable PDF page — it always fires a
// `download` event (Content-Disposition: attachment). Playwright's
// `download` event on the originating page is the correct way to catch
// this in every case tested so far.
//
// Railway (rrbapply.gov.in) does NOT need this — its real notices are
// plain <a href="...pdf"> links, fetchable directly; see railway.ts.
import { chromium, Page } from 'playwright';
import { DiscoveredNotice } from '../types';

export interface ClickToDownloadConfig {
  sourcePrefix: string;
  url: string;
  rowSelector: string;
  titleSelector: string;
  dateSelector: string;
  linkSelector: string;
  // Derives the stable per-row identifier used for dedup (source_ref).
  // OSSC/OPSC use the ASP.NET control's own `id` attribute (stable,
  // unique). SSC has no such attribute on its Angular-rendered rows, so
  // it hashes the title text instead (stable as long as the notice
  // title doesn't change after publish, which these never do).
  extractId: (row: ReturnType<Page['locator']>, link: ReturnType<Page['locator']>) => Promise<string | null>;
}

export async function discoverByClickToDownload(
  config: ClickToDownloadConfig,
  isAlreadySeen: (sourceRef: string) => boolean,
  maxNew = 15
): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const results: DiscoveredNotice[] = [];

  try {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Server-rendered sites (OSSC/OPSC) have rows present immediately
    // after domcontentloaded; client-rendered ones (SSC's Angular SPA)
    // don't paint them until after hydration, and even then render the
    // list progressively — verified directly: waitForSelector alone
    // resolves as soon as the FIRST row exists, undercounting the rest
    // (read back 1 of 11 real rows in testing). The extra fixed wait
    // after it is a cruder "just give it a moment" fallback, but proved
    // reliable in the same testing where a pure selector-based wait
    // didn't. A no-op cost on sites where rows are already all present.
    await page.waitForSelector(config.rowSelector, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const rowCount = await page.locator(config.rowSelector).count();

    for (let i = 0; i < rowCount && results.length < maxNew; i++) {
      const row = page.locator(config.rowSelector).nth(i);
      const link = row.locator(config.linkSelector);
      const rawId = await config.extractId(row, link);
      if (!rawId) continue;

      const sourceRef = `${config.sourcePrefix}:${rawId}`;
      if (isAlreadySeen(sourceRef)) continue;

      const listingTitle = (await row.locator(config.titleSelector).first().innerText().catch(() => '')).trim();
      const listingDate = (await row.locator(config.dateSelector).first().innerText().catch(() => '')).trim();
      if (!listingTitle) continue;

      try {
        const pdfBuffer = await downloadPdf(page, link);
        if (pdfBuffer) {
          results.push({ sourceRef, listingTitle, listingDate, pdfBuffer });
        }
      } catch (err) {
        console.error(`[${config.sourcePrefix}] Failed to resolve PDF for ${sourceRef}:`, (err as Error).message);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

async function downloadPdf(page: Page, link: ReturnType<Page['locator']>): Promise<Buffer | null> {
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  // .first() — a source's linkSelector may resolve to more than one
  // element per row (e.g. SSC's comma-separated selector matches both
  // the clickable wrapper div and its inner text node); Playwright's
  // strict mode rejects an ambiguous .click() otherwise.
  await link.first().click();
  const download = await downloadPromise;
  if (!download) return null;

  const stream = await download.createReadStream();
  if (!stream) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
