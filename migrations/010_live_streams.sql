-- Live streams are ephemeral by design (not recorded/saved) — this table only
-- tracks presence/metadata for currently-live and past streams (start/end
-- time, who hosted it), never the video itself.
--
-- host_id spans two different tables (members.membership_no for member
-- broadcasters, users.id for admin/superadmin broadcasters) so it cannot
-- carry a single FK; host_name/host_photo are denormalized at start time
-- instead, consistent with the actor-identity pattern used throughout this
-- app (posts/comments/notifications/stories).
CREATE TABLE IF NOT EXISTS live_streams (
  id BIGSERIAL PRIMARY KEY,
  room_name VARCHAR(100) NOT NULL UNIQUE,
  host_type VARCHAR(20) NOT NULL, -- 'member' | 'admin' | 'superadmin'
  host_id VARCHAR(20) NOT NULL,
  host_name VARCHAR(255),
  host_photo TEXT,
  title VARCHAR(255),
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP,
  peak_viewers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_live_streams_active ON live_streams(ended_at) WHERE ended_at IS NULL;
