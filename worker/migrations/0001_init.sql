-- Bottle Tree app v0.1 schema
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  seller_id TEXT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',  -- available | sold
  txn_id TEXT,
  created_at TEXT NOT NULL,
  sold_at TEXT
);
CREATE TABLE IF NOT EXISTS txns (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  tender TEXT NOT NULL DEFAULT 'cash',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_sale ON items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sellers_sale ON sellers(sale_id);
CREATE INDEX IF NOT EXISTS idx_txns_sale ON txns(sale_id);
