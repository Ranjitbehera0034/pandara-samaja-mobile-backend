// IBPS (Institute of Banking Personnel Selection) — structurally
// different from every other source in this pipeline, verified directly
// (2026-08-22): its homepage "current openings" widget lists real,
// currently-active recruitment drives (AAI, AIIMS, SBI, IOB, RRVUN, BOB,
// and other public-sector organizations IBPS conducts selection for) as
// plain structured text — organization, post title, and registration
// date all inside one <a> tag's innerText, no PDF at all, linking
// straight to that drive's own application portal
// (ibpsreg.ibps.in/<slug>/). Nothing to OCR or extract here.
//
// Because this widget only ever shows genuinely active openings (not a
// "what's new" feed mixing in answer-keys/results/etc like the other
// sources), every parsed card is treated as a real vacancy directly —
// no keyword classification needed or attempted.
import { chromium } from 'playwright';
import { DiscoveredNotice } from '../types';

const IBPS_URL = 'https://www.ibps.in';

interface IbpsCard {
  organization: string;
  postTitle: string;
  registrationDate: string;
  applyUrl: string;
}

function parseCard(text: string, href: string): IbpsCard | null {
  const parts = text.split('\n').map((p) => p.trim()).filter(Boolean);
  // Expected shape: [Organization, Post title, "Registration From", date]
  if (parts.length < 4) return null;
  const [organization, postTitle, , registrationDate] = parts;
  if (!organization || !postTitle || !registrationDate) return null;
  return { organization, postTitle, registrationDate, applyUrl: href };
}

export async function discoverIbps(isAlreadySeen: (sourceRef: string) => boolean, maxNew = 15): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results: DiscoveredNotice[] = [];
  const seenThisRun = new Set<string>();

  try {
    await page.goto(IBPS_URL, { waitUntil: 'networkidle', timeout: 30000 });

    const rawCards = await page.locator('a').evaluateAll((els) =>
      els
        .filter((e) => /ibpsreg\.ibps\.in/i.test(e.getAttribute('href') || ''))
        .map((e) => ({ text: (e as HTMLElement).innerText, href: e.getAttribute('href') || '' }))
    );

    for (const raw of rawCards) {
      if (results.length >= maxNew) break;
      if (seenThisRun.has(raw.href)) continue; // the widget repeats some cards in a "latest" + "all" section
      seenThisRun.add(raw.href);

      const card = parseCard(raw.text, raw.href);
      if (!card) continue;

      const sourceRef = `ibps:${card.applyUrl}`;
      if (isAlreadySeen(sourceRef)) continue;

      results.push({
        sourceRef,
        listingTitle: `${card.organization} — ${card.postTitle}`,
        listingDate: card.registrationDate,
        pdfBuffer: Buffer.alloc(0), // unused — structuredOverride bypasses extraction
        structuredOverride: {
          isVacancyNotice: true,
          title: card.postTitle,
          organization: card.organization,
          description: `${card.organization}: ${card.postTitle}. Registration from ${card.registrationDate}.`,
          applicationInfo: card.applyUrl,
        },
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}
