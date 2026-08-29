-- Migration 019: per-person chat identity + block list
--
-- portal_messages already had sender_mobile/receiver_mobile columns (added
-- at some earlier point, never populated or read by any application code —
-- every message was stored and routed by membership_no alone, meaning an
-- entire household shared one inbox regardless of which family member was
-- actually logged in). This migration backfills the existing rows so those
-- columns are never NULL going forward, then indexes them for the new
-- per-person contact/conversation lookup pattern.
--
-- Backfill rationale: every historical message was sent/received under the
-- old head-only architecture, so filling NULL with the household's own
-- mobile (members.mobile) is the correct interpretation of "who did this
-- historically resolve to" — not a guess, the only value consistent with
-- how the system actually behaved before this migration.
UPDATE portal_messages pm
SET sender_mobile = m.mobile
FROM members m
WHERE pm.sender_id = m.membership_no AND pm.sender_mobile IS NULL;

UPDATE portal_messages pm
SET receiver_mobile = m.mobile
FROM members m
WHERE pm.receiver_id = m.membership_no AND pm.receiver_mobile IS NULL;

CREATE INDEX IF NOT EXISTS idx_portal_messages_sender_pair ON portal_messages(sender_id, sender_mobile);
CREATE INDEX IF NOT EXISTS idx_portal_messages_receiver_pair ON portal_messages(receiver_id, receiver_mobile);

-- Per-person block list — a member can block a specific individual (not
-- necessarily their whole household), since chat is now person-scoped.
CREATE TABLE IF NOT EXISTS chat_blocks (
  id SERIAL PRIMARY KEY,
  blocker_membership_no VARCHAR NOT NULL,
  blocker_mobile VARCHAR NOT NULL,
  blocked_membership_no VARCHAR NOT NULL,
  blocked_mobile VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(blocker_membership_no, blocker_mobile, blocked_membership_no, blocked_mobile)
);
CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocker ON chat_blocks(blocker_membership_no, blocker_mobile);
CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked ON chat_blocks(blocked_membership_no, blocked_mobile);
