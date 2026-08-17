-- Job board: members submit job postings (pending review), admins approve
-- them or add real government vacancies directly. Mirrors the
-- matrimony_applications -> candidates split (the existing precedent for
-- "member submits, admin approves, publishes to a separate public table")
-- rather than the post-moderation pattern, which is about hiding already-
-- public content, not approving new submissions.

-- Published, public postings — what GET /api/jobs serves.
CREATE TABLE IF NOT EXISTS job_postings (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  organization TEXT NOT NULL,
  category VARCHAR(10) NOT NULL CHECK (category IN ('govt', 'private')),
  description TEXT NOT NULL,
  location TEXT,
  application_info TEXT NOT NULL, -- link or instructions for how to apply, external to the app
  posted_by_admin BOOLEAN NOT NULL DEFAULT false,
  submitted_by VARCHAR(20) REFERENCES members(membership_no), -- null for admin-direct postings
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP -- nullable; jobs without a stated deadline just don't expire
);

CREATE INDEX IF NOT EXISTS idx_job_postings_category ON job_postings(category);
CREATE INDEX IF NOT EXISTS idx_job_postings_created_at ON job_postings(created_at DESC);

-- The pending review queue for member-submitted postings. Approval moves a
-- row's data into job_postings and this row's status becomes terminal
-- ('rejected' is the only terminal status stored here — an approved
-- submission's data now lives in job_postings, matching how matrimony
-- applications work).
CREATE TABLE IF NOT EXISTS job_submissions (
  id SERIAL PRIMARY KEY,
  membership_no VARCHAR(20) NOT NULL REFERENCES members(membership_no),
  submitter_name TEXT,
  submitter_mobile VARCHAR(15),
  title TEXT NOT NULL,
  organization TEXT NOT NULL,
  category VARCHAR(10) NOT NULL CHECK (category IN ('govt', 'private')),
  description TEXT NOT NULL,
  location TEXT,
  application_info TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected')),
  admin_remarks TEXT,
  reviewed_by VARCHAR(50),
  reviewed_at TIMESTAMP,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_submissions_status ON job_submissions(status);
CREATE INDEX IF NOT EXISTS idx_job_submissions_membership_no ON job_submissions(membership_no);
