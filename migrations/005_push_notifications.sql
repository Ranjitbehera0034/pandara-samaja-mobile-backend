-- Migration 005: push notification token storage.
--
-- Stores each member's current Expo push token so the backend can send a
-- real OS-level push notification (new messages, new posts from people you
-- follow, new announcements) instead of only updating the in-app socket
-- badge, which only works while the app is open and connected.
--
-- One token per member is sufficient for this app's usage pattern (one
-- device per member); a fresh registration simply overwrites the old value,
-- which is also the correct behavior when a member reinstalls the app or
-- switches devices.

ALTER TABLE members ADD COLUMN IF NOT EXISTS push_token TEXT;
