-- Story likes/comments, mirroring the existing portal_posts/portal_likes/
-- portal_comments pattern exactly (per-person identity via member_id +
-- member_mobile so two family members sharing a membership_no are tracked
-- independently, denormalized author_name/author_photo at write time).
ALTER TABLE portal_stories ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE portal_stories ADD COLUMN IF NOT EXISTS comments_count INTEGER NOT NULL DEFAULT 0;

-- Stories never tracked WHICH specific family member (of a household that
-- can have several logged in independently) posted a given story — only
-- the shared membership_no. That meant DELETE /stories/:id could only ever
-- check "does this story belong to my household", so any family member
-- could delete any other family member's story. author_mobile closes that
-- the same way portal_posts.author_mobile already does for posts.
ALTER TABLE portal_stories ADD COLUMN IF NOT EXISTS author_mobile VARCHAR(15);

-- Stories had no report/moderation pipeline at all (unlike posts). Mirrors
-- portal_posts.moderation_status + portal_reports exactly.
ALTER TABLE portal_stories ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(30) NOT NULL DEFAULT 'visible';
CREATE INDEX IF NOT EXISTS idx_portal_stories_moderation ON portal_stories(moderation_status) WHERE moderation_status != 'visible';

CREATE TABLE IF NOT EXISTS portal_story_reports (
  id BIGSERIAL PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES portal_stories(id) ON DELETE CASCADE,
  reporter_id VARCHAR(20) NOT NULL REFERENCES members(membership_no) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (story_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS portal_story_likes (
  id BIGSERIAL PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES portal_stories(id) ON DELETE CASCADE,
  member_id VARCHAR(20) NOT NULL REFERENCES members(membership_no) ON DELETE CASCADE,
  member_mobile VARCHAR(15),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (story_id, member_id, member_mobile)
);
CREATE INDEX IF NOT EXISTS idx_story_likes_story ON portal_story_likes(story_id);

CREATE TABLE IF NOT EXISTS portal_story_comments (
  id BIGSERIAL PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES portal_stories(id) ON DELETE CASCADE,
  member_id VARCHAR(20) NOT NULL REFERENCES members(membership_no) ON DELETE CASCADE,
  author_name VARCHAR(255),
  author_photo TEXT,
  author_mobile VARCHAR(15),
  text TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_story_comments_story ON portal_story_comments(story_id);
