// Railway (rrbapply.gov.in) is structurally simpler than the others:
// verified directly (2026-08-18) that its real vacancy notices are
// plain <a href="...pdf"> links, fetchable with a direct HTTP GET — no
// postback, no click-triggered download event needed.
//
// Real, measured caveat: the site's PDF links are a mix of genuine
// recruitment notices (e.g. "CEN No. 04/2026 Recruitment for Various
// posts of Junior Engineer...") and unrelated supporting-document
// templates for exams already underway (caste/OBC/EWS certificate
// formats, FAQ sheets, corrigenda) — the title-pattern filter below is
// what separates them; a link whose visible text doesn't look like a
// fresh recruitment announcement is skipped before ever being
// downloaded, so the OCR/classification pipeline isn't wasted on forms.
import { chromium } from 'playwright';
import { DiscoveredNotice } from '../types';

const RAILWAY_URL = 'https://www.rrbapply.gov.in';

// Matches link text like "CEN No. 04/2026 Recruitment for..." or
// "CEN-03/2026 Recruitment of...". Deliberately requires both the CEN
// reference AND "recruit" — a bare "CEN 03/2026" heading link (the
// section divider, not the actual notice) or a bare form/FAQ title
// won't match both.
const VACANCY_LINK_PATTERN = /CEN[\s-]?(?:No\.?)?\s*\d+[\/-]\d{4}.*recruit/i;

export async function discoverRailway(isAlreadySeen: (sourceRef: string) => boolean, maxNew = 15): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const results: DiscoveredNotice[] = [];

  try {
    await page.goto(RAILWAY_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const links = await page.locator('a[href$=".pdf"]').evaluateAll((els) =>
      els.map((e) => ({ text: (e.textContent || '').trim(), href: e.getAttribute('href') || '' }))
    );

    const candidates = links.filter((l) => VACANCY_LINK_PATTERN.test(l.text) && l.href);

    for (const candidate of candidates) {
      if (results.length >= maxNew) break;

      const absoluteUrl = new URL(candidate.href, RAILWAY_URL).toString();
      // The href itself (not a generated id) is the stable identifier —
      // Railway's file paths don't change once published.
      const sourceRef = `railway:${candidate.href}`;
      if (isAlreadySeen(sourceRef)) continue;

      try {
        const response = await context.request.get(absoluteUrl);
        if (!response.ok()) {
          console.error(`[railway] Failed to fetch ${absoluteUrl}: HTTP ${response.status()}`);
          continue;
        }
        const pdfBuffer = await response.body();
        results.push({ sourceRef, listingTitle: candidate.text, listingDate: undefined, pdfBuffer });
      } catch (err) {
        console.error(`[railway] Failed to fetch ${absoluteUrl}:`, (err as Error).message);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
