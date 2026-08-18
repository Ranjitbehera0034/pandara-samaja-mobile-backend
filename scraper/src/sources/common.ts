// Shared discovery logic for OSSC and OPSC — both run the same Odisha
// government CMS template (verified directly against the live HTML, not
// assumed): each "What's New" row is an <li> containing
// .listing_content .content_title (notice title), .listing_date .datebox
// (date), and .listing_action a.button_pdf (the PDF trigger — an ASP.NET
// __doPostBack link, not a plain href).
//
// Verified directly (2026-08-18) that clicking it doesn't navigate the
// page/open a viewable PDF page at all — it fires a real browser file
// download (Content-Disposition: attachment). Playwright's `download`
// event on the originating page is the correct way to catch this; the
// popup window this also opens stays on about:blank and is a red herring.
import { chromium, Page } from 'playwright';
import { DiscoveredNotice } from '../types';

const ROW_SELECTOR = 'li:has(a.button_pdf)';

export async function discoverNotices(
  sourcePrefix: string,
  url: string,
  isAlreadySeen: (sourceRef: string) => boolean,
  maxNew = 15
): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const results: DiscoveredNotice[] = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const rowCount = await page.locator(ROW_SELECTOR).count();

    for (let i = 0; i < rowCount && results.length < maxNew; i++) {
      const row = page.locator(ROW_SELECTOR).nth(i);
      const link = row.locator('a.button_pdf');
      const controlId = await link.getAttribute('id');
      if (!controlId) continue;

      const sourceRef = `${sourcePrefix}:${controlId}`;
      if (isAlreadySeen(sourceRef)) continue;

      const listingTitle = (await row.locator('.content_title').first().innerText().catch(() => '')).trim();
      const listingDate = (await row.locator('.datebox').first().innerText().catch(() => '')).trim();
      if (!listingTitle) continue;

      try {
        const pdfBuffer = await downloadPdf(page, link);
        if (pdfBuffer) {
          results.push({ sourceRef, listingTitle, listingDate, pdfBuffer });
        }
      } catch (err) {
        console.error(`[${sourcePrefix}] Failed to resolve PDF for ${sourceRef}:`, (err as Error).message);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

async function downloadPdf(page: Page, link: any): Promise<Buffer | null> {
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await link.click();
  const download = await downloadPromise;
  if (!download) return null;

  const stream = await download.createReadStream();
  if (!stream) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
