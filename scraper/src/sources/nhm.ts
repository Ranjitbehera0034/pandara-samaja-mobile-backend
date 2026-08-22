// NHM Odisha (National Health Mission) — verified directly (2026-08-22):
// a plain WordPress site, real <a href="...pdf"> links on the homepage's
// "Notifications" list, no click/download-event trickery needed at all
// (same shape as railway.ts).
//
// Real, measured caveat: titles here are terse internal abbreviations
// ("Notice-Engagement of Members-MAC-SAFU-SHAS", "Walk-in-Interview-
// SHAS-Advt No-01-26" — SHAS/SHSRC are internal scheme/program names,
// not spelled out), unlike OSSC/OPSC/Railway's fuller descriptive
// titles. structure.ts's generic keyword classifier has less to work
// with here and may under-detect real openings more than on other
// sources — a known accuracy gap, not something this file works around.
import { chromium } from 'playwright';
import { DiscoveredNotice } from '../types';

const NHM_URL = 'https://nhmodisha.gov.in';

export async function discoverNhm(isAlreadySeen: (sourceRef: string) => boolean, maxNew = 15): Promise<DiscoveredNotice[]> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const results: DiscoveredNotice[] = [];

  try {
    await page.goto(NHM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const links = await page.locator('a[href$=".pdf"]').evaluateAll((els) =>
      els.map((e) => ({ text: (e.textContent || '').trim(), href: e.getAttribute('href') || '' }))
    );

    for (const link of links) {
      if (results.length >= maxNew) break;
      if (!link.text || !link.href) continue;

      const sourceRef = `nhm:${link.href}`;
      if (isAlreadySeen(sourceRef)) continue;

      try {
        const response = await context.request.get(link.href);
        if (!response.ok()) {
          console.error(`[nhm] Failed to fetch ${link.href}: HTTP ${response.status()}`);
          continue;
        }
        const pdfBuffer = await response.body();
        results.push({ sourceRef, listingTitle: link.text, listingDate: undefined, pdfBuffer });
      } catch (err) {
        console.error(`[nhm] Failed to fetch ${link.href}:`, (err as Error).message);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
