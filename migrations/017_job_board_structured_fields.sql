-- The job detail screen was cramming eligibility/deadline/fee into one
-- free-text description paragraph instead of showing them as distinct,
-- scannable fields. Splitting them out as their own columns.
--
-- TEXT, not DATE — dates come from OCR/scraped text (already-messy,
-- as-written strings, e.g. "13.09.2026 (23:59 hours)") or a manually
-- typed field on the submission forms, never a reliably parseable
-- machine format. Forcing a DATE type would mean either rejecting valid
-- input or silently mangling it; "display as written" already established
-- in scraper/src/structure.ts's own extraction philosophy.
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS eligibility TEXT;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS last_date TEXT;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS registration_start_date TEXT;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS application_fee TEXT;

ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS eligibility TEXT;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS last_date TEXT;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS registration_start_date TEXT;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS application_fee TEXT;
