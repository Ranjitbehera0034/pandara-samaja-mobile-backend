-- Migration 020: chat sender reports
--
-- Mirrors job_reports/portal_story_reports' report-table pattern
-- (migrations/011_story_likes_comments.sql, migrations/015_job_board_safeguards.sql),
-- but keyed by the (membership_no, mobile) person-pair since chat identity
-- is per-person, not per-household (migrations/019_chat_per_person_identity.sql).
CREATE TABLE IF NOT EXISTS chat_message_reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_membership_no VARCHAR NOT NULL,
  reporter_mobile VARCHAR NOT NULL,
  reported_membership_no VARCHAR NOT NULL,
  reported_mobile VARCHAR NOT NULL,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (reporter_membership_no, reporter_mobile, reported_membership_no, reported_mobile)
);
CREATE INDEX IF NOT EXISTS idx_chat_message_reports_reported ON chat_message_reports(reported_membership_no, reported_mobile);
