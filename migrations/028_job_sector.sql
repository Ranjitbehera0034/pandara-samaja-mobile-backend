-- Job sector — a coarse grouping under category='govt' (Banking & Finance,
-- Police & Defence, Railway, Medical & Health, Teaching & Education,
-- Engineering & PSU, Administrative & Civil Services, Other), matching what
-- the community actually asked for ("under government we have banking,
-- police, teacher, doctor etc"). Free text like course category and other
-- OCR-sourced fields (see migration 017's comment on eligibility/dates) so
-- a new sector can be added by the mobile app's canonical list without a
-- schema change — the scraper's own classifier and the mobile filter UI
-- both read from that one list, this column just stores whichever string
-- they agreed on.
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS sector VARCHAR(50);
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS sector VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_job_postings_sector ON job_postings(sector);
