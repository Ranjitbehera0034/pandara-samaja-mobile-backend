-- Migration 023: mobile number on admin accounts
--
-- Required for OTP-gated admin login (see ADMIN_OTP_LOGIN.md) — same
-- app-enforced-required-but-DB-nullable shape as email/membership_no
-- (migrations/006_admin_email.sql), no DB-level NOT NULL/unique so
-- grandfathered accounts aren't retroactively locked out at the schema
-- level; enforcement happens at the route layer.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile VARCHAR;
