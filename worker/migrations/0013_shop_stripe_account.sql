-- Whose Stripe account receives the money for a shop's online sales.
--
-- Road Show is given away to estate-sale companies and small-shop owners, and every storefront
-- was checking out through ONE Stripe key — the platform's. That is fine while the only shop
-- belongs to whoever owns the key, and wrong the moment a second person publishes an item:
-- their customers' money would land in the platform's balance, their refunds and chargebacks
-- would come out of it, and the platform's tax reporting would show revenue for goods it never
-- sold. Stripe has a name for doing this properly, and it is Connect.
--
-- NULL means online card checkout is off for that shop, which is the correct default for every
-- account. The catalogue, photos and prices still work; only the Buy button is gated.
--
-- The value is the Stripe account that gets paid. Today the only value the code will honour is
-- the platform's own account (STRIPE_PLATFORM_ACCOUNT), because taking payment INTO a different
-- account needs the Connect flow, which does not exist yet. When it does, this column already
-- holds the right thing and the check becomes "pass Stripe-Account instead of refusing".

-- ---------------------------------------------------------------------------------------------
-- DO NOT APPLY THIS TO THE SHARED PRODUCTION DATABASE. It is already there.
--
-- roadshow-app and bottletree-app are two workers over ONE D1 database
-- (c64195f6-148f-4ea5-ba06-90bac6f88290). Bottle Tree's own 0011_shop_stripe_account.sql added
-- this column and this index on 2026-09-25, and `pragma_table_info('users')` on the remote
-- database confirms users.stripe_account_id is present. SQLite has no ALTER TABLE ADD COLUMN
-- IF NOT EXISTS, so running the line below against production would fail with "duplicate
-- column name" — which is not a problem to fix, it is the column already being correct.
--
-- This file exists so that a FRESH database — a new environment, and the SQLite the test shim
-- builds from this directory — has the same shape as production. d1_migrations on the remote
-- database only tracks 0001–0005; everything since has been applied by hand with
-- `wrangler d1 execute --file`, so nothing will try to run this on its own.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN stripe_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_shop_slug ON users(shop_slug) WHERE shop_slug IS NOT NULL;
