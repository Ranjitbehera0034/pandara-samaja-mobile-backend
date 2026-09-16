-- Job edit suggestions: a member noticing a published job posting is
-- wrong or out of date (eligibility, last date, vacancy count, etc.) can
-- suggest a correction — same "Jobs shape" as job_submissions (queue +
-- moderation), just for edits to a posting that's already live instead of
-- a brand-new one. An admin/superadmin editing the same posting directly
-- via PUT /api/admin/jobs/:id is unaffected by this table entirely — that
-- path already applies immediately, no approval step, because the editor
-- is already the trusted party.
--
-- Every column mirrors job_postings' own editable fields and is nullable:
-- NULL means "no change proposed for this field" (falls back to the
-- posting's current value at review time), not "clear this field".
-- `note` is required — a one-line "what's wrong and why" so an admin can
-- review the suggestion without diffing every field by hand.
CREATE TABLE IF NOT EXISTS job_edit_suggestions (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  suggested_by VARCHAR(20) NOT NULL REFERENCES members(membership_no),
  suggester_name TEXT,
  title TEXT,
  organization TEXT,
  sector VARCHAR(50),
  description TEXT,
  location TEXT,
  application_info TEXT,
  eligibility TEXT,
  last_date VARCHAR(200),
  registration_start_date VARCHAR(200),
  application_fee VARCHAR(200),
  no_of_vacancies VARCHAR(200),
  note TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_remarks TEXT,
  reviewed_by VARCHAR(50),
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_edit_suggestions_status ON job_edit_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_job_edit_suggestions_job_id ON job_edit_suggestions(job_id);
