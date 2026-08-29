-- Migration 021: per-person actor identity on notifications
--
-- portal_notifications only ever recorded actor_id (a household membership_no).
-- For 'message' notifications specifically this made the sender ambiguous the
-- moment chat became per-person (migrations/019_chat_per_person_identity.sql)
-- — tapping the notification couldn't tell which family member sent it, and
-- ChatScreen now requires a mobile to open the right person's thread.
ALTER TABLE portal_notifications ADD COLUMN IF NOT EXISTS actor_mobile VARCHAR;
