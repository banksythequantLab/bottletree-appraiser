-- Bottle Tree v0.3.1 — kiosk / device intake
ALTER TABLE users ADD COLUMN device_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device_key ON users(device_key);
ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'app'; -- app | kiosk
