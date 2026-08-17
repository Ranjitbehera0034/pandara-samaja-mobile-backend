-- Anti-fraud safeguards for the job board, added right after initial
-- design review (before any real postings existed): (1) a required
-- submitter contact phone, carried onto the published listing so
-- applicants know who to hold accountable and admin can call to verify
-- before approving; (2) member-reportable listings, mirroring
-- portal_stories' moderation_status + report table pattern exactly
-- (migrations/011_story_likes_comments.sql).

ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(15);
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(30) NOT NULL DEFAULT 'visible';
CREATE INDEX IF NOT EXISTS idx_job_postings_moderation ON job_postings(moderation_status) WHERE moderation_status != 'visible';

CREATE TABLE IF NOT EXISTS job_reports (
  id BIGSERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  reporter_id VARCHAR(20) NOT NULL REFERENCES members(membership_no) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, reporter_id)
);
