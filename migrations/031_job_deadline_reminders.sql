-- Tracks whether a deadline reminder has already been broadcast for a job
-- posting, so the daily reminder cron (src/utils/jobDeadlineCron.ts) sends
-- each posting's reminder exactly once instead of every time it runs within
-- the 1-day window before expires_at. NULL = not sent yet.
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP;
