// The RevenueCat path — the one that actually takes money today. Run against a real SQLite
// database built from the real migrations, through a D1-shaped shim, so the transaction the
// code depends on is a transaction here too.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { d1 } from "./d1shim.mjs";
import { applyRevenueCatEvent, planFor, consumeEstimate, refundEstimate, productKey, PRODUCTS, PRO_MONTHLY_CAP,
         welcomeGrant, walletDrift, WELCOME_CREDITS } from "../billing.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
let passed = 0, failed = 0;
const ok = (n, c, d = "") => { c ? passed++ : (failed++, console.log(`FAIL  ${n}${d ? "  — " + d : ""}`)); };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

function shop() {
  const db = d1(MIG);
  db.raw.exec(`INSERT INTO users (id,email,pw_hash,pw_salt,created_at,credits,plan)
               VALUES ('u1','a@b.c','x','y','2026-09-01T09:00:00Z',0,'free')`);
  return db;
}
const user = db => db.raw.prepare("SELECT * FROM users WHERE id='u1'").get();
const ledger = db => db.raw.prepare("SELECT * FROM billing_events ORDER BY created_at, id").all();
const ev = (o = {}) => ({ id: "ev_1", type: "NON_RENEWING_PURCHASE", app_user_id: "u1", product_id: "estimate_10", ...o });

// ---------- product ids ----------
eq("a plain product id maps", productKey("estimate_10"), "estimate_10");
// Play sends subscriptions as "productId:basePlanId".
eq("a Play base plan suffix is stripped", productKey("pro_monthly:p1m"), "pro_monthly");
eq("an unknown product is not invented", productKey("free_stuff"), null);
eq("and neither is nothing", productKey(undefined), null);

{
  const db = shop();
  const r = await applyRevenueCatEvent(db, ev());
  ok("a ten-pack is applied", r.applied);
  eq("ten credits land", user(db).credits, 10);
  eq("one ledger row", ledger(db).length, 1);
  eq("recording what moved", ledger(db)[0].credits_delta, 10);
  eq("and where it came from", ledger(db)[0].source, "revenuecat");
  eq("the RevenueCat id is kept for dedupe", ledger(db)[0].event_id, "ev_1");
}

{
  // RevenueCat retries until it gets a 2xx, so the same event id arrives more than once.
  const db = shop();
  await applyRevenueCatEvent(db, ev());
  const again = await applyRevenueCatEvent(db, ev());
  eq("a repeat is not applied", again.applied, false);
  eq("and says why", again.note, "duplicate");
  eq("credits are not granted twice", user(db).credits, 10);
  eq("and the ledger keeps one row", ledger(db).length, 1);
}

{
  // The bug this file was written for. The grant and the ledger row used to be two separate
  // awaits, so a failure between them left credits granted with nothing to dedupe against —
  // and RevenueCat's retry granted them again. They are now one transaction, which means a
  // duplicate ledger row rolls the grant back with it.
  const db = shop();
  await applyRevenueCatEvent(db, ev());
  eq("first delivery grants", user(db).credits, 10);
  // Force the collision the dedupe check would normally catch: a second delivery that gets
  // past it, exactly as two concurrent deliveries would.
  const raced = await applyRevenueCatEvent({ ...db, prepare: sql =>
    // Blind the duplicate lookup, leave everything else alone.
    /SELECT id FROM billing_events WHERE event_id=\?/.test(sql)
      ? { bind: () => ({ first: async () => null }) } : db.prepare(sql) }, ev());
  eq("the racing delivery is refused by the constraint", raced.note, "duplicate");
  eq("and its grant was rolled back with it", user(db).credits, 10);
  eq("leaving one row, not two", ledger(db).length, 1);
}

{
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "ev_a", product_id: "estimate_1" }));
  await applyRevenueCatEvent(db, ev({ id: "ev_b", product_id: "estimate_10" }));
  eq("separate purchases both count", user(db).credits, 11);
  eq("each with its own row", ledger(db).length, 2);
}

// ---------- who a grant belongs to ----------
{
  const db = shop();
  // Someone who bought before signing in has no account to credit. Crediting a made-up id, or
  // the anonymous one, would put a stranger's purchase somewhere it can never be found.
  const anon = await applyRevenueCatEvent(db, ev({ app_user_id: "$RCAnonymousID:abc123" }));
  eq("an anonymous purchase is not applied", anon.applied, false);
  ok("and says the buyer has to be signed in", /logged in/.test(anon.note));
  eq("nothing is credited", user(db).credits, 0);
  eq("and nothing is written", ledger(db).length, 0);

  const ghost = await applyRevenueCatEvent(db, ev({ app_user_id: "nobody" }));
  eq("an unknown user is not applied", ghost.applied, false);
  eq("with a reason", ghost.note, "unknown user");
  eq("and still nothing written", ledger(db).length, 0);

  const test = await applyRevenueCatEvent(db, ev({ type: "TEST" }));
  eq("RevenueCat's own test event is a no-op", test.applied, false);
  eq("and leaves no trace", ledger(db).length, 0);
}

// ---------- subscriptions ----------
{
  const db = shop();
  const exp = Date.UTC(2026, 9, 24, 12, 0, 0);
  const r = await applyRevenueCatEvent(db, ev({ id: "s1", type: "INITIAL_PURCHASE", product_id: "pro_monthly:p1m", expiration_at_ms: exp }));
  ok("a subscription is applied", r.applied);
  eq("the plan is set", user(db).plan, "pro");
  eq("with the expiry RevenueCat gave", user(db).plan_expires_at, new Date(exp).toISOString());

  const p = await planFor(db, "u1");
  eq("the plan reads back", p.plan, "pro");
  eq("with this month's allowance", p.monthly_cap, PRO_MONTHLY_CAP);
  ok("and they can appraise", p.can_estimate);

  await applyRevenueCatEvent(db, ev({ id: "s2", type: "RENEWAL", product_id: "pro_monthly:p1m", expiration_at_ms: exp + 86400000 }));
  eq("a renewal pushes the expiry out", user(db).plan_expires_at, new Date(exp + 86400000).toISOString());
  eq("and does not change the plan", user(db).plan, "pro");

  await applyRevenueCatEvent(db, ev({ id: "s3", type: "CANCELLATION", product_id: "pro_monthly:p1m" }));
  // Cancelling is not losing access — they paid for the month. EXPIRATION arrives at the end.
  eq("cancelling leaves the plan alone", user(db).plan, "pro");
  eq("but is still recorded", ledger(db).filter(r => r.type === "CANCELLATION").length, 1);

  await applyRevenueCatEvent(db, ev({ id: "s4", type: "EXPIRATION", product_id: "pro_monthly:p1m" }));
  eq("expiry drops them to free", user(db).plan, "free");
  eq("and clears the date", user(db).plan_expires_at, null);
}

{
  // An expiry for a plan they are no longer on must not knock them off a newer one. Someone
  // who upgrades Pro -> Unlimited gets Pro's EXPIRATION afterwards.
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "u_a", type: "INITIAL_PURCHASE", product_id: "unlimited_monthly" }));
  eq("they are on unlimited", user(db).plan, "unlimited");
  await applyRevenueCatEvent(db, ev({ id: "u_b", type: "EXPIRATION", product_id: "pro_monthly:p1m" }));
  eq("the old plan's expiry does not touch the new one", user(db).plan, "unlimited");
}

{
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "r1", product_id: "estimate_10" }));
  await applyRevenueCatEvent(db, ev({ id: "r2", type: "REFUND", product_id: "estimate_10" }));
  eq("a refund takes the credits back", user(db).credits, 0);
  eq("and is on the record", ledger(db).filter(r => r.credits_delta === -10).length, 1);
}

{
  // A refund after the credits are spent must not leave a negative balance that silently eats
  // the next purchase.
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "n1", product_id: "estimate_1" }));
  eq("one credit", user(db).credits, 1);
  await consumeEstimate(db, "u1");
  eq("spent", user(db).credits, 0);
  await applyRevenueCatEvent(db, ev({ id: "n2", type: "REFUND", product_id: "estimate_1" }));
  eq("the refund cannot push the balance below zero", user(db).credits, 0);
}

// ---------- spending it ----------
{
  const db = shop();
  eq("a new shop cannot appraise", (await planFor(db, "u1")).can_estimate, false);
  eq("and taking one gives nothing", await consumeEstimate(db, "u1"), null);

  await applyRevenueCatEvent(db, ev({ id: "c1", product_id: "estimate_1" }));
  eq("one credit buys one appraisal", await consumeEstimate(db, "u1"), "credit");
  eq("the balance goes down", user(db).credits, 0);
  eq("and the spend is on the ledger", ledger(db).filter(r => r.type === "spend").length, 1);
  eq("a second attempt gets nothing", await consumeEstimate(db, "u1"), null);
  eq("and does not go negative", user(db).credits, 0);

  // An appraisal that fails should not cost anything.
  await refundEstimate(db, "u1", "credit", "vision model failed");
  eq("a failed appraisal gives the credit back", user(db).credits, 1);
  eq("with the reason kept", JSON.parse(ledger(db).find(r => r.type === "refund").raw_json).reason, "vision model failed");
}

{
  // A plan is spent before credits, so bought credits are not burned while a subscription is
  // sitting unused.
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "p1", type: "INITIAL_PURCHASE", product_id: "pro_monthly:p1m" }));
  await applyRevenueCatEvent(db, ev({ id: "p2", product_id: "estimate_10" }));
  eq("they have both", user(db).credits, 10);
  eq("the plan pays first", await consumeEstimate(db, "u1"), "plan");
  eq("credits are untouched", user(db).credits, 10);
  eq("the month's usage went up", (await planFor(db, "u1")).used_this_month, 1);

  await refundEstimate(db, "u1", "plan", "failed");
  eq("a refunded plan appraisal comes off the month", (await planFor(db, "u1")).used_this_month, 0);
}

{
  // The cap is what "300 a month" means. At the cap the plan stops paying and credits take over.
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "cap", type: "INITIAL_PURCHASE", product_id: "pro_monthly:p1m" }));
  const m = new Date().toISOString().slice(0, 7);
  db.raw.prepare("INSERT INTO usage (user_id,month,count) VALUES ('u1',?,?)").run(m, PRO_MONTHLY_CAP);
  const p = await planFor(db, "u1");
  eq("at the cap there is none of the plan left", p.used_this_month, PRO_MONTHLY_CAP);
  eq("and no credits either", p.can_estimate, false);
  eq("so an appraisal is refused", await consumeEstimate(db, "u1"), null);

  await applyRevenueCatEvent(db, ev({ id: "cap2", product_id: "estimate_1" }));
  eq("a credit bought at the cap is what pays", await consumeEstimate(db, "u1"), "credit");
}

{
  // Unlimited means unlimited: no cap to run into.
  const db = shop();
  await applyRevenueCatEvent(db, ev({ id: "un", type: "INITIAL_PURCHASE", product_id: "unlimited_monthly" }));
  const m = new Date().toISOString().slice(0, 7);
  db.raw.prepare("INSERT INTO usage (user_id,month,count) VALUES ('u1',?,99999)").run(m);
  ok("still able to appraise after 99999", (await planFor(db, "u1")).can_estimate);
  eq("and the plan pays", await consumeEstimate(db, "u1"), "plan");
  eq("no monthly cap is claimed", (await planFor(db, "u1")).monthly_cap, null);
}

{
  // An expired subscription must stop paying even if nothing told us it ended.
  const db = shop();
  db.raw.prepare("UPDATE users SET plan='pro', plan_expires_at=? WHERE id='u1'").run("2020-01-01T00:00:00Z");
  const p = await planFor(db, "u1");
  eq("a lapsed plan reads as free", p.plan, "free");
  eq("and pays for nothing", p.can_estimate, false);
  eq("nor does it quietly stay pro", await consumeEstimate(db, "u1"), null);
}

// ---------- the ledger has to add up ----------
{
  // A new account holds one free estimate from the column default. Nothing used to record it,
  // so every account read as one credit ahead of its own history and a drift check could not
  // tell a healthy wallet from one that had leaked a credit.
  const db = d1(MIG);
  const ts = "2026-09-24T09:00:00Z";
  await db.batch([
    db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES ('u1','a@b.c','x','y',?)").bind(ts),
    welcomeGrant(db, "u1", ts),
  ]);
  eq("the welcome credit is in the wallet", user(db).credits, WELCOME_CREDITS);
  eq("and on the ledger", ledger(db).filter(r => r.type === "welcome").length, 1);
  eq("attributed to signing up", ledger(db)[0].source, "signup");
  eq("a fresh account reconciles", (await walletDrift(db, "u1")).drift, 0);

  await applyRevenueCatEvent(db, ev({ id: "w1", product_id: "estimate_10" }));
  eq("still reconciles after a purchase", (await walletDrift(db, "u1")).drift, 0);
  await consumeEstimate(db, "u1");
  eq("and after spending one", (await walletDrift(db, "u1")).drift, 0);
  await refundEstimate(db, "u1", "credit", "failed");
  eq("and after a refund", (await walletDrift(db, "u1")).drift, 0);
  eq("the wallet is what the history says", (await walletDrift(db, "u1")).wallet, 11);

  // The check has to be able to see a leak, or it is decoration.
  db.raw.prepare("UPDATE users SET credits=credits+5 WHERE id='u1'").run();
  eq("credits appearing from nowhere show up as drift", (await walletDrift(db, "u1")).drift, 5);
  eq("and an unknown account has no answer", await walletDrift(db, "nobody"), null);
}

{
  // The account and its opening balance are one transaction, so a half-made account cannot
  // exist holding a credit nothing accounts for.
  const db = d1(MIG);
  let threw = false;
  try {
    await db.batch([
      db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES ('u2','c@d.e','x','y','2026-09-24T09:00:00Z')"),
      db.prepare("INSERT INTO billing_events (id,user_id,source,type,credits_delta,created_at) VALUES (?,?,'signup','welcome',1,?)")
        .bind("dup", "u2", null),   // created_at is NOT NULL: this fails, and takes the account with it
    ]);
  } catch { threw = true; }
  ok("a failed opening balance fails the signup", threw);
  eq("and leaves no account behind", db.raw.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
}

eq("the price list is the one on the paywall", Object.keys(PRODUCTS).join(","),
   "estimate_1,estimate_10,pro_monthly,unlimited_monthly");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
