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
  let creditsDelta = 0, plan = null, planExpires = null, applied = false;

  if (prod?.kind === "credits" && (type === "NON_RENEWING_PURCHASE" || type === "INITIAL_PURCHASE")) {
    creditsDelta = prod.credits; applied = true;
    await db.prepare("UPDATE users SET credits=credits+?, rc_app_user_id=? WHERE id=?").bind(creditsDelta, ev.original_app_user_id || userId, userId).run();
  } else if (prod?.kind === "plan") {
    if (["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "TRANSFER"].includes(type)) {
      plan = prod.plan; planExpires = ev.expiration_at_ms ? new Date(ev.expiration_at_ms).toISOString() : null; applied = true;
      await db.prepare("UPDATE users SET plan=?, plan_expires_at=?, rc_app_user_id=? WHERE id=?").bind(plan, planExpires, ev.original_app_user_id || userId, userId).run();
    } else if (type === "EXPIRATION") {
      plan = "free"; applied = true;
      await db.prepare("UPDATE users SET plan='free', plan_expires_at=NULL WHERE id=? AND plan=?").bind(userId, prod.plan).run();
    }
    // CANCELLATION / BILLING_ISSUE: access continues until expiration_at_ms; EXPIRATION will arrive then.
  } else if (type === "REFUND" && prod?.kind === "credits") {
    creditsDelta = -prod.credits; applied = true;
    await db.prepare("UPDATE users SET credits=MAX(0,credits+?) WHERE id=?").bind(creditsDelta, userId).run();
  }

  await db.prepare("INSERT INTO billing_events (id,user_id,source,event_id,type,product_id,credits_delta,plan,raw_json,created_at) VALUES (?,?,'revenuecat',?,?,?,?,?,?,?)")
    .bind(uid(), userId, ev.id || null, type, ev.product_id || null, creditsDelta, plan, JSON.stringify(ev).slice(0, 8000), now()).run();
  return { ok: true, applied, note: applied ? `${type} ${key || ev.product_id}` : `ignored ${type} ${ev.product_id || ""}` };
}
