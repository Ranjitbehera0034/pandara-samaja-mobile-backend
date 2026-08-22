// Odisha Police (police.odisha.gov.in) — verified directly (2026-08-22).
// Its recruitment widget's links carry a real `data-pdf` attribute with
// the actual PDF URL right on the element — no click/download-event
// dance needed at all (the visible href="#" is a red herring, a JS
// click handler reads data-pdf, but we don't need to trigger it).
//
// The site's TLS certificate doesn't verify (confirmed via direct curl
// AND Playwright — a real, current misconfiguration on their end, not
// an environment issue here) — ignoreHTTPSErrors is required to reach
// it at all. This is about a broken cert, not a bot-detection wall like
// UPSC's; the government content itself is fully public and reachable.
import { chromium } from 'playwright';
import { DiscoveredNotice } from '../types';

const ODISHA_POLICE_URL = 'https://police.odisha.gov.in/en/sun/recruitment';

export async function discoverOdishaPolice(isAlreadySeen: (sourceRef: string) => boolean, maxNew = 15): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const results: DiscoveredNotice[] = [];

  try {
    await page.goto(ODISHA_POLICE_URL, { waitUntil: 'networkidle', timeout: 30000 });

    const links = await page.locator('a.pdf-link').evaluateAll((els) =>
      els.map((e) => ({ text: (e.textContent || '').trim(), pdfUrl: e.getAttribute('data-pdf') || '' }))
    );

    for (const link of links) {
      if (results.length >= maxNew) break;
      if (!link.text || !link.pdfUrl) continue;

      const sourceRef = `odisha_police:${link.pdfUrl}`;
      if (isAlreadySeen(sourceRef)) continue;

      try {
        const response = await context.request.get(link.pdfUrl);
        if (!response.ok()) {
          console.error(`[odisha_police] Failed to fetch ${link.pdfUrl}: HTTP ${response.status()}`);
          continue;
        }
        const pdfBuffer = await response.body();
        results.push({ sourceRef, listingTitle: link.text, listingDate: undefined, pdfBuffer });
      } catch (err) {
        console.error(`[odisha_police] Failed to fetch ${link.pdfUrl}:`, (err as Error).message);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
