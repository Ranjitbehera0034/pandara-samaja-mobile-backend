-- Song Competition — admin launches a contest, members register (solo or
-- as a group, one group per village) and upload a performance video.
-- Every upload is admin-reviewed before the community can see/like/
-- comment on it (mirrors portal_posts/job_postings moderation, not the
-- Announcements shape — this is public member-submitted content). See
-- ARCHITECTURE.md's "Song Competition" section for the full design.
CREATE TABLE IF NOT EXISTS song_contests (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  rules TEXT,
  -- 'draft' (admin still setting it up, invisible to members) ->
  -- 'active' (members can register/upload) -> 'closed' (registration
  -- shut, entries still visible for likes/comments/judging).
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  started_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS song_contest_entries (
  id SERIAL PRIMARY KEY,
  contest_id INTEGER NOT NULL REFERENCES song_contests(id) ON DELETE CASCADE,
  entry_type VARCHAR(20) NOT NULL, -- 'individual' | 'group'
  entry_name VARCHAR(200) NOT NULL, -- performer's name, or the group/team name
  -- Required for group entries (the one-per-village constraint below);
  -- optional for individual entries. Compared case/whitespace-insensitively
  -- since real village data in this DB has known casing/spelling
  -- inconsistencies (e.g. "Gothagam" vs "GOTHAGON") — a naive exact-match
  -- unique constraint would let a typo silently bypass the one-group rule.
  village VARCHAR(200),
  -- Free text, not linked member accounts — group members besides the
  -- registering captain aren't necessarily individually authenticated in
  -- the app (could include children, a spouse without their own login).
  participant_names TEXT,
  -- The captain (group) or the performer themselves (individual) — the
  -- actual logged-in member who submitted this entry.
  registered_by_membership_no VARCHAR(20) NOT NULL REFERENCES members(membership_no),
  registered_by_mobile VARCHAR(15) NOT NULL,
  video_url TEXT NOT NULL,
  moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  admin_remarks TEXT,
  reviewed_by VARCHAR(100),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One group entry per village per contest — rejected entries don't hold
-- the slot (a bad first submission shouldn't permanently block that
-- village), but a pending one does, so two group submissions from the
-- same village can't race each other before admin review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_song_contest_one_group_per_village
  ON song_contest_entries (contest_id, LOWER(TRIM(village)))
  WHERE entry_type = 'group' AND moderation_status != 'rejected';

-- One entry per person per contest, group captain or individual alike —
-- prevents the same member submitting multiple entries under their own
-- account. Revisit if a real case for multiple entries per person comes up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_song_contest_one_entry_per_person
  ON song_contest_entries (contest_id, registered_by_membership_no, registered_by_mobile)
  WHERE moderation_status != 'rejected';

CREATE INDEX IF NOT EXISTS idx_song_contest_entries_contest ON song_contest_entries(contest_id);
CREATE INDEX IF NOT EXISTS idx_song_contest_entries_moderation ON song_contest_entries(contest_id, moderation_status);

-- Mirrors portal_story_likes / job_reports shape: one like per person
-- (membership_no + mobile, not membership_no alone — two family members
-- sharing a membership_no must be able to like independently, same
-- reasoning as every other per-person interaction table in this schema).
CREATE TABLE IF NOT EXISTS song_contest_likes (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES song_contest_entries(id) ON DELETE CASCADE,
  membership_no VARCHAR(20) NOT NULL,
  mobile VARCHAR(15) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entry_id, membership_no, mobile)
);
CREATE INDEX IF NOT EXISTS idx_song_contest_likes_entry ON song_contest_likes(entry_id);

CREATE TABLE IF NOT EXISTS song_contest_comments (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES song_contest_entries(id) ON DELETE CASCADE,
  membership_no VARCHAR(20) NOT NULL,
  mobile VARCHAR(15) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_song_contest_comments_entry ON song_contest_comments(entry_id);
