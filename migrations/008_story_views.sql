-- Migration 008: story view tracking, for "how many people saw my story /
-- who saw it" (Instagram-style story viewers list). Nothing tracks this
-- today - the "viewed" indicator in the app is purely local to the
-- viewer's own device, never sent to the server, so a story's own author
-- has no way to see who watched it.

-- viewer_name/viewer_photo are denormalized at view-record time from the
-- viewer's own JWT identity (req.user.name/photo), the same pattern
-- already used for portal_posts/portal_comments/portal_stories'
-- author_name/author_photo — a membership_no is a household, not one
-- person, so re-deriving "who viewed this" later via a join to
-- members.name/profile_photo_url would always show the household head
-- regardless of which specific family member actually viewed it.
CREATE TABLE IF NOT EXISTS portal_story_views (
  id BIGSERIAL PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES portal_stories(id) ON DELETE CASCADE,
  viewer_id VARCHAR(20) NOT NULL REFERENCES members(membership_no) ON DELETE CASCADE,
  viewer_name VARCHAR(100),
  viewer_photo TEXT,
  viewed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (story_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_story_views_story ON portal_story_views(story_id);
