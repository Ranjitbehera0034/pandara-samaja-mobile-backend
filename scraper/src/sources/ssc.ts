// SSC's homepage "Notice Board" (Angular SPA, verified directly
// 2026-08-18) has no real <a href> on its notice rows at all — clicking
// the row's .rightSection.cp div fires an Angular click handler that
// triggers a genuine browser file download, same underlying mechanism
// as OSSC/OPSC's postback links (see common.ts). No stable id attribute
// exists on these rows, so the dedup identifier hashes title+date
// instead (titles don't change after a notice is published). Title
// alone isn't enough — verified directly: two distinct notices on the
// same day both titled just "Important Notice" hash-collided in initial
// testing, silently dropping the second one as "already seen."
// Title+date isn't a mathematical guarantee either, but no same-day,
// same-title collision has been observed with it added.
//
// Real, measured caveat: SSC's day-to-day Notice Board is dominated by
// process updates for recruitments already announced (answer keys,
// exam schedules, corrigenda, allocation results) — genuinely new
// vacancy announcements are comparatively rare (SSC runs only ~5-6 major
// recruitment cycles a year: CGL, CHSL, MTS, JE, Selection Posts,
// Stenographer). Expect this source to process a lot of noise for
// relatively few real hits — that's inherent to how SSC publishes, not
// a bug in the classifier.
import * as crypto from 'crypto';
import { discoverByClickToDownload } from './common';
import { DiscoveredNotice } from '../types';

const SSC_URL = 'https://ssc.gov.in';

export function discoverSsc(isAlreadySeen: (sourceRef: string) => boolean): Promise<DiscoveredNotice[]> {
  return discoverByClickToDownload(
    {
      sourcePrefix: 'ssc',
      url: SSC_URL,
      rowSelector: '.innerCard',
      titleSelector: '.rightSection.cp .text, .text',
      dateSelector: '.dateBox',
      linkSelector: '.rightSection.cp, .text',
      extractId: async (row, link) => {
        const title = (await link.first().innerText().catch(() => '')).trim();
        if (!title) return null;
        const date = (await row.locator('.dateBox').first().innerText().catch(() => '')).trim();
        return crypto.createHash('sha1').update(`${title}|${date}`).digest('hex').slice(0, 16);
      },
    },
    isAlreadySeen
  );
}
