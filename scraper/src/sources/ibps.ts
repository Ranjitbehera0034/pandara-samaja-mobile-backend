// IBPS (Institute of Banking Personnel Selection) — structurally
// different from every other source in this pipeline, verified directly
// (2026-08-22): its homepage "current openings" widget lists real,
// currently-active recruitment drives (AAI, AIIMS, SBI, IOB, RRVUN, BOB,
// and other public-sector organizations IBPS conducts selection for) as
// plain structured text — organization, post title, and registration
// date all inside one <a> tag's innerText, no PDF at all, linking
// straight to that drive's own application portal
// (ibpsreg.ibps.in/<slug>/). Nothing to OCR here.
//
// Because this widget only ever shows genuinely active openings (not a
// "what's new" feed mixing in answer-keys/results/etc like the other
// sources), every parsed card is treated as a real vacancy directly —
// no keyword classification needed or attempted.
//
// Each drive's own registration page has a real, clean "Important
// Events" HTML table (verified directly against ibpsreg.ibps.in/iocljun26/)
// with registration start + closure dates — one extra page load per
// card to pull those in as proper fields instead of leaving them blank.
// Fee amount and eligibility are NOT on this page — they're inside a
// linked PDF behind an obfuscated, possibly session-tied URL
// (loadpdf.php?file=...&t=...); not chased down, scope stops at what's
// cleanly available on the registration page itself.
import { chromium, BrowserContext } from 'playwright';
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

interface ImportantDates {
  registrationStartDate?: string;
  lastDate?: string;
}

async function fetchImportantDates(context: BrowserContext, applyUrl: string): Promise<ImportantDates> {
  const page = await context.newPage();
  try {
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 20000 });
    const rows = await page.locator('table tr').evaluateAll((els) =>
      els.map((e) => Array.from(e.querySelectorAll('td,th')).map((td) => (td.textContent || '').trim()))
    );

    let registrationStartDate: string | undefined;
    let lastDate: string | undefined;
    for (const row of rows) {
      if (row.length < 2) continue;
      const [label, value] = row;
      if (!registrationStartDate && /commencement\s+of.*registration/i.test(label)) registrationStartDate = value;
      if (!lastDate && /closure\s+of\s+registration/i.test(label)) lastDate = value;
    }
    return { registrationStartDate, lastDate };
  } catch (err) {
    console.error(`[ibps] Failed to fetch important dates from ${applyUrl}:`, (err as Error).message);
    return {};
  } finally {
    await page.close();
  }
}

export async function discoverIbps(isAlreadySeen: (sourceRef: string) => boolean, maxNew = 15): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
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

      const dates = await fetchImportantDates(context, card.applyUrl);

      results.push({
        sourceRef,
        listingTitle: `${card.organization} — ${card.postTitle}`,
        listingDate: card.registrationDate,
        pdfBuffer: Buffer.alloc(0), // unused — structuredOverride bypasses extraction
        structuredOverride: {
          isVacancyNotice: true,
          title: card.postTitle,
          organization: card.organization,
          description: `${card.organization}: ${card.postTitle}.`,
          registrationStartDate: dates.registrationStartDate || card.registrationDate,
          lastDate: dates.lastDate,
          applicationInfo: card.applyUrl,
        },
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}
