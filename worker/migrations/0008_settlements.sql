-- Dealer settlements: what each seller is owed for a period, and a frozen record of it.
--
-- The rollup already existed in /sales/:id/summary - COUNT, SUM(price_cents), GROUP BY seller_id.
-- What was missing is terms to apply to it, a period that spans sales rather than one sale, and
-- somewhere to keep a statement once it has been handed to a dealer.
--
-- Checkout has no discounts: total = sum of price_cents, so every item sells at its tag price and
-- per-item attribution to a seller is exact. That is why this is a small migration. If a discount
-- feature is ever added, every line below has to be revisited first.

-- ---------- terms on the seller ----------
-- Malls run three models: booth rent only, commission only (30-50%), or a hybrid of a smaller
-- rent with 8-15%. All three are the same two numbers with one of them zero, so there is no
-- "model" column to get out of step with the figures.
ALTER TABLE sellers ADD COLUMN commission_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE sellers ADD COLUMN rent_cents INTEGER NOT NULL DEFAULT 0;
-- Dealers in a mall are known by their booth before their name, and two dealers share a surname
-- more often than they share a booth.
ALTER TABLE sellers ADD COLUMN booth TEXT;
ALTER TABLE sellers ADD COLUMN terms_note TEXT;
-- A dealer who leaves still has statements and sold items, so they are deactivated, never deleted.
ALTER TABLE sellers ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
-- How they get paid, as a word the owner recognises - "check", "cash", "Zelle". Deliberately not
-- an account number: this table does not hold payment credentials.
ALTER TABLE sellers ADD COLUMN payout_method TEXT;

-- ---------- the statement ----------
-- Every money figure is STORED, never recomputed on read. Two reasons, and the first one is the
-- whole point of this table:
--
-- 1. Terms change. A dealer moved from 15% to 12% in April must not have March's statement
--    silently rewritten the next time anyone opens it. commission_pct and rent_cents below are a
--    snapshot taken when the statement is generated, and nothing reads sellers.commission_pct
--    after that.
-- 2. Rounding. commission_cents is computed once and kept, so the arithmetic a dealer checks by
--    hand against the printout is the arithmetic that was used.
--
-- period_start and period_end are inclusive dates (YYYY-MM-DD). basis records WHICH timestamp
-- decided membership, because items carry sold_at and txns carry created_at, and a statement that
-- silently switched between them would move items near midnight between periods or lose them.
CREATE TABLE IF NOT EXISTS statements (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  seller_id          TEXT NOT NULL,
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  basis              TEXT NOT NULL DEFAULT 'sold_at',
  -- snapshot of the terms actually applied
  commission_pct     REAL NOT NULL,
  rent_cents         INTEGER NOT NULL,
  -- the arithmetic, all in cents, all stored
  gross_cents        INTEGER NOT NULL,
  commission_cents   INTEGER NOT NULL,
  rent_charged_cents INTEGER NOT NULL,
  adjust_cents       INTEGER NOT NULL DEFAULT 0,
  net_cents          INTEGER NOT NULL,
  item_count         INTEGER NOT NULL,
  -- draft: still recomputable. issued: handed to the dealer, frozen. paid: money has moved.
  -- void: superseded or issued in error; kept so the numbering has no holes.
  status             TEXT NOT NULL DEFAULT 'draft',
  note               TEXT,
  created_at         TEXT NOT NULL,
  issued_at          TEXT,
  paid_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_statements_user   ON statements(user_id, period_start);
CREATE INDEX IF NOT EXISTS idx_statements_seller ON statements(seller_id, period_start);
-- One live statement per dealer per period. A voided one does not block a re-issue, which is how
-- a mistake gets corrected without deleting the evidence that it happened.
CREATE UNIQUE INDEX IF NOT EXISTS idx_statements_period
  ON statements(seller_id, period_start, period_end) WHERE status <> 'void';

-- ---------- the frozen line items ----------
-- The item rows are copied rather than joined. An item can be renamed, repriced, reassigned to
-- another seller or have its sale deleted, and none of that may change a statement a dealer has
-- already been handed. item_id is kept for tracing but nothing on this table depends on the row
-- it points at still existing.
CREATE TABLE IF NOT EXISTS statement_items (
  id           TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  item_id      TEXT,
  name         TEXT NOT NULL,
  price_cents  INTEGER NOT NULL,
  sold_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_statement_items ON statement_items(statement_id);

-- ---------- adjustments ----------
-- Signed cents: negative deducts from the dealer, positive credits them. One row per line so the
-- printout can say "bag charges -$4.00" rather than presenting a dealer with a single unexplained
-- number, which is the thing that starts arguments.
CREATE TABLE IF NOT EXISTS statement_adjustments (
  id           TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  label        TEXT NOT NULL,
  cents        INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statement_adjustments ON statement_adjustments(statement_id);

-- ---------- the period query this all rests on ----------
-- Statements are built by seller across a date range, which is not how items has been queried
-- until now (always by sale_id).
CREATE INDEX IF NOT EXISTS idx_items_seller_sold ON items(seller_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_items_status_sold ON items(status, sold_at);
