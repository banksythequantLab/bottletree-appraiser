-- Whose Stripe account receives the money for a shop's online sales.
--
-- Bottle Tree is given away to garage-sale and small-shop owners, and every storefront was
-- checking out through ONE Stripe key — the platform's. That is fine while the only shop
-- belongs to whoever owns the key, and wrong the moment a second person publishes an item:
-- their customers' money would land in the platform's balance, their refunds and chargebacks
-- would come out of it, and the platform's tax reporting would show revenue for goods it
-- never sold. Stripe has a name for doing this properly, and it is Connect.
--
-- NULL means online card checkout is off for that shop, which is the correct default for
-- every account. The catalogue, photos and prices still work; only the Buy button is gated.
--
-- The value is the Stripe account that gets paid. Today the only value the code will honour
-- is the platform's own account (STRIPE_PLATFORM_ACCOUNT), because taking payment INTO a
-- different account needs the Connect flow, which does not exist yet. When it does, this
-- column already holds the right thing and the check becomes "pass Stripe-Account instead
-- of refusing".

ALTER TABLE users ADD COLUMN stripe_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_shop_slug ON users(shop_slug) WHERE shop_slug IS NOT NULL;
