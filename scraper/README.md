# Job scraper

Discovers new government vacancy notices across seven sources (OSSC, OPSC, SSC, Railway RRB, NHM Odisha, Odisha Police, IBPS), extracts + structures them via local keyword/regex heuristics (no external API), and submits accepted ones into the main backend's `job_submissions` review queue (`POST /api/ingest/jobs`). Runs as a scheduled GitHub Action (`.github/workflows/job-scraper.yml`), not as part of the deployed Fastify server — kept standalone so the server stays lightweight.

**Nothing published here goes live automatically.** Every submission lands in the same admin review queue member submissions use (`AdminJobSubmissionsScreen` in the mobile app) — an admin still approves or rejects before it's visible to members or broadcasts a push notification.

## Setup

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env   # fill in BACKEND_URL, JOB_INGEST_KEY
npm run scrape
```

## Sources

| Source | Site structure | Discovery mechanism |
|---|---|---|
| **OSSC** | ASP.NET, server-rendered | Click a `__doPostBack` link, capture the resulting file download |
| **OPSC** | Identical CMS to OSSC (verified — same template) | Same as OSSC |
| **SSC** | Angular SPA, client-rendered | Click a JS-handled div (no real `href` at all), capture the resulting file download |
| **Railway (RRB)** | Plain server-rendered links | Direct `<a href="...pdf">` — fetched with a plain HTTP GET, no click needed |
| **NHM Odisha** | WordPress, server-rendered | Direct `<a href="...pdf">`, same as Railway |
| **Odisha Police** | Server-rendered, `data-pdf` attribute holds the real URL | Direct fetch of `data-pdf` — no click needed at all, not even a real `href` to follow |
| **IBPS** | Structured HTML directly on the page, no PDF | Parses organization/post/date/apply-link straight from the DOM — no OCR, no classification (see below) |

**UPSC was investigated and explicitly excluded.** Its site is actively blocked by an Akamai WAF — even a real headless browser gets an "Access Denied" response, not just a JS-required wall. Getting past that would mean deliberately evading an anti-bot measure, a different and more adversarial thing than what every other source here needed (none of them have any bot protection at all). Not attempted.

**Odisha Police's TLS certificate doesn't verify** — confirmed real and current (not an environment quirk), the source's `newContext({ ignoreHTTPSErrors: true })` works around it. The content itself is fully public; this is about a broken cert, not a security concern to route around carefully.

## How it works

1. `sources/ossc.ts` / `sources/opsc.ts` / `sources/ssc.ts` share `sources/common.ts`'s `discoverByClickToDownload` — parameterized by CSS selectors and an `extractId` function per source, since each site's DOM differs (OSSC/OPSC key off the ASP.NET control's stable `id`; SSC has no such attribute, so it hashes title+date instead — title alone collided on two different same-day notices both literally titled "Important Notice," confirmed in testing). `sources/railway.ts` and `sources/nhm.ts` are simpler — their PDFs are plain hrefs, no click/download-event dance needed. `sources/odishaPolice.ts` is simpler still — the real PDF URL sits right on the element as a `data-pdf` attribute, no click and no href to follow at all.
2. `extract.ts` pulls text via `pdf-parse`; if that comes back too short (verified: OSSC/OPSC/SSC notices are NOT standard extractable-text PDFs — `pdf-parse` returns zero characters from real notices), falls back to OCR via `tesseract.js`. Railway's and NHM's PDFs, by contrast, extract cleanly — no OCR needed there in testing.
3. `structure.ts` classifies and extracts fields via local keyword/regex patterns — an `isVacancyNotice` gate (conservative: requires a clear positive signal like "vacancy"/"recruitment to the post"/a source-specific pattern, AND no negative signal like "answer key"/"corrigendum"/"interview notice") filters out the process-update noise every one of these "what's new" feeds mixes in with real vacancy announcements, plus best-effort extraction of eligibility/deadline/how-to-apply from the raw text.
4. **`sources/ibps.ts` is architecturally different from the rest** — IBPS's homepage lists currently-active recruitment drives as plain structured text (organization, post title, registration date, application link) directly in the DOM, no PDF at all. It builds a `StructuredJob` directly via `DiscoveredNotice.structuredOverride`, which `index.ts` checks first and uses in place of the OCR+classify path entirely when present — every parsed IBPS card is treated as a real vacancy without keyword classification, since the widget itself only ever shows genuinely active openings, not a noisy "what's new" feed.
5. `submit.ts` POSTs accepted notices to the backend, tagged with a `sourceRef` (e.g. `ossc:generic_masterpage1_ctl31`, `railway:/assets/forms/CEN_04_2026_JE.pdf`, `ssc:<hash>`, `ibps:https://ibpsreg.ibps.in/aaioct25/`) whose `UNIQUE` constraint on `job_submissions.source_ref` is the actual dedup mechanism — a repeat submission for an already-seen notice just gets a 409 and is skipped.

## Known limitations (real, not hypothetical — verified end-to-end against every live site, 2026-08-18/22)

- **OCR is the PRIMARY extraction path for OSSC/OPSC/SSC, not a rare fallback.** `pdf-parse` extracted zero characters from real notices on all three (non-standard font/glyph encoding some government PDF generators use). Railway's PDFs, by contrast, extract cleanly with `pdf-parse` — no OCR needed there in testing.
- **OCR output has real, visible errors** — e.g. "Mathematics" read as "Mathematies", digit/spacing corruption in reference numbers and dates. This directly threatens the one field that matters most for not misleading an applicant: `lastDate`. **This is exactly why OCR output lands in the admin review queue instead of auto-publishing** — a human should sanity-check the deadline/eligibility against the actual PDF before approving, not just skim the auto-filled description.
- **SSC's real vacancy hit rate is low.** Its day-to-day Notice Board is dominated by process updates for already-announced recruitments (answer keys, exam schedules, corrigenda, allocation results) — genuinely new vacancy announcements are comparatively rare (SSC runs only ~5-6 major recruitment cycles a year). Expect this source to process a lot of noise for relatively few real hits — that's inherent to how SSC publishes, not a bug in the classifier.
- **Site fragility, all four sources**: exact selectors were verified against live HTML on the dates above, but any of these sites can change their page structure at any time without notice, silently breaking discovery. There's no alerting in v1 for "found zero new notices for N days" — check the Action's run history periodically.
- **SSC's Angular hydration timing is a proven-fragile area**: `discoverByClickToDownload` waits for the row selector to appear, then an additional fixed 2-second settle delay, because SSC renders its notice list progressively after the first row exists — a pure `waitForSelector` undercounted 11 real rows down to 1 in testing. If SSC's rendering gets slower, this fixed delay may need lengthening.
- **Geo/network blocking is a real, only-partially-understood risk.** `ssc.nic.in` (an old SSC domain, not the current `ssc.gov.in`) was completely unreachable (TCP connection timeout) from the machine this was developed on — whether that's IP-range blocking, a dead domain, or something else wasn't fully diagnosed, and it's unknown whether the GitHub Actions runner's IP range will behave differently for any of these four sources. Worth checking the first few scheduled runs' logs closely rather than assuming success.
- **NHM Odisha's real vacancy hit rate is also low, and for a different reason than SSC's.** Its titles are terse internal abbreviations ("Notice-Engagement of Members-MAC-SAFU-SHAS," "Walk-in-Interview-SHAS-Advt No-01-26" — SHAS/SHSRC are internal scheme names, never spelled out) that the generic keyword classifier has comparatively little to work with.
- **Odisha Police's genuinely-new-vacancy detection needed a real pattern fix, found via live testing.** "Advertisement for the recruitment of Ex-Servicemen (Navy/Coastguard Personnel) as Technical Staff..." — a real, current vacancy — didn't match any positive pattern until `advertisement for (the) recruitment` was added specifically because of this case. A reminder that the classifier's pattern list is empirically built from real misses, not designed upfront to be complete.
- **IBPS has a materially different risk profile from every other source**: since `structuredOverride` skips `isVacancyNotice` classification entirely, if IBPS's homepage widget structure changes to also show non-vacancy content (e.g. a "closed" or "results" section gets added to the same widget), everything on it would still be submitted as a vacancy. This is currently safe only because the widget was verified to show exclusively active openings — re-verify this assumption if the site's layout changes.
- **Scope is OSSC, OPSC, SSC, Railway, NHM Odisha, Odisha Police, and IBPS.** UPSC was investigated and excluded (see above). Adding another department/board means repeating this same real-verification work — assume nothing about a new site's structure without checking the live HTML/DOM first, the same way every source here was actually built (several assumptions made before checking a new site directly turned out wrong once actually tested — that's the norm, not the exception, for this kind of work).
