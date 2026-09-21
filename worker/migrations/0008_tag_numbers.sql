-- Short per-sale tag numbers. A UUID cannot go on a garage-sale price tag; "014" can, and it is what
-- someone reads aloud across a table when the scan fails. Numbers restart at 1 for each sale and are
-- never reused within it, so a reprinted tag always means the same item.

ALTER TABLE items ADD COLUMN tag_no INTEGER;

-- Backfill in creation order, per sale.
UPDATE items SET tag_no = (
  SELECT COUNT(*) FROM items i2
  WHERE i2.sale_id = items.sale_id
    AND (i2.created_at < items.created_at OR (i2.created_at = items.created_at AND i2.id <= items.id))
);

CREATE UNIQUE INDEX idx_items_sale_tag ON items(sale_id, tag_no) WHERE tag_no IS NOT NULL;
