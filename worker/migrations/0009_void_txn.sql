-- Undoing a sale.
--
-- Until now a transaction was final the moment it was rung up. That is wrong at a real
-- counter: a cashier scans the wrong tag, a customer changes their mind on the way out,
-- a card is declined after the drawer already opened. The only way to fix it was to
-- delete the whole sale, which erased the day's takings along with the mistake.
--
-- A void does not remove the transaction. It marks it, so the takings can be reconciled
-- against the drawer and a returned item can be explained rather than just missing. Every
-- query that adds up money has to learn to skip these rows; that is the cost of keeping
-- them, and it is the right cost.

ALTER TABLE txns ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE txns ADD COLUMN voided_at TEXT;
ALTER TABLE txns ADD COLUMN void_reason TEXT;

-- Revenue sums and the "does this sale have takings" check both filter on status, and both
-- run per sale, so the index carries it.
CREATE INDEX IF NOT EXISTS idx_txns_sale_status ON txns(sale_id, status);
