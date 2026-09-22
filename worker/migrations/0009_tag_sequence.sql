-- Tag numbers were handed out as MAX(tag_no)+1 over the sale's live items. The intent was that a
-- number is never reused, because a printed label is a physical object that outlives the row it
-- points at. MAX+1 does not achieve that: delete the highest-numbered item and the next item
-- created takes its number, so tag #3 on a table at the end of the driveway silently starts
-- meaning a different thing at a different price.
--
-- The counter has to survive deletion, so it lives on the sale rather than being derived from the
-- items still present.
ALTER TABLE sales ADD COLUMN next_tag INTEGER NOT NULL DEFAULT 0;

-- Existing sales continue from their current high-water mark, never below it.
UPDATE sales SET next_tag = (
  SELECT COALESCE(MAX(i.tag_no), 0) FROM items i WHERE i.sale_id = sales.id
);
