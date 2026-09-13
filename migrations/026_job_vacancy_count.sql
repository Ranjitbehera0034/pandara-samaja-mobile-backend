-- Vacancy count as its own field — previously the number of open posts
-- (e.g. "05 (Five) posts of Geologist") only ever appeared buried inside
-- the free-text last_date/eligibility snippets when it appeared at all,
-- effectively invisible to a member scanning the listing. As-typed text,
-- not a parsed integer — same reasoning as last_date/eligibility already
-- being free text (migration 017): OCR'd source text is never reliably
-- machine-parseable into a strict number, and mangling it silently is
-- worse than showing it verbatim.
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS no_of_vacancies VARCHAR(200);
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS no_of_vacancies VARCHAR(200);
