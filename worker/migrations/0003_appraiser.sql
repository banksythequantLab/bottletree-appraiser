-- Bottle Tree v0.3 — photos, AI appraisals, online storefront
ALTER TABLE items ADD COLUMN description TEXT;
ALTER TABLE items ADD COLUMN markings TEXT;
ALTER TABLE items ADD COLUMN ai_title TEXT;
ALTER TABLE items ADD COLUMN ai_description TEXT;
ALTER TABLE items ADD COLUMN listing_status TEXT NOT NULL DEFAULT 'draft'; -- draft | live | hidden
ALTER TABLE items ADD COLUMN listed_at TEXT;

ALTER TABLE users ADD COLUMN shop_slug TEXT;
ALTER TABLE users ADD COLUMN shop_name TEXT;
ALTER TABLE users ADD COLUMN shop_blurb TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_shop_slug ON users(shop_slug);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',     -- front | back | underside | marks | detail | damage | other
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id);

CREATE TABLE IF NOT EXISTS appraisals (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | error
  result_json TEXT,
  error TEXT,
  model_text TEXT,
  model_vision TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appraisals_item ON appraisals(item_id, created_at);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  stripe_session_id TEXT,
  amount_cents INTEGER NOT NULL,
  buyer_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | cancelled
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_item ON orders(item_id);
