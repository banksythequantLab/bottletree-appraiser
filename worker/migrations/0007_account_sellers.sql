-- Sellers become the dealer's, not a sale's. A booth dealer has the same consignors every weekend;
-- retyping them per sale was busywork and it split one person's payouts across sales.
--
-- sale_id was NOT NULL, so the table is rebuilt rather than altered. Existing sellers are folded to
-- one row per (user, name) case- and space-insensitively, oldest row winning, and items are repointed
-- at the survivor so payout splits still add up.

CREATE TABLE sellers_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO sellers_new (id, user_id, name, created_at)
SELECT s.id, sa.user_id, trim(s.name), s.created_at
FROM sellers s
JOIN sales sa ON sa.id = s.sale_id
WHERE s.id = (
  SELECT s2.id
  FROM sellers s2
  JOIN sales sa2 ON sa2.id = s2.sale_id
  WHERE sa2.user_id = sa.user_id
    AND lower(trim(s2.name)) = lower(trim(s.name))
  ORDER BY s2.created_at, s2.id
  LIMIT 1
);

-- Items pointing at a folded-away duplicate follow their seller's surviving row.
UPDATE items
SET seller_id = (
  SELECT sn.id
  FROM sellers_new sn
  JOIN sales sa  ON sa.id = items.sale_id
  JOIN sellers o ON o.id  = items.seller_id
  WHERE sn.user_id = sa.user_id
    AND lower(trim(sn.name)) = lower(trim(o.name))
)
WHERE seller_id IS NOT NULL
  AND seller_id NOT IN (SELECT id FROM sellers_new);

DROP TABLE sellers;
ALTER TABLE sellers_new RENAME TO sellers;

CREATE UNIQUE INDEX idx_sellers_user_name ON sellers(user_id, lower(trim(name)));
CREATE INDEX idx_sellers_user ON sellers(user_id);
