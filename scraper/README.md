# Job scraper

Discovers new government vacancy PDF notices on OSSC and OPSC, extracts + structures them via Claude, and submits accepted ones into the main backend's `job_submissions` review queue (`POST /api/ingest/jobs`). Runs as a scheduled GitHub Action (`.github/workflows/job-scraper.yml`), not as part of the deployed Fastify server — kept standalone so the server stays lightweight.

**Nothing published here goes live automatically.** Every submission lands in the same admin review queue member submissions use (`AdminJobSubmissionsScreen` in the mobile app) — an admin still approves or rejects before it's visible to members or broadcasts a push notification.

## Setup

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env   # fill in BACKEND_URL, JOB_INGEST_KEY, ANTHROPIC_API_KEY
npm run scrape
```

## How it works

1. `sources/ossc.ts` / `sources/opsc.ts` (thin wrappers over `sources/common.ts`, since both government sites run the identical CMS template — verified directly against the live HTML) use Playwright to load the "What's New" listing and click each PDF link (`a.button_pdf`, an ASP.NET `__doPostBack` control — not a plain URL, so a headless browser has to actually click it and capture where that navigates).
2. `extract.ts` pulls text via `pdf-parse`; if that comes back too short (a scanned/image PDF), falls back to OCR via `tesseract.js`.
3. `structure.ts` sends the extracted text to Claude with a strict-JSON prompt, including an `isVacancyNotice` field — the "What's New" feed on both sites mixes real vacancy announcements with answer keys, interview notices, and results, and this is what filters those out.
4. `submit.ts` POSTs accepted notices to the backend, tagged with a `sourceRef` (e.g. `ossc:generic_masterpage1_ctl31`) whose `UNIQUE` constraint on `job_submissions.source_ref` is the actual dedup mechanism — a repeat submission for an already-seen notice just gets a 409 and is skipped.

## Known limitations (real, not hypothetical — verified end-to-end against the live OSSC site on 2026-08-18)

- **OCR is the PRIMARY extraction path for this source, not a rare fallback.** Tested directly against two real OSSC notices: `pdf-parse` extracted **zero characters of text** from both — these PDFs aren't standard extractable text (likely a non-standard font/glyph encoding some government PDF generators use), so the `tesseract.js` OCR path runs on essentially every notice. Budget accordingly (OCR is the slow, imprecise part of this pipeline).
- **OCR output has real, visible errors** — e.g. "Mathematics" read as "Mathematies", digit/spacing corruption in reference numbers and dates. This directly threatens the one field that matters most for not misleading an applicant: `lastDate`. The structuring prompt in `structure.ts` is told to use the deadline "as written" rather than reformat it, but if OCR itself misread a digit, the LLM has no way to know. **This is exactly why OCR output lands in the admin review queue instead of auto-publishing** — a human should sanity-check the deadline/eligibility against the actual PDF (linked or attached) before approving, not just skim the auto-filled description.
- **Site fragility**: the exact selectors (`a.button_pdf`, `.content_title`, `.datebox`) were verified against the live HTML on 2026-08-18, but either government site can change its page structure at any time without notice, silently breaking discovery. There's no alerting in v1 for "found zero new notices for N days" — check the Action's run history periodically.
- **PDF resolution mechanism, verified**: clicking `a.button_pdf` does NOT navigate to a viewable PDF page — it fires a real browser file download (`Content-Disposition: attachment`). `sources/common.ts` listens for Playwright's `download` event and reads the bytes via `download.createReadStream()`. Confirmed working against two live notices (`%PDF` magic bytes, correct sizes).
- **Scope is OSSC + OPSC only** — the two sites actually inspected. Adding another department means repeating the discovery-selector verification for that site's own structure.
