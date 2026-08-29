-- Migration 022: per-person push tokens
--
-- members.push_token is ONE column per HOUSEHOLD. Now that chat is
-- per-person (migrations/019, 021), that single column is actively wrong:
-- whichever family member's device registered a push token LAST "owns" the
-- household's notifications, so a message sent to one sibling could push
-- straight to the SENDER's own phone if the sender's device happened to be
-- the last one registered — exactly the bug reported ("the member who
-- sends a message also gets notified").
CREATE TABLE IF NOT EXISTS member_push_tokens (
  membership_no VARCHAR NOT NULL,
  mobile VARCHAR NOT NULL,
  push_token VARCHAR NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (membership_no, mobile)
);
