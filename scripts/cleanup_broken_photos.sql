-- One-time data cleanup: 3 members' photos were stored as raw base64 data
-- URIs (from a web-app upload bug) instead of a Firebase Storage path.
-- getSignedMediaUrl() can't sign a data: URI as a Firebase path, and either
-- returns the ~35-255KB blob unchanged or (worse) mangles it into a bogus
-- multi-hundred-KB "signed URL". Since this gets denormalized into every
-- post/comment/story the affected members author, it was inflating
-- GET /portal/posts to 2.7MB for a single 20-post page. Nulling these
-- clears already-unrenderable garbage — no real photo data is lost.
BEGIN;

UPDATE members
SET profile_photo_url = NULL
WHERE profile_photo_url LIKE 'data:image%';

UPDATE members m
SET family_members = (
  SELECT jsonb_agg(
    CASE
      WHEN elem ->> 'profile_pic' LIKE 'data:image%'
      THEN jsonb_set(elem, '{profile_pic}', 'null'::jsonb)
      ELSE elem
    END
  )
  FROM jsonb_array_elements(m.family_members) AS elem
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(m.family_members) AS e2
  WHERE e2 ->> 'profile_pic' LIKE 'data:image%'
);

UPDATE portal_posts
SET author_photo = NULL
WHERE author_photo LIKE 'data:image%'
   OR author_photo LIKE '%storage.googleapis.com%data%3Aimage%';

UPDATE portal_comments
SET author_photo = NULL
WHERE author_photo LIKE 'data:image%'
   OR author_photo LIKE '%storage.googleapis.com%data%3Aimage%';

UPDATE portal_stories
SET author_photo = NULL
WHERE author_photo LIKE 'data:image%'
   OR author_photo LIKE '%storage.googleapis.com%data%3Aimage%';

COMMIT;
