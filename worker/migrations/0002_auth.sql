-- Bottle Tree v0.2 — accounts
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
ALTER TABLE sales ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
