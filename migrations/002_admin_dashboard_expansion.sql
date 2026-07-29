-- Migration 002: Admin dashboard expansion
-- Adds: activity_log (audit trail), users.is_active (admin account
-- enable/disable), community_expenses (income/expense ledger).
--
-- This DB is shared with the web app — run this manually against
-- production. Every query in the backend that touches these new
-- tables/columns is written to defensively catch Postgres error codes
-- 42703 (undefined_column) / 42P01 (undefined_table) and fall back to
-- pre-migration behavior, so the app keeps working before this runs.

CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  actor_type VARCHAR(20) NOT NULL,   -- 'member' | 'admin' | 'superadmin'
  actor_id VARCHAR(30) NOT NULL,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(30),
  target_id VARCHAR(50),
  metadata JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor ON activity_log(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS community_expenses (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('income', 'expense')),
  amount NUMERIC(12,2) NOT NULL,
  category VARCHAR(50),
  note TEXT,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_expenses_date ON community_expenses(entry_date DESC);
