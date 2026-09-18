-- Bottle Tree v0.5 — estimates are metered; inventory, photos and the storefront stay free.
-- plan: free | pro (300 estimates / month) | unlimited. Credits are one-off estimates (packs / singles).
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN plan_expires_at TEXT;
ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 1;     -- one free estimate to try it
ALTER TABLE users ADD COLUMN rc_app_user_id TEXT;                     -- RevenueCat app_user_id (we log in with our user id)

-- every grant / spend, idempotent on the upstream event id
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,            -- revenuecat | stripe | usage | admin
  event_id TEXT UNIQUE,            -- upstream id (RevenueCat event.id, Stripe event id) for dedupe
  type TEXT NOT NULL,              -- INITIAL_PURCHASE, RENEWAL, EXPIRATION, spend, refund, ...
  product_id TEXT,
  credits_delta INTEGER NOT NULL DEFAULT 0,
  plan TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_events(user_id, created_at);

-- plan usage per calendar month (pro cap)
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,             -- YYYY-MM (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- which wallet paid for an appraisal, so a failed run can be refunded
ALTER TABLE appraisals ADD COLUMN funded_by TEXT;                     -- credit | plan | free
