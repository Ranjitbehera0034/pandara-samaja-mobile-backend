-- Migration 007: story author photo, for the same multi-person-per-household
-- identity fix already applied to posts/comments.
--
-- portal_posts and portal_comments both already have an author_photo column
-- so a specific family member's own photo can be stored per-action instead
-- of always resolving back to the household's single shared
-- profile_photo_url. portal_stories was missed in that earlier pass - it
-- has no equivalent column at all, so a family member's story always shows
-- the household head's avatar (or blank) instead of their own.

ALTER TABLE portal_stories ADD COLUMN IF NOT EXISTS author_photo TEXT;
