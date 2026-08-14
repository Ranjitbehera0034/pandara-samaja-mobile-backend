-- Distinguishes "opened the app, silent refresh fired, closed it" from
-- genuine usage — last_active_at alone can't tell these apart, since the
-- 5-minute throttle means a whole session only ever produces one write.
-- This counts every authenticated request in a day (no throttle), reset
-- daily: 1 request is almost certainly just the app-open refresh; 2+
-- means the member actually navigated somewhere.
ALTER TABLE members ADD COLUMN IF NOT EXISTS daily_request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS daily_request_count_date DATE;
