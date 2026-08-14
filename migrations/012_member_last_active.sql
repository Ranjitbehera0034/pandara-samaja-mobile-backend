-- Real "active" tracking, distinct from last_portal_login (set once at
-- login and never updated again) and from activity_log (only touched by
-- explicit actions like posting/liking, never by plain browsing/scrolling).
-- Touched on every authenticated request (throttled — see fastify.authenticate
-- in src/plugins/jwt.ts), so this reflects genuine app usage including
-- navigation, not just content-creation actions.
ALTER TABLE members ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_members_last_active_at ON members(last_active_at);
