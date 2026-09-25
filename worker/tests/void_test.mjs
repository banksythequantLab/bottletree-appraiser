// Voiding a transaction, against a real SQLite database built from the real migrations.
//
// The void is almost entirely SQL, so testing it without a database would only test my
// opinion of what the SQL does. This builds the actual schema from migrations/*.sql, replays
// the statements the worker runs, and asserts on what the tables actually hold afterwards.
//
// The SQL here is a copy of what worker.js runs, which is exactly the kind of copy that rots.
// So every statement that matters is also asserted to appear verbatim in worker.js: change
// one without the other and this file fails rather than quietly testing the old version.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { settle } from "../settlements.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const WORKER = readFileSync(join(root, "worker.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; } else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

// A statement worker.js must still contain. Whitespace is normalised so reformatting is fine
// and a changed table, column or condition is not.
// worker.js writes long queries as adjacent string literals joined by +, so the runtime string
// never appears literally in the source. Splicing those joins back together is what lets a
// whole query be matched rather than only its first fragment.
const norm = s => s.replace(/\s+/g, " ").trim();
const SOURCE = norm(WORKER).replace(/"\s*\+\s*"/g, "");
function live(name, sql) {
  ok(`worker.js still runs: ${name}`, SOURCE.includes(norm(sql).replace(/"\s*\+\s*"/g, "")), norm(sql).slice(0, 90));
  return sql;
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(root, "migrations")).filter(f => f.endsWith(".sql")).sort())
    db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  return db;
}

// A shop with one dealer and three of her things, two of which sell together.
function seed() {
  const db = freshDb();
  db.exec(`
    INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES ('u1','a@b.c','x','y','2026-08-01T09:00:00Z');
    INSERT INTO sales (id,name,status,created_at,user_id) VALUES ('sa1','Shop floor','open','2026-08-01T09:00:00Z','u1');
    INSERT INTO sellers (id,user_id,name,created_at,commission_pct,rent_cents)
      VALUES ('se1','u1','Marge','2026-08-01T09:00:00Z',35,4500);
    INSERT INTO items (id,sale_id,seller_id,name,price_cents,status,created_at,listing_status) VALUES
      ('i1','sa1','se1','Red Wing crock',18000,'available','2026-08-01T09:00:00Z','live'),
      ('i2','sa1','se1','Brass candlesticks',6000,'available','2026-08-01T09:00:00Z','draft'),
      ('i3','sa1','se1','Oak stool',4000,'available','2026-08-01T09:00:00Z','draft');`);
  return db;
}

const SQL_CHECKOUT_TXN = live("checkout writes the transaction",
  "INSERT INTO txns (id,sale_id,total_cents,item_count,tender,created_at) VALUES (?,?,?,?,?,?)");
// The worker builds its IN list from the cart, so only the fixed head of this one is checked.
live("checkout marks the items sold",
  "UPDATE items SET status='sold', txn_id=?, sold_at=?, listing_status=CASE WHEN listing_status='live' THEN 'hidden' ELSE listing_status END WHERE id IN (");
const SQL_CHECKOUT_ITEMS = "UPDATE items SET status='sold', txn_id=?, sold_at=?, " +
  "listing_status=CASE WHEN listing_status='live' THEN 'hidden' ELSE listing_status END WHERE id IN (?,?)";
const SQL_VOID_TXN = live("void marks the transaction",
  "UPDATE txns SET status='void', voided_at=?, void_reason=? WHERE id=?");
const SQL_VOID_ITEMS = live("void puts the items back",
  "UPDATE items SET status='available', txn_id=NULL, sold_at=NULL WHERE txn_id=?");
const SQL_REVENUE = live("the sales list skips voided takings",
  "(SELECT COALESCE(SUM(total_cents),0) FROM txns t WHERE t.sale_id=s.id AND t.status='complete') AS revenue_cents");
const SQL_SUMMARY = live("the summary skips voided takings",
  "SELECT COALESCE(SUM(total_cents),0) AS revenue_cents, COUNT(*) AS txn_count FROM txns WHERE sale_id=? AND status='complete'");
const SQL_DELETE_GUARD = live("the delete guard skips voided takings",
  "SELECT COUNT(*) AS n FROM txns WHERE sale_id=? AND status='complete'");

// Sell the crock and the candlesticks together for $240.
function sell(db, ids, txnId = "t1", at = "2026-08-04T14:00:00Z", tender = "cash") {
  const total = ids.map(i => db.prepare("SELECT price_cents c FROM items WHERE id=?").get(i).c).reduce((a, b) => a + b, 0);
  db.prepare(SQL_CHECKOUT_TXN).run(txnId, "sa1", total, ids.length, tender, at);
  db.prepare(SQL_CHECKOUT_ITEMS).run(txnId, at, ...ids);
  return total;
}
function voidTxn(db, txnId = "t1", at = "2026-08-05T10:00:00Z", reason = "customer changed her mind") {
  db.prepare(SQL_VOID_TXN).run(at, reason, txnId);
  db.prepare(SQL_VOID_ITEMS).run(txnId);
}
const revenue = db => db.prepare(SQL_SUMMARY).get("sa1");
const item = (db, id) => db.prepare("SELECT * FROM items WHERE id=?").get(id);

{
  const db = seed();
  const total = sell(db, ["i1", "i2"]);
  eq("the sale rings up at the sum of its items", total, 24000);
  eq("takings before any void", revenue(db).revenue_cents, 24000);
  eq("one transaction counted", revenue(db).txn_count, 1);
  eq("a live listing is pulled down when the item sells", item(db, "i1").listing_status, "hidden");

  voidTxn(db);
  eq("voided takings stop counting", revenue(db).revenue_cents, 0);
  eq("a voided transaction is not counted as a transaction", revenue(db).txn_count, 0);
  ok("the transaction is kept, not deleted", !!db.prepare("SELECT 1 FROM txns WHERE id='t1'").get());
  eq("it is marked void", db.prepare("SELECT status FROM txns WHERE id='t1'").get().status, "void");
  eq("the reason is kept", db.prepare("SELECT void_reason r FROM txns WHERE id='t1'").get().r, "customer changed her mind");
  eq("the item is back on the shelf", item(db, "i1").status, "available");
  eq("and no longer attached to the transaction", item(db, "i1").txn_id, null);
  eq("and has no sale date", item(db, "i1").sold_at, null);
  eq("an item that was never in the transaction is untouched", item(db, "i3").status, "available");
  // Deliberate: we know the listing went live -> hidden, not that it should go back up.
  eq("a pulled listing stays down after a void", item(db, "i1").listing_status, "hidden");

  // The whole point of keeping the row: the drawer is short $240 and there is a line saying why.
  const t = db.prepare("SELECT * FROM txns WHERE id='t1'").get();
  eq("the voided amount is still legible for reconciling the drawer", t.total_cents, 24000);
  ok("and it carries the time it was voided", !!t.voided_at);
}

{
  // Voiding must not make a sale look like it still has takings you have to force past.
  const db = seed();
  sell(db, ["i1"]);
  eq("a sale with takings warns before deletion", db.prepare(SQL_DELETE_GUARD).get("sa1").n, 1);
  voidTxn(db);
  eq("once voided it does not", db.prepare(SQL_DELETE_GUARD).get("sa1").n, 0);
}

{
  // Two transactions, one voided: the other one's money must survive untouched.
  const db = seed();
  sell(db, ["i1"], "t1");
  sell(db, ["i3"], "t2", "2026-08-06T11:00:00Z");
  eq("both transactions count", revenue(db).revenue_cents, 22000);
  voidTxn(db, "t1");
  eq("voiding one leaves the other", revenue(db).revenue_cents, 4000);
  eq("and only its own items come back", item(db, "i3").status, "sold");
  eq("the untouched item keeps its sale date", item(db, "i3").sold_at, "2026-08-06T11:00:00Z");
}

// ---------- where a void meets a statement ----------
// Road Show and Bottle Tree are two workers over one database. Bottle Tree writes statements;
// Road Show only has to refuse to destroy items that are on one, so it does not run this query
// and must not be failed for its absence. Where the query does exist it still has to match.
const HAS_STATEMENTS_API = SOURCE.includes("FROM statements st JOIN sellers s");
const liveIfStatements = (name, sql) => HAS_STATEMENTS_API ? live(name, sql) : sql;
const SQL_SETTLE_ITEMS = liveIfStatements("a statement gathers a dealer's sold items",
  "SELECT i.id, i.name, i.price_cents, i.sold_at FROM items i " +
  "JOIN sales sa ON sa.id = i.sale_id " +
  "WHERE i.seller_id=? AND sa.user_id=? AND i.status='sold' " +
  "AND i.sold_at IS NOT NULL AND i.sold_at >= ? AND i.sold_at <= ? " +
  "ORDER BY i.sold_at, i.name");
live("the void looks for statements already handed over",
  "WHERE st.status IN ('issued','paid') AND si.item_id IN (");

const forDealer = db => db.prepare(SQL_SETTLE_ITEMS).all("se1", "u1", "2026-08-01", "2026-08-31￿");

{
  const db = seed();
  sell(db, ["i1", "i2"]);
  const before = settle({ items: forDealer(db), commission_pct: 35, rent_cents: 4500 });
  eq("the dealer's August gross before any void", before.gross_cents, 24000);
  eq("and her net", before.net_cents, 24000 - Math.round(24000 * 0.35) - 4500);

  voidTxn(db);
  const after = settle({ items: forDealer(db), commission_pct: 35, rent_cents: 4500 });
  // Clearing sold_at is what does this. Leaving it set and only changing status would have
  // left the returned goods on her next statement.
  eq("voided goods drop out of a statement built afterwards", after.gross_cents, 0);
  eq("she is left owing the rent", after.net_cents, -4500);
  ok("and that reads as owing", after.owes);
}

{
  // The case that has to hold: she was already paid for the crock, then it came back.
  const db = seed();
  sell(db, ["i1", "i2"]);
  const s = settle({ items: forDealer(db), commission_pct: 35, rent_cents: 4500 });
  db.prepare(
    "INSERT INTO statements (id,user_id,seller_id,period_start,period_end,basis,commission_pct,rent_cents," +
    "gross_cents,commission_cents,rent_charged_cents,adjust_cents,net_cents,item_count,status,created_at) " +
    "VALUES ('st1','u1','se1','2026-08-01','2026-08-31','sold_at',35,4500,?,?,?,0,?,?,'issued','2026-09-01T09:00:00Z')")
    .run(s.gross_cents, s.commission_cents, s.rent_charged_cents, s.net_cents, s.item_count);
  for (const l of s.lines)
    db.prepare("INSERT INTO statement_items (id,statement_id,item_id,name,price_cents,sold_at) VALUES (?,'st1',?,?,?,?)")
      .run("sl" + l.item_id, l.item_id, l.name, l.price_cents, l.sold_at);

  const hits = db.prepare(
    "SELECT st.id, st.status, COUNT(si.id) AS n, COALESCE(SUM(si.price_cents),0) AS cents " +
    "FROM statement_items si JOIN statements st ON st.id=si.statement_id " +
    "WHERE st.status IN ('issued','paid') AND si.item_id IN ('i1','i2') GROUP BY st.id").all();
  eq("the void can see the statement it would undercut", hits.length, 1);
  eq("and how many of its lines are involved", hits[0].n, 2);
  eq("and what they were worth", hits[0].cents, 24000);

  voidTxn(db);
  const frozen = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price_cents),0) c FROM statement_items WHERE statement_id='st1'").get();
  eq("the issued statement keeps its lines after the void", frozen.n, 2);
  eq("and its figures", frozen.c, 24000);
  eq("the statement's own total is untouched", db.prepare("SELECT gross_cents g FROM statements WHERE id='st1'").get().g, 24000);
  // This is the point of warning the owner: the correction lives on the NEXT statement.
  eq("September shows nothing of hers", settle({ items: db.prepare(SQL_SETTLE_ITEMS)
      .all("se1", "u1", "2026-09-01", "2026-09-30￿"), commission_pct: 35, rent_cents: 4500 }).gross_cents, 0);
}

{
  // A draft recomputes from the items, so it needs no warning and must not produce one.
  const db = seed();
  sell(db, ["i1"]);
  db.prepare(
    "INSERT INTO statements (id,user_id,seller_id,period_start,period_end,basis,commission_pct,rent_cents," +
    "gross_cents,commission_cents,rent_charged_cents,adjust_cents,net_cents,item_count,status,created_at) " +
    "VALUES ('st2','u1','se1','2026-08-01','2026-08-31','sold_at',35,4500,18000,6300,4500,0,7200,1,'draft','2026-09-01T09:00:00Z')").run();
  db.prepare("INSERT INTO statement_items (id,statement_id,item_id,name,price_cents,sold_at) VALUES ('sl9','st2','i1','Red Wing crock',18000,'2026-08-04T14:00:00Z')").run();
  const hits = db.prepare(
    "SELECT st.id FROM statement_items si JOIN statements st ON st.id=si.statement_id " +
    "WHERE st.status IN ('issued','paid') AND si.item_id IN ('i1')").all();
  eq("a draft statement raises no warning", hits.length, 0);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
