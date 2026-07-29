-- Migration 003: Fix matrimony feature against the REAL production schema.
--
-- Investigation found the mobile backend's matrimony code (candidateModel.ts,
-- routes/matrimony.ts, routes/adminMatrimony.ts) was written against columns
-- that were never actually migrated: candidates.photos (plural), .form_url,
-- .submitted_by, and a portal_matrimony_interests table. The REAL candidates
-- table (used successfully by the web app) instead has: photo (singular),
-- manual_form, author_id — this migration does NOT rename/duplicate those;
-- the application code has been remapped to use the real column names.
--
-- The one genuinely missing piece is multi-photo support (the real schema
-- only ever had a single `photo`) and the swipe/mutual-match interest table,
-- which is a new capability this app is adding on top of the existing
-- web-app-compatible schema — both are purely additive.

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT '{}'::text[];

CREATE TABLE IF NOT EXISTS portal_matrimony_interests (
  id BIGSERIAL PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  member_id VARCHAR(20) NOT NULL REFERENCES members(membership_no) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('like', 'pass')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_matrimony_interests_member ON portal_matrimony_interests(member_id);
CREATE INDEX IF NOT EXISTS idx_matrimony_interests_candidate ON portal_matrimony_interests(candidate_id);
