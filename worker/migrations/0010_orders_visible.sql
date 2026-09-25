-- Orders were written and never read. Nothing in the app or the API ever showed one, so an
-- online sale happened, the item silently flipped to sold, and the owner had no list of what
-- was bought, by whom, or where to send it. You cannot fulfil an order you cannot see.
--
-- These columns are what make the row answerable rather than just present: why it is in the
-- state it is in, and whether it has actually been sent.

ALTER TABLE orders ADD COLUMN note TEXT;
ALTER TABLE orders ADD COLUMN fulfilled_at TEXT;
ALTER TABLE orders ADD COLUMN updated_at TEXT;
-- The session id is not searchable in the Stripe dashboard; the payment intent has a page of
-- its own. Without it, "refund this buyer" is an instruction with nowhere to go.
ALTER TABLE orders ADD COLUMN payment_intent TEXT;

-- status gains 'needs_refund': paid, but the item had already sold on the shop floor before
-- the payment confirmed. The money is real and the goods are gone, so it cannot be quietly
-- dropped; it has to sit in front of the owner until they refund it.
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
