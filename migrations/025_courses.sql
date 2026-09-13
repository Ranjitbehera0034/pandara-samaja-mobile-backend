-- Courses: admin-curated collections of links out to free external
-- learning platforms (YouTube, Udemy, Coursera, etc.) so members can learn
-- a skill or prepare for govt exams at no cost to the app. A lesson is
-- just a link — tapping one opens the source platform in the member's own
-- browser/app, the same "leave the app to view the real thing" pattern
-- already used for job listings and news articles. This app never hosts,
-- streams, or renders the video itself, so it carries no storage/bandwidth
-- cost and no exposure to that platform's own ad behavior.
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  thumbnail_url TEXT,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_lessons (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  -- Free text rather than an enum — a new platform (e.g. SWAYAM, NPTEL)
  -- should be addable by an admin without a schema change; the mobile
  -- client falls back to a generic icon/label for anything it doesn't
  -- specifically recognize.
  platform VARCHAR(30) NOT NULL,
  external_url TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_lessons_course_id ON course_lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_courses_published ON courses(is_published) WHERE is_published = true;
