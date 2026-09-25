// The online store's orders: what a Stripe webhook means, and what the shop ends up holding.
//
// The decision rules are pure and tested as rules. The consequences are then replayed against
// a real SQLite database built from the real migrations, because "the item comes off the shelf"
// and "the buyer is owed a refund" are claims about rows, not about my intentions.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webhookAction, sessionIsPaid, fulfilResult, needsAttention, NEEDS_REFUND_NOTE } from "../orders.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
const ok = (n, c, d = "") => { c ? passed++ : (failed++, console.log(`FAIL  ${n}${d ? "  — " + d : ""}`)); };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const ev = (type, o = {}) => ({ type, data: { object: { id: "cs_1", metadata: { item_id: "i1" }, ...o } } });

// ---------- the rules ----------
eq("a completed session that is paid is fulfilled",
  webhookAction(ev("checkout.session.completed", { payment_status: "paid" })).do, "fulfil");
// The bug this replaced: completed was treated as paid, so an ACH session that had not settled
// took the item off the shelf.
eq("a completed session that is still processing is not",
  webhookAction(ev("checkout.session.completed", { payment_status: "unpaid" })).do, "wait");
eq("and it is not cancelled either — the money is still moving",
  webhookAction(ev("checkout.session.completed", { payment_status: "unpaid" })).do !== "cancel", true);
eq("a completed session with no payment_status at all is not treated as money",
  webhookAction(ev("checkout.session.completed")).do, "wait");
eq("a zero-value session counts as settled",
  webhookAction(ev("checkout.session.completed", { payment_status: "no_payment_required" })).do, "fulfil");
eq("a late async success fulfils", webhookAction(ev("checkout.session.async_payment_succeeded")).do, "fulfil");
eq("a failed async payment cancels", webhookAction(ev("checkout.session.async_payment_failed")).do, "cancel");
eq("an expired checkout cancels", webhookAction(ev("checkout.session.expired")).do, "cancel");
eq("anything else is ignored", webhookAction(ev("payment_intent.created")).do, "ignore");
eq("a garbage event is ignored rather than throwing", webhookAction(null).do, "ignore");
eq("the item id is carried out of the metadata",
  webhookAction(ev("checkout.session.completed", { payment_status: "paid" })).item_id, "i1");
eq("a session with no metadata yields no item id",
  webhookAction({ type: "checkout.session.completed", data: { object: { id: "cs_2", payment_status: "paid" } } }).item_id, null);
eq("the buyer's email is carried through", webhookAction(ev("checkout.session.async_payment_succeeded",
  { customer_details: { email: "buyer@example.com" } })).email, "buyer@example.com");

// The owner is told to refund someone; they need somewhere to go and do it. A session id is
// not searchable in the Stripe dashboard, a payment intent has a page.
eq("a payment intent given as a string is carried", webhookAction(ev("checkout.session.completed",
  { payment_status: "paid", payment_intent: "pi_123" })).payment_intent, "pi_123");
eq("and one expanded into an object is too", webhookAction(ev("checkout.session.completed",
  { payment_status: "paid", payment_intent: { id: "pi_456" } })).payment_intent, "pi_456");
eq("and its absence is null, not undefined",
  webhookAction(ev("checkout.session.completed", { payment_status: "paid" })).payment_intent, null);

ok("payment_status paid is settled", sessionIsPaid({ payment_status: "paid" }));
ok("payment_status unpaid is not", !sessionIsPaid({ payment_status: "unpaid" }));
ok("a missing session is not", !sessionIsPaid(null));

eq("fulfilling when the item is there marks the order paid", fulfilResult(true).status, "paid");
eq("and nothing needs saying about it", fulfilResult(true).note, null);
eq("fulfilling when the item is gone flags a refund", fulfilResult(false).status, "needs_refund");
eq("and says so in words the owner can act on", fulfilResult(false).note, NEEDS_REFUND_NOTE);
ok("the refund note names the place to do it", /Refund this buyer in Stripe/.test(NEEDS_REFUND_NOTE));

ok("a paid order that has not been sent wants attention", needsAttention({ status: "paid", fulfilled_at: null }));
ok("once sent it does not", !needsAttention({ status: "paid", fulfilled_at: "2026-09-24T10:00:00Z" }));
ok("a refund-needed order always does", needsAttention({ status: "needs_refund", fulfilled_at: "2026-09-24T10:00:00Z" }));
ok("a pending order does not", !needsAttention({ status: "pending", fulfilled_at: null }));
ok("a cancelled order does not", !needsAttention({ status: "cancelled", fulfilled_at: null }));

// ---------- what the rows end up saying ----------
const WORKER = readFileSync(join(root, "worker.js"), "utf8");
const norm = s => s.replace(/\s+/g, " ").trim();
const SOURCE = norm(WORKER).replace(/"\s*\+\s*"/g, "");
const live = (name, sql) => { ok(`worker.js still runs: ${name}`, SOURCE.includes(norm(sql).replace(/"\s*\+\s*"/g, "")), norm(sql).slice(0, 80)); return sql; };

const SQL_SETTLE = live("settling an order records why it landed where it did",
  "UPDATE orders SET status=?, note=?, paid_at=?, updated_at=?, buyer_email=COALESCE(?,buyer_email), " +
  "payment_intent=COALESCE(?,payment_intent) WHERE stripe_session_id=?");
const SQL_CANCEL = live("cancelling only touches a live order",
  "UPDATE orders SET status='cancelled', note=?, updated_at=? WHERE stripe_session_id=? AND status='pending'");
const SQL_ALREADY = live("settling checks whether it already happened",
  "SELECT status FROM orders WHERE stripe_session_id=?");
const SQL_MINE = live("orders are scoped through the item to the shop",
  "SELECT o.*, i.name AS item_name, i.ai_title, i.status AS item_status " +
  "FROM orders o JOIN items i ON i.id=o.item_id JOIN sales s ON s.id=i.sale_id " +
  "WHERE s.user_id=? ORDER BY o.created_at DESC LIMIT 200");

function db2() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(root, "migrations")).filter(f => f.endsWith(".sql")).sort())
    db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  db.exec(`
    INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES
      ('u1','shop@a.c','x','y','2026-09-01T09:00:00Z'), ('u2','other@a.c','x','y','2026-09-01T09:00:00Z');
    INSERT INTO sales (id,name,status,created_at,user_id) VALUES
      ('sa1','Shop floor','open','2026-09-01T09:00:00Z','u1'), ('sa2','Theirs','open','2026-09-01T09:00:00Z','u2');
    INSERT INTO items (id,sale_id,name,price_cents,status,created_at,listing_status) VALUES
      ('i1','sa1','Red Wing crock',18000,'available','2026-09-01T09:00:00Z','live'),
      ('i9','sa2','Someone else''s lamp',5000,'available','2026-09-01T09:00:00Z','live');
    INSERT INTO orders (id,item_id,stripe_session_id,amount_cents,status,created_at) VALUES
      ('o1','i1','cs_1',18000,'pending','2026-09-20T10:00:00Z'),
      ('o9','i9','cs_9',5000,'paid','2026-09-20T10:00:00Z');`);
  return db;
}
// The worker's settle, minus the D1 wrapper: look for an existing outcome, sell if the item is
// still there, then write the order.
function settleOrder(db, sessionId, itemId, email, at = "2026-09-21T09:00:00Z", pi = "pi_test") {
  const existing = db.prepare(SQL_ALREADY).get(sessionId);
  if (existing && existing.status !== "pending") return { ...existing, already: true };
  const item = itemId ? db.prepare("SELECT * FROM items WHERE id=? AND status='available'").get(itemId) : null;
  const out = fulfilResult(!!item);
  if (item) {
    db.prepare("INSERT INTO txns (id,sale_id,total_cents,item_count,tender,created_at) VALUES (?,?,?,?,?,?)")
      .run("tx_" + sessionId, item.sale_id, item.price_cents, 1, "stripe", at);
    db.prepare("UPDATE items SET status='sold', txn_id=?, sold_at=?, listing_status='hidden' WHERE id=?")
      .run("tx_" + sessionId, at, item.id);
  }
  db.prepare(SQL_SETTLE).run(out.status, out.note, at, at, email || null, pi || null, sessionId);
  return out;
}
const order = (db, id) => db.prepare("SELECT * FROM orders WHERE id=?").get(id);

{
  const db = db2();
  const r = settleOrder(db, "cs_1", "i1", "buyer@example.com");
  eq("a normal online sale settles as paid", r.status, "paid");
  eq("the order is marked paid", order(db, "o1").status, "paid");
  eq("the buyer's email is kept so there is somewhere to send it", order(db, "o1").buyer_email, "buyer@example.com");
  ok("and the time the money landed", !!order(db, "o1").paid_at);
  eq("the item is sold", db.prepare("SELECT status s FROM items WHERE id='i1'").get().s, "sold");
  eq("and pulled off the storefront", db.prepare("SELECT listing_status l FROM items WHERE id='i1'").get().l, "hidden");
  eq("the takings include it", db.prepare("SELECT COALESCE(SUM(total_cents),0) c FROM txns WHERE sale_id='sa1' AND status='complete'").get().c, 18000);
  eq("recorded as an online card sale", db.prepare("SELECT tender t FROM txns WHERE sale_id='sa1'").get().t, "stripe");
  ok("it shows up as something to send", needsAttention(order(db, "o1")));
}

{
  // Stripe retries until it gets a 2xx, and sends completed then async_payment_succeeded for
  // the same session. Before the guard, the second delivery found the item gone — sold by this
  // very order — and told the owner to refund a perfectly good sale.
  const db = db2();
  settleOrder(db, "cs_1", "i1", "buyer@example.com");
  const again = settleOrder(db, "cs_1", "i1", "buyer@example.com");
  ok("a repeated webhook is recognised", again.already === true);
  eq("the order stays paid", order(db, "o1").status, "paid");
  eq("and is not turned into a refund", order(db, "o1").note, null);
  eq("the item is not sold twice", db.prepare("SELECT COUNT(*) n FROM txns WHERE sale_id='sa1'").get().n, 1);
  eq("and the takings are not doubled", db.prepare("SELECT COALESCE(SUM(total_cents),0) c FROM txns WHERE sale_id='sa1'").get().c, 18000);
}

{
  // The case nobody was told about: it sold on the shop floor while the bank was confirming.
  const db = db2();
  db.prepare("UPDATE items SET status='sold', sold_at='2026-09-20T15:00:00Z' WHERE id='i1'").run();
  const r = settleOrder(db, "cs_1", "i1", "buyer@example.com");
  eq("the buyer who paid for a thing that is gone is flagged", r.status, "needs_refund");
  eq("the order says what happened", order(db, "o1").note, NEEDS_REFUND_NOTE);
  ok("and it will not sit quietly", needsAttention(order(db, "o1")));
  eq("no second transaction is invented", db.prepare("SELECT COUNT(*) n FROM txns WHERE sale_id='sa1'").get().n, 0);
  // "Refund this buyer" needs a destination, or it is just a sentence.
  eq("the payment is recorded so the refund can be found", order(db, "o1").payment_intent, "pi_test");
  // Marking it sent has to be refused: there is nothing to send.
  eq("such an order is not in a state that can be sent", order(db, "o1").status === "paid", false);
}

{
  const db = db2();
  db.prepare(SQL_CANCEL).run("the checkout expired", "2026-09-21T09:00:00Z", "cs_1");
  eq("an expired checkout cancels the order", order(db, "o1").status, "cancelled");
  eq("with the reason on it", order(db, "o1").note, "the checkout expired");
  eq("the item stays on the shelf", db.prepare("SELECT status s FROM items WHERE id='i1'").get().s, "available");
  ok("and it is not something the owner has to do anything about", !needsAttention(order(db, "o1")));
}

{
  // A late expiry or a duplicated failure must never claw back a settled order.
  const db = db2();
  settleOrder(db, "cs_1", "i1", "buyer@example.com");
  db.prepare(SQL_CANCEL).run("the checkout expired", "2026-09-22T09:00:00Z", "cs_1");
  eq("a paid order cannot be cancelled by a late event", order(db, "o1").status, "paid");
}

{
  // Whose orders these are is decided by the item, since an order has no owner of its own.
  const db = db2();
  const mine = db.prepare(SQL_MINE).all("u1");
  eq("one shop sees only its own order", mine.length, 1);
  eq("and it is the right one", mine[0].id, "o1");
  eq("the item's name comes with it, so the list is readable", mine[0].item_name, "Red Wing crock");
  eq("the other shop sees only theirs", db.prepare(SQL_MINE).all("u2").length, 1);
  eq("and a stranger sees none", db.prepare(SQL_MINE).all("nobody").length, 0);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
