-- Migration 006: admin account email, for add/remove notifications.
--
-- Superadmins can already create/edit/remove admin accounts (users table);
-- this adds a place to store the admin's email address so we can notify
-- them when their account is created or their access is removed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
