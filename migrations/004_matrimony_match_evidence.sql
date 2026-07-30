-- Migration 004: matrimony marriage/engagement confirmation evidence.
--
-- The real `candidates` table already has is_matched, matched_partner_name,
-- matched_partner_gender, matched_status, matched_partner_member_id, and
-- match_date for recording a confirmed match — the one genuinely missing
-- piece is somewhere to store the evidence file (marriage/engagement proof)
-- an admin or the candidate's submitter uploads to confirm the match.

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS match_evidence_url TEXT;
