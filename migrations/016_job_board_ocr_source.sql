-- Supports automated government-vacancy ingestion (scraper/ GitHub Action):
-- OCR-sourced submissions have no submitting member, so membership_no must
-- become nullable (submitter_name/submitter_mobile were already nullable).
-- source_ref identifies the originating notice (e.g. 'ossc:<postback-id>')
-- and its UNIQUE constraint IS the dedup mechanism — a repeat ingestion
-- attempt for an already-seen notice fails the insert rather than creating
-- a duplicate pending submission.
ALTER TABLE job_submissions ALTER COLUMN membership_no DROP NOT NULL;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS source_ref TEXT UNIQUE;
