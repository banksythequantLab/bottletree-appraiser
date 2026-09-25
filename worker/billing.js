// Bottle Tree billing — estimates are metered; everything else is free.
// Wallet order when the dealer taps "Identify & price": unlimited plan -> pro plan (300/mo) -> credits -> 402.
// Grants arrive from RevenueCat (native app, Google Play) via webhook; Stripe web checkout can write the same ledger later.

export const PRODUCTS = {
  estimate_1:        { kind: "credits", credits: 1,  label: "1 estimate",            usd: 0.99 },
  estimate_10:       { kind: "credits", credits: 10, label: "10 estimates",          usd: 4.99 },
  pro_monthly:       { kind: "plan",    plan: "pro",       label: "Pro · 300 estimates / month", usd: 9.99 },
  unlimited_monthly: { kind: "plan",    plan: "unlimited", label: "Unlimited estimates",         usd: 29.99 },
};
export const PRO_MONTHLY_CAP = 300;

const now = () => new Date().toISOString();
const month = () => now().slice(0, 7);
const uid = () => crypto.randomUUID();

// Play subscription product ids reach RevenueCat as "productId:basePlanId"; normalise to our key.
export function productKey(productId) {
  const base = String(productId || "").split(":")[0];
  return PRODUCTS[base] ? base : null;
}

// Every new account starts with one free estimate, granted by the column default on
// users.credits. Nothing recorded it, so the ledger could not be reconciled against the
// wallet: every account sat exactly one credit ahead of its own history, which makes a drift
// check useless — a real leak of one credit would look identical to a healthy account.
// Recording the opening balance is what turns that check into something worth running.
export const WELCOME_CREDITS = 1;
export function welcomeGrant(db, userId, at) {
  return db.prepare("INSERT INTO billing_events (id,user_id,source,type,credits_delta,created_at) VALUES (?,?,'signup','welcome',?,?)")
    .bind(uid(), userId, WELCOME_CREDITS, at || now());
}

// What the ledger says an account should be holding. Only meaningful because the opening
// balance is now in it; accounts created before that, and any hand-topped-up wallet, will
// read as drifted, which is history rather than a fault.
export async function walletDrift(db, userId) {
  const u = await db.prepare("SELECT credits FROM users WHERE id=?").bind(userId).first();
  if (!u) return null;
  const l = await db.prepare("SELECT COALESCE(SUM(credits_delta),0) AS n FROM billing_events WHERE user_id=?").bind(userId).first();
  return { wallet: u.credits, ledger: l.n, drift: u.credits - l.n };
}

export async function planFor(db, userId) {
  const u = await db.prepare("SELECT plan, plan_expires_at, credits FROM users WHERE id=?").bind(userId).first();
  if (!u) return null;
  const active = u.plan !== "free" && (!u.plan_expires_at || new Date(u.plan_expires_at) > new Date());
  const used = (await db.prepare("SELECT count FROM usage WHERE user_id=? AND month=?").bind(userId, month()).first())?.count || 0;
  const plan = active ? u.plan : "free";
  const planLeft = plan === "unlimited" ? Infinity : plan === "pro" ? Math.max(0, PRO_MONTHLY_CAP - used) : 0;
  return {
    plan, plan_expires_at: active ? u.plan_expires_at : null, credits: u.credits, used_this_month: used,
    monthly_cap: plan === "pro" ? PRO_MONTHLY_CAP : null,
    can_estimate: planLeft > 0 || u.credits > 0,
    products: PRODUCTS,
  };
}

// Take one estimate from the best wallet. Returns "plan" | "credit" | null (nothing left).
export async function consumeEstimate(db, userId) {
  const p = await planFor(db, userId);
  if (!p) return null;
  const planLeft = p.plan === "unlimited" ? Infinity : p.plan === "pro" ? PRO_MONTHLY_CAP - p.used_this_month : 0;
  if (planLeft > 0) {
    await db.prepare("INSERT INTO usage (user_id,month,count) VALUES (?,?,1) ON CONFLICT(user_id,month) DO UPDATE SET count=count+1")
      .bind(userId, month()).run();
    return "plan";
  }
  // atomic decrement — two taps in flight can't both succeed on the last credit
  const r = await db.prepare("UPDATE users SET credits=credits-1 WHERE id=? AND credits>0").bind(userId).run();
  if (!r.meta.changes) return null;
  await db.prepare("INSERT INTO billing_events (id,user_id,source,type,credits_delta,created_at) VALUES (?,?,'usage','spend',-1,?)")
    .bind(uid(), userId, now()).run();
  return "credit";
}

export async function refundEstimate(db, userId, fundedBy, reason) {
  if (fundedBy === "credit") {
    await db.prepare("UPDATE users SET credits=credits+1 WHERE id=?").bind(userId).run();
    await db.prepare("INSERT INTO billing_events (id,user_id,source,type,credits_delta,raw_json,created_at) VALUES (?,?,'usage','refund',1,?,?)")
      .bind(uid(), userId, JSON.stringify({ reason }), now()).run();
  } else if (fundedBy === "plan") {
    await db.prepare("UPDATE usage SET count=MAX(0,count-1) WHERE user_id=? AND month=?").bind(userId, month()).run();
  }
}

// RevenueCat has no REFUND webhook type. Checked against RevenueCat's own
// event-types-and-fields docs, Sep 2026: the types are INITIAL_PURCHASE, RENEWAL,
// CANCELLATION, UNCANCELLATION, NON_RENEWING_PURCHASE, SUBSCRIPTION_PAUSED, EXPIRATION,
// BILLING_ISSUE, PRODUCT_CHANGE, SUBSCRIPTION_EXTENDED, REFUND_REVERSED, INVOICE_ISSUANCE,
// TRANSFER, TEST. A refund arrives as CANCELLATION — "A subscription or non-renewing
// purchase was canceled or refunded" — and cancel_reason says which it was. So the old
// `type === "REFUND"` branch never fired against the real store: a refunded ten-pack kept
// its ten credits. "REFUND" is still accepted below, as a free alias, in case RevenueCat
// ever sends one; it is not what closes the hole.
const REFUND_TYPES = new Set(["CANCELLATION", "REFUND"]);

// cancel_reason vocabulary (shared with expiration_reason): UNSUBSCRIBE, BILLING_ERROR,
// DEVELOPER_INITIATED, PRICE_INCREASE, CUSTOMER_SUPPORT, UNKNOWN, SUBSCRIPTION_PAUSED.
// Only two of those mean the money went back. The rest are a subscriber who switched off
// auto-renew, a card that failed, or a price rise they declined — all of whom keep the
// month they paid for, and all of whom get an EXPIRATION when it runs out. UNKNOWN is
// deliberately not a refund: revoking on a guess bills a paying shop for our uncertainty.
const REFUND_REASONS = new Set(["CUSTOMER_SUPPORT", "DEVELOPER_INITIATED"]);
export function cancelIsRefund(ev) {
  return REFUND_REASONS.has(String((ev && (ev.cancel_reason || ev.cancellation_reason)) || "").toUpperCase());
}

// RevenueCat webhook (https://www.revenuecat.com/docs/integrations/webhooks). Body: { api_version, event: {...} }.
// Returns { ok, applied, note }. Idempotent on event.id.
export async function applyRevenueCatEvent(db, ev) {
  const type = ev.type;
  const userId = ev.app_user_id && !String(ev.app_user_id).startsWith("$RCAnonymousID:") ? ev.app_user_id : null;
  const key = productKey(ev.product_id);
  if (type === "TEST") return { ok: true, applied: false, note: "test event" };
  if (!userId) return { ok: true, applied: false, note: "anonymous app_user_id; user must be logged in" };
  const u = await db.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
  if (!u) return { ok: true, applied: false, note: "unknown user" };
  const dup = ev.id && (await db.prepare("SELECT id FROM billing_events WHERE event_id=?").bind(ev.id).first());
  if (dup) return { ok: true, applied: false, note: "duplicate" };

  const prod = key ? PRODUCTS[key] : null;
  let creditsDelta = 0, plan = null, planExpires = null, applied = false, grant = null, unrecovered = 0;

  // The grant is BUILT here and run below, together with the ledger row, in one transaction.
  // Running them as two separate awaits was a money leak: RevenueCat retries on any non-2xx,
  // so if the worker died or D1 hiccuped after the credits landed but before the ledger row
  // was written, the retry found no row to dedupe against and granted the purchase a second
  // time. Silently — the ledger would show one grant and the user would have two.
  if (prod?.kind === "credits" && (type === "NON_RENEWING_PURCHASE" || type === "INITIAL_PURCHASE" || type === "REFUND_REVERSED")) {
    creditsDelta = prod.credits; applied = true;
    grant = db.prepare("UPDATE users SET credits=credits+?, rc_app_user_id=? WHERE id=?").bind(creditsDelta, ev.original_app_user_id || userId, userId);
  } else if (prod?.kind === "credits" && REFUND_TYPES.has(type)) {
    // A credit pack does not auto-renew, so there is no auto-renew to switch off: any
    // CANCELLATION on one is the store handing the money back. No cancel_reason check here.
    //
    // Take back what is actually there, and record that number. The wallet floors at zero —
    // a shop that already spent refunded credits got free estimates, and a negative balance
    // would silently eat their next purchase — so writing -10 into the ledger when only 3
    // came back would put the wallet and its history permanently out of step and make
    // walletDrift cry wolf for ever after. The shortfall is kept in raw_json instead, where
    // it is a fact about one refund rather than a phantom bug in every later drift check.
    const held = await db.prepare("SELECT credits FROM users WHERE id=?").bind(userId).first();
    const took = Math.min(prod.credits, Math.max(0, (held && held.credits) || 0));
    unrecovered = prod.credits - took;
    creditsDelta = -took; applied = true;
    grant = db.prepare("UPDATE users SET credits=MAX(0,credits-?) WHERE id=?").bind(took, userId);
  } else if (prod?.kind === "plan") {
    if (["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "TRANSFER", "REFUND_REVERSED"].includes(type)) {
      plan = prod.plan; planExpires = ev.expiration_at_ms ? new Date(ev.expiration_at_ms).toISOString() : null; applied = true;
      grant = db.prepare("UPDATE users SET plan=?, plan_expires_at=?, rc_app_user_id=? WHERE id=?").bind(plan, planExpires, ev.original_app_user_id || userId, userId);
    } else if (type === "EXPIRATION" || (REFUND_TYPES.has(type) && cancelIsRefund(ev))) {
      // A refunded subscription loses access now, not at the end of the month it was paid
      // back for. The plan guard matters: a Pro EXPIRATION arriving after an upgrade to
      // Unlimited must not knock the new plan out, and the same is true of a late refund.
      plan = "free"; applied = true;
      grant = db.prepare("UPDATE users SET plan='free', plan_expires_at=NULL WHERE id=? AND plan=?").bind(userId, prod.plan);
    }
    // CANCELLATION that is not a refund, and BILLING_ISSUE: they paid for the month, so
    // access continues until expiration_at_ms and EXPIRATION arrives then. SUBSCRIPTION_PAUSED
    // is the same — RevenueCat is explicit that access is revoked on the EXPIRATION that
    // follows it, not on the pause itself.
  }

  const ledger = db.prepare("INSERT INTO billing_events (id,user_id,source,event_id,type,product_id,credits_delta,plan,raw_json,created_at) VALUES (?,?,'revenuecat',?,?,?,?,?,?,?)")
    .bind(uid(), userId, ev.id || null, type, ev.product_id || null, creditsDelta, plan,
          JSON.stringify(unrecovered ? { ...ev, _unrecovered_credits: unrecovered } : ev).slice(0, 8000), now());
  try {
    // D1's batch is a transaction: either the grant and its record both land, or neither does.
    await db.batch(grant ? [grant, ledger] : [ledger]);
  } catch (e) {
    // billing_events.event_id is UNIQUE, so two deliveries racing past the check above collide
    // here and the whole batch rolls back — including the second grant. That is the constraint
    // doing its job, not a failure, so it is answered 2xx and RevenueCat stops retrying.
    if (/UNIQUE|constraint/i.test(String(e && e.message))) return { ok: true, applied: false, note: "duplicate" };
    throw e;
  }
  return { ok: true, applied, note: applied ? `${type} ${key || ev.product_id}` : `ignored ${type} ${ev.product_id || ""}` };
}
