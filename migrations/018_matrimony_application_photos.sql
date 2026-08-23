-- Migration 018: let matrimony applications carry personal photos, not just
-- the scanned/photographed paper form.
--
-- The member submission flow only ever collected one file (the filled-form
-- photo); candidates.photos (TEXT[]) already exists (migration 003) but
-- nothing writes to it anywhere in the app. This adds the matching column
-- on the applications side so photos submitted with an application can flow
-- through approval into the published candidate record.

ALTER TABLE matrimony_applications ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT '{}'::text[];
