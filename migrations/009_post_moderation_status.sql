-- portal_posts.moderation_status is referenced throughout the report/review
-- pipeline (reportPost auto-hide, getPosts feed filter, getReportedPosts,
-- approvePost, rejectPost) but the column was never actually created — every
-- one of those queries either silently degrades (42703-guarded) or hard
-- fails. Without this column, reported content is never auto-hidden from
-- the public feed and admin/superadmin can never see the reports queue at
-- all (GET /admin/reports 500s every time).
ALTER TABLE portal_posts ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(30) NOT NULL DEFAULT 'visible';
CREATE INDEX IF NOT EXISTS idx_portal_posts_moderation ON portal_posts(moderation_status) WHERE moderation_status != 'visible';
