-- Course lesson submissions: the review queue for videos discovered daily
-- by scraper/src/sources/youtubeChannels.ts (new uploads from a fixed
-- list of trusted free-education channels — see that file for the list
-- and why title/organization aren't OCR'd here the way job notices are).
-- Mirrors job_submissions' shape exactly on purpose: nothing an automated
-- source finds goes live without an admin approving it first — a wrongly
-- classified or off-topic video reaching members unreviewed is the same
-- failure mode a misread job deadline is, just for a different feature.
--
-- source_ref is 'youtube:<videoId>', UNIQUE for the same reason
-- job_submissions.source_ref is: the scraper detects "already ingested"
-- via a failed insert instead of keeping its own state between runs.
--
-- Approval creates a real course_lessons row — either under an existing
-- course (existing_course_id) or a brand new one (in which case
-- new_course_title/new_course_category name it) — mirroring how job
-- submission approval creates a new job_postings row via createPosting().
CREATE TABLE IF NOT EXISTS course_lesson_submissions (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  platform VARCHAR(30) NOT NULL DEFAULT 'YouTube',
  external_url TEXT NOT NULL,
  -- The category the channel is registered under (see youtubeChannels.ts)
  -- — used to suggest which existing course to attach to at review time.
  category VARCHAR(100),
  channel_name VARCHAR(200),
  source_ref TEXT UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_remarks TEXT,
  reviewed_by VARCHAR(50),
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_lesson_submissions_status ON course_lesson_submissions(status);
