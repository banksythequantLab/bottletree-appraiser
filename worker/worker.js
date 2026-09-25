// Bottle Tree app v0.3 — API worker: accounts, sales, photos (R2), AI appraisals (Nebius), storefront + Stripe.
// Runs first for /api/*, /p/* (photos) and /shop/* (public storefront); everything else is static assets.
import { planFor, consumeEstimate, refundEstimate, applyRevenueCatEvent } from "./billing.js";
import { appraise } from "./appraiser.js";
import { settle, periodError, canTransition } from "./settlements.js";
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
function J(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders } });
}
function H(html, status = 200, cache = "public, max-age=60") {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function randHex(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const money = c => "$" + (Number(c || 0) / 100).toFixed(2);
const PHOTO_KINDS = new Set(["front", "back", "underside", "marks", "detail", "damage", "other"]);
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
function timingEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function getCookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
// ---- Google ID token verification (RS256 against Google's JWKS) ----
const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
let _jwks = { keys: [], at: 0 };
async function googleKeys() {
  if (Date.now() - _jwks.at < 3600e3 && _jwks.keys.length) return _jwks.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("jwks fetch failed");
  _jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return _jwks.keys;
}
/** Returns { sub, email, email_verified, name } or throws. Verifies signature, issuer, audience and expiry. */
async function verifyGoogleIdToken(idToken, clientId) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad signature");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("bad issuer");
  if (!clientId || claims.aud !== clientId) throw new Error("bad audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("token expired");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("email not verified");
  if (!claims.email) throw new Error("no email in token");
  return { sub: claims.sub, email: String(claims.email).trim().toLowerCase(), name: claims.name || "" };
}
function sessionCookie(token) { return `bt_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`; }
const clearCookie = "bt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

async function currentUser(req, db) {
  const tok = getCookie(req, "bt_session");
  if (!tok) return null;
  const s = await db.prepare("SELECT user_id, expires_at FROM sessions WHERE token=?").bind(tok).first();
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { await db.prepare("DELETE FROM sessions WHERE token=?").bind(tok).run(); return null; }
  return s.user_id;
}
async function newSession(db, userId) {
  const tok = randHex(24);
  const exp = new Date(Date.now() + 2592000000).toISOString();
  await db.prepare("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)").bind(tok, userId, now(), exp).run();
  return tok;
}

// ---------- appraisal ----------
// Runs inside the Worker: appraiser.js talks to Nebius Token Factory and Tavily directly. It used to
// POST to a FastAPI container, which meant something had to be hosted and awake; nothing does now.
// Set APPRAISER_URL to fall back to that container (the offline kiosk still runs it).
async function runAppraisal(env, appraisalId, item, photos) {
  const db = env.DB;
  try {
    const body = {
      item_id: item.id,
      description: item.description || "",
      markings: item.markings || "",
      currency: "USD",
      photos: photos.map(p => ({ url: `${env.PUBLIC_ORIGIN}/p/${p.r2_key}`, kind: p.kind })),
    };
    let result, text;
    if (env.APPRAISER_URL) {
      const headers = { "content-type": "application/json" };
      if (env.APPRAISER_SERVICE_KEY) headers["x-appraiser-key"] = env.APPRAISER_SERVICE_KEY;
      if (env.APPRAISER_TOKEN) headers["authorization"] = `Bearer ${env.APPRAISER_TOKEN}`;
      const r = await fetch(`${env.APPRAISER_URL}/appraise`, { method: "POST", headers, body: JSON.stringify(body) });
      text = await r.text();
      if (!r.ok) throw new Error(`appraiser ${r.status}: ${text.slice(0, 300)}`);
      result = JSON.parse(text);
    } else {
      result = await appraise(env, body);
      text = JSON.stringify(result);
    }
    await db.prepare("UPDATE appraisals SET status='done', result_json=?, model_text=?, model_vision=?, completed_at=? WHERE id=?")
      .bind(text, result.models?.text || null, result.models?.vision || null, now(), appraisalId).run();
    // pre-fill AI copy on the item (dealer still approves before it goes live)
    await db.prepare("UPDATE items SET ai_title=?, ai_description=? WHERE id=?")
      .bind(result.listing?.title || null, result.listing?.description || null, item.id).run();
  } catch (e) {
    await db.prepare("UPDATE appraisals SET status='error', error=?, completed_at=? WHERE id=?")
      .bind(String(e && e.message || e).slice(0, 1000), now(), appraisalId).run();
    // a failed run must not cost the dealer an estimate
    const ap = await db.prepare("SELECT funded_by FROM appraisals WHERE id=?").bind(appraisalId).first();
    const owner = await db.prepare("SELECT s.user_id FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=?").bind(item.id).first();
    if (ap?.funded_by && owner?.user_id) await refundEstimate(db, owner.user_id, ap.funded_by, "appraisal failed");
  }
}

async function itemBundle(db, itemId) {
  const item = await db.prepare("SELECT * FROM items WHERE id=?").bind(itemId).first();
  if (!item) return null;
  const photos = (await db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(itemId).all()).results;
  const ap = await db.prepare("SELECT * FROM appraisals WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  let appraisal = null;
  if (ap) appraisal = { id: ap.id, status: ap.status, error: ap.error, created_at: ap.created_at, completed_at: ap.completed_at,
                        result: ap.result_json ? JSON.parse(ap.result_json) : null };
  return { item, photos: photos.map(p => ({ ...p, url: `/p/${p.r2_key}` })), appraisal };
}

// ---------- Stripe (raw REST, no SDK) ----------
async function stripeCheckout(env, item, shop, photoUrl, origin) {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${origin}/shop/${shop.shop_slug}/item/${item.id}?paid=1`);
  form.set("cancel_url", `${origin}/shop/${shop.shop_slug}/item/${item.id}`);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(item.price_cents));
  form.set("line_items[0][price_data][product_data][name]", item.ai_title || item.name);
  if (photoUrl) form.set("line_items[0][price_data][product_data][images][0]", photoUrl);
  form.set("metadata[item_id]", item.id);
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST", headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" }, body: form,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "stripe error");
  return j;
}
async function verifyStripeSig(env, rawBody, sigHeader) {
  const parts = Object.fromEntries((sigHeader || "").split(",").map(kv => kv.split("=")));
  if (!parts.t || !parts.v1) return false;
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${parts.t}.${rawBody}`);
  return timingEq(expected, parts.v1);
}
async function markSoldOnline(db, itemId, sessionId, email) {
  const item = await db.prepare("SELECT * FROM items WHERE id=? AND status='available'").bind(itemId).first();
  if (!item) return false;
  const txnId = uid();
  await db.prepare("INSERT INTO txns (id,sale_id,total_cents,item_count,tender,created_at) VALUES (?,?,?,?,?,?)")
    .bind(txnId, item.sale_id, item.price_cents, 1, "stripe", now()).run();
  await db.prepare("UPDATE items SET status='sold', txn_id=?, sold_at=?, listing_status='hidden' WHERE id=?").bind(txnId, now(), itemId).run();
  await db.prepare("UPDATE orders SET status='paid', paid_at=?, buyer_email=? WHERE stripe_session_id=?").bind(now(), email || null, sessionId).run();
  return true;
}

// ---------- public storefront (server-rendered) ----------
const SHOP_CSS = `:root{--bg:#F4ECDC;--panel:#FBF6EA;--ink:#241B10;--sub:#6A5B44;--line:#E0D2B4;--green:#0F6B59;--cobalt:#1E44C4}
@media(prefers-color-scheme:dark){:root{--bg:#161210;--panel:#211B15;--ink:#F1E7D4;--sub:#B7A889;--line:#3A2F22;--green:#3FBBA0;--cobalt:#7C9BFF}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Nunito Sans",system-ui,sans-serif;line-height:1.5}
h1,h2,h3{font-family:Fraunces,Georgia,serif;font-weight:600;margin:0}.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header{padding:22px 0;border-bottom:1px solid var(--line);background:var(--panel)}header .wrap{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
header a{color:inherit;text-decoration:none}.blurb{color:var(--sub)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:22px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:block;color:inherit;text-decoration:none}
.card img{width:100%;aspect-ratio:1;object-fit:cover;background:#ddd}.card .b{padding:12px 14px}.card .t{font-weight:700}.card .p{color:var(--green);font-weight:800;margin-top:4px}
.item{display:grid;grid-template-columns:1fr;gap:22px;padding:22px 0}@media(min-width:760px){.item{grid-template-columns:1.1fr 1fr}}
.gal img{width:100%;border-radius:12px;border:1px solid var(--line);margin-bottom:10px}.thumbs{display:flex;gap:8px;flex-wrap:wrap}.thumbs img{width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line);cursor:pointer}
.price{font-family:Fraunces,serif;font-size:2rem;color:var(--green);margin:8px 0}.desc{white-space:pre-wrap;color:var(--ink)}
.btn{display:inline-block;background:var(--green);color:#fff;border:0;border-radius:11px;padding:14px 22px;font-weight:800;font-size:1rem;cursor:pointer;text-decoration:none}
.meta{font-size:.85rem;color:var(--sub);margin-top:14px}.pill{display:inline-block;font-size:.72rem;font-weight:800;padding:2px 9px;border-radius:20px;background:var(--line);color:var(--sub);margin-right:6px}
.empty{padding:60px 0;text-align:center;color:var(--sub)}footer{padding:30px 0;color:var(--sub);font-size:.8rem;text-align:center}.ok{background:var(--green);color:#fff;padding:10px 14px;border-radius:10px;margin:14px 0;font-weight:700}`;

function shopPage(shop, title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Nunito+Sans:wght@400;700;800&display=swap" rel="stylesheet">
<style>${SHOP_CSS}</style></head><body><header><div class="wrap"><h1><a href="/shop/${esc(shop.shop_slug)}">${esc(shop.shop_name || shop.shop_slug)}</a></h1>
${shop.shop_blurb ? `<span class="blurb">${esc(shop.shop_blurb)}</span>` : ""}</div></header><main class="wrap">${body}</main>
<footer>Powered by Bottle Tree · listings drafted with NVIDIA Nemotron on Nebius</footer></body></html>`;
}
function firstPhoto(photos) { return photos.find(p => p.kind === "front") || photos[0]; }

async function renderShop(db, slug) {
  const shop = await db.prepare("SELECT id, shop_slug, shop_name, shop_blurb FROM users WHERE shop_slug=?").bind(slug).first();
  if (!shop) return H("<h1>Shop not found</h1>", 404, "no-store");
  const items = (await db.prepare(
    "SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE s.user_id=? AND i.listing_status='live' AND i.status='available' ORDER BY i.listed_at DESC").bind(shop.id).all()).results;
  const ids = items.map(i => i.id);
  let photosBy = {};
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const ps = (await db.prepare(`SELECT * FROM photos WHERE item_id IN (${ph}) ORDER BY sort, created_at`).bind(...ids).all()).results;
    for (const p of ps) (photosBy[p.item_id] ||= []).push(p);
  }
  const cards = items.map(i => { const p = firstPhoto(photosBy[i.id] || []);
    return `<a class="card" href="/shop/${esc(slug)}/item/${i.id}"><img src="${p ? "/p/" + esc(p.r2_key) : ""}" alt="${esc(i.ai_title || i.name)}" loading="lazy"><div class="b"><div class="t">${esc(i.ai_title || i.name)}</div><div class="p">${money(i.price_cents)}</div></div></a>`; }).join("");
  const body = items.length ? `<div class="grid">${cards}</div>` : `<div class="empty">Nothing listed yet — check back soon.</div>`;
  return H(shopPage(shop, shop.shop_name || slug, body));
}

async function renderItem(db, env, slug, itemId, paid) {
  const shop = await db.prepare("SELECT id, shop_slug, shop_name, shop_blurb FROM users WHERE shop_slug=?").bind(slug).first();
  if (!shop) return H("<h1>Shop not found</h1>", 404, "no-store");
  const b = await itemBundle(db, itemId);
  if (!b || b.item.listing_status === "draft") return H(shopPage(shop, "Not found", `<div class="empty">Item not found.</div>`), 404, "no-store");
  const { item, photos, appraisal } = b;
  const sold = item.status !== "available" || item.listing_status !== "live";
  const ident = appraisal?.result?.identification || {};
  const main = firstPhoto(photos);
  const gallery = photos.length ? `<div class="gal"><img id="mainImg" src="${esc(main.url)}" alt=""><div class="thumbs">${photos.map(p => `<img src="${esc(p.url)}" alt="${esc(p.kind)}" onclick="document.getElementById('mainImg').src=this.src">`).join("")}</div></div>` : `<div class="gal"></div>`;
  const pills = [ident.maker, ident.period, ident.origin, appraisal?.result?.listing?.condition_grade].filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join("");
  const buy = sold ? `<div class="meta"><b>Sold</b></div>` : (env.STRIPE_SECRET_KEY
    ? `<form method="post" action="/api/public/checkout"><input type="hidden" name="item_id" value="${item.id}"><button class="btn">Buy now — ${money(item.price_cents)}</button></form>`
    : `<div class="meta">Contact the shop to purchase.</div>`);
  const body = `<div class="item">${gallery}<div>${paid ? `<div class="ok">Thank you — your payment went through.</div>` : ""}
<h2>${esc(item.ai_title || item.name)}</h2><div style="margin:8px 0">${pills}</div><div class="price">${money(item.price_cents)}</div>
<div class="desc">${esc(item.ai_description || item.description || "")}</div><div style="margin-top:18px">${buy}</div>
${item.markings ? `<div class="meta">Marks: ${esc(item.markings)}</div>` : ""}</div></div>`;
  return H(shopPage(shop, item.ai_title || item.name, body), 200, "no-store");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;
    const parts = p.split("/").filter(Boolean);
    const m = request.method;
    try {
      // ---------- PUBLIC: photos from R2 ----------
      if (parts[0] === "p" && parts.length >= 2 && m === "GET") {
        const obj = await env.PHOTOS.get(parts.slice(1).join("/"));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag } });
      }
      // ---------- PUBLIC: storefront ----------
      if (parts[0] === "shop" && m === "GET") {
        if (parts.length === 2) return renderShop(db, parts[1]);
        if (parts.length === 4 && parts[2] === "item") return renderItem(db, env, parts[1], parts[3], url.searchParams.get("paid") === "1");
        return H("<h1>Not found</h1>", 404, "no-store");
      }
      if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);

      // ---------- PUBLIC API: checkout + stripe webhook + shop JSON ----------
      if (parts[1] === "public") {
        if (parts[2] === "shop" && parts[3] && m === "GET") {
          const shop = await db.prepare("SELECT id, shop_slug, shop_name, shop_blurb FROM users WHERE shop_slug=?").bind(parts[3]).first();
          if (!shop) return J({ error: "not found" }, 404);
          const items = (await db.prepare("SELECT i.id, i.name, i.ai_title, i.ai_description, i.price_cents, i.listed_at FROM items i JOIN sales s ON s.id=i.sale_id WHERE s.user_id=? AND i.listing_status='live' AND i.status='available' ORDER BY i.listed_at DESC").bind(shop.id).all()).results;
          return J({ shop: { slug: shop.shop_slug, name: shop.shop_name, blurb: shop.shop_blurb }, items });
        }
        if (parts[2] === "checkout" && m === "POST") {
          if (!env.STRIPE_SECRET_KEY) return J({ error: "online checkout not enabled" }, 503);
          const ct = request.headers.get("content-type") || "";
          const itemId = ct.includes("json") ? (await readJson(request)).item_id : (await request.formData()).get("item_id");
          const row = await db.prepare("SELECT i.*, u.shop_slug, u.shop_name FROM items i JOIN sales s ON s.id=i.sale_id JOIN users u ON u.id=s.user_id WHERE i.id=? AND i.listing_status='live' AND i.status='available'").bind(itemId).first();
          if (!row) return J({ error: "item unavailable" }, 404);
          if (row.price_cents < 50) return J({ error: "price too low for card checkout" }, 400);
          const ph = await db.prepare("SELECT r2_key FROM photos WHERE item_id=? ORDER BY sort, created_at LIMIT 1").bind(row.id).first();
          const origin = env.PUBLIC_ORIGIN || url.origin;
          const sess = await stripeCheckout(env, row, row, ph ? `${origin}/p/${ph.r2_key}` : null, origin);
          await db.prepare("INSERT INTO orders (id,item_id,stripe_session_id,amount_cents,status,created_at) VALUES (?,?,?,?,'pending',?)").bind(uid(), row.id, sess.id, row.price_cents, now()).run();
          return ct.includes("json") ? J({ url: sess.url }) : Response.redirect(sess.url, 303);
        }
        if (parts[2] === "stripe-webhook" && m === "POST") {
          const raw = await request.text();
          if (!env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeSig(env, raw, request.headers.get("stripe-signature")))) return J({ error: "bad signature" }, 400);
          const ev = JSON.parse(raw);
          if (ev.type === "checkout.session.completed") {
            const s = ev.data.object;
            await markSoldOnline(db, s.metadata?.item_id, s.id, s.customer_details?.email);
          }
          return J({ received: true });
        }
        return J({ error: "not found" }, 404);
      }

      // ---------- BILLING: RevenueCat webhook (Authorization: Bearer <RC_WEBHOOK_SECRET>, set in the RC dashboard) ----------
      if (parts[1] === "billing" && parts[2] === "revenuecat" && m === "POST") {
        if (!env.RC_WEBHOOK_SECRET) return J({ error: "billing webhook not configured" }, 503);
        const auth = request.headers.get("authorization") || "";
        if (!timingEq(auth, `Bearer ${env.RC_WEBHOOK_SECRET}`)) return J({ error: "unauthorized" }, 401);
        const body = await readJson(request);
        if (!body.event) return J({ error: "no event" }, 400);
        return J(await applyRevenueCatEvent(db, body.event));
      }

      // ---------- eBay marketplace account deletion / closure notification ----------
      // eBay disables a production keyset until the developer either implements this endpoint or
      // declares they persist no eBay data. We do persist a little — up to six listing titles,
      // prices and URLs end up in a stored appraisal — so the honest route is to implement it
      // rather than sign a declaration that is arguably untrue.
      //
      // GET carries a challenge code and must be answered with
      //   sha256(challengeCode + verificationToken + endpointUrl)
      // hashed in exactly that order, hex encoded. The endpoint URL must match what is registered
      // with eBay character for character, which is why it is configuration and not derived from
      // the request — a proxy or a trailing slash would silently change the hash.
      if (parts[1] === "ebay" && parts[2] === "deletion") {
        if (!env.EBAY_VERIFY_TOKEN || !env.EBAY_DELETION_URL)
          return J({ error: "deletion endpoint not configured" }, 503);
        if (m === "GET") {
          const challenge = url.searchParams.get("challenge_code");
          if (!challenge) return J({ error: "challenge_code required" }, 400);
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(challenge + env.EBAY_VERIFY_TOKEN + env.EBAY_DELETION_URL));
          const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
          return J({ challengeResponse: hex });
        }
        if (m === "POST") {
          // Nothing of the deleting user's is held here: we never ask for eBay user tokens and
          // store no eBay account identifiers. Acknowledge so eBay does not retry, and leave a
          // trace so a compliance question later has an answer.
          const body = await readJson(request).catch(() => ({}));
          console.log("ebay account deletion notification", JSON.stringify({
            at: now(), notificationId: body?.notification?.notificationId || null,
          }));
          return new Response(null, { status: 204 });
        }
        return J({ error: "method not allowed" }, 405);
      }

      // ---------- DEVICE (Jetson kiosk) intake: X-Device-Key instead of a session ----------
      if (parts[1] === "device" && parts[2] === "intake" && m === "POST") {
        const key = request.headers.get("x-device-key") || "";
        const owner = key ? await db.prepare("SELECT id FROM users WHERE device_key=?").bind(key).first() : null;
        if (!owner) return J({ error: "bad device key" }, 401);
        const fd = await request.formData();
        const files = fd.getAll("photos").filter(f => typeof f === "object" && f.size);
        if (!files.length) return J({ error: "no photos" }, 400);
        const kinds = String(fd.get("kinds") || "").split(",").map(k => k.trim());
        let sale = await db.prepare("SELECT id FROM sales WHERE user_id=? AND name='Kiosk intake' AND status='open'").bind(owner.id).first();
        if (!sale) { sale = { id: uid() }; await db.prepare("INSERT INTO sales (id,name,status,created_at,user_id) VALUES (?,?,'open',?,?)").bind(sale.id, "Kiosk intake", now(), owner.id).run(); }
        let ap = null; try { ap = JSON.parse(String(fd.get("appraisal") || "")); } catch {}
        const title = String(fd.get("title") || "").trim() || ap?.listing?.title || "Kiosk item";
        const price_cents = Math.max(0, Math.round(Number(fd.get("price") || ap?.price_range?.suggested_retail || 0) * 100)) || 0;
        const itemId = uid();
        await db.prepare("INSERT INTO items (id,sale_id,name,price_cents,status,created_at,description,markings,ai_title,ai_description,source) VALUES (?,?,?,?,'available',?,?,?,?,?,'kiosk')")
          .bind(itemId, sale.id, title, price_cents, now(), String(fd.get("description") || "") || null, String(fd.get("markings") || "") || null,
                ap?.listing?.title || null, ap?.listing?.description || null).run();
        for (let i = 0; i < files.length; i++) {
          const f = files[i], ctype = f.type || "image/jpeg";
          const ext = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp" : "jpg";
          const rkey = `${itemId}/${uid()}.${ext}`;
          await env.PHOTOS.put(rkey, f.stream(), { httpMetadata: { contentType: ctype } });
          await db.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
            .bind(uid(), itemId, rkey, PHOTO_KINDS.has(kinds[i]) ? kinds[i] : "other", ctype, f.size, i, now()).run();
        }
        if (ap) await db.prepare("INSERT INTO appraisals (id,item_id,status,result_json,model_text,model_vision,created_at,completed_at) VALUES (?,?,'done',?,?,?,?,?)")
          .bind(uid(), itemId, JSON.stringify(ap), ap.models?.text || null, ap.models?.vision || null, now(), now()).run();
        return J({ item_id: itemId, sale_id: sale.id, photos: files.length });
      }

      // ---------- AUTH ----------
      if (parts[1] === "auth") {
        const act = parts[2];
        if (act === "register" && m === "POST") {
          const b = await readJson(request);
          const email = (b.email || "").trim().toLowerCase();
          const pw = b.password || "";
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J({ error: "Enter a valid email" }, 400);
          if (pw.length < 8) return J({ error: "Password must be at least 8 characters" }, 400);
          const exists = await db.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
          if (exists) return J({ error: "That email is already registered" }, 409);
          const salt = randHex(16), h = await pbkdf2(pw, salt), id = uid();
          await db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES (?,?,?,?,?)").bind(id, email, h, salt, now()).run();
          return J({ email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, id)) });
        }
        if (act === "login" && m === "POST") {
          const b = await readJson(request);
          const email = (b.email || "").trim().toLowerCase();
          const u = await db.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
          if (!u) return J({ error: "Wrong email or password" }, 401);
          // Google-only accounts carry an empty hash; never let that match a submitted password.
          if (!u.pw_hash) return J({ error: "This account uses Sign in with Google" }, 401);
          const h = await pbkdf2(b.password || "", u.pw_salt);
          if (!timingEq(h, u.pw_hash)) return J({ error: "Wrong email or password" }, 401);
          return J({ email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, u.id)) });
        }
        if (act === "google" && m === "POST") {
          if (!env.GOOGLE_CLIENT_ID) return J({ error: "Google sign-in is not configured" }, 503);
          const b = await readJson(request);
          let g;
          try { g = await verifyGoogleIdToken(b.credential, env.GOOGLE_CLIENT_ID); }
          catch (e) { return J({ error: "Could not verify that Google sign-in" }, 401); }
          // Match on sub first (email can change), then fall back to email to link an existing password account.
          let u = await db.prepare("SELECT * FROM users WHERE google_sub=?").bind(g.sub).first();
          if (!u) {
            u = await db.prepare("SELECT * FROM users WHERE email=?").bind(g.email).first();
            if (u) await db.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(g.sub, u.id).run();
          }
          if (!u) {
            const id = uid();
            await db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,google_sub,created_at) VALUES (?,?,'','',?,?)").bind(id, g.email, g.sub, now()).run();
            u = { id, email: g.email };
          }
          return J({ email: u.email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, u.id)) });
        }
        if (act === "logout" && m === "POST") {
          const tok = getCookie(request, "bt_session");
          if (tok) await db.prepare("DELETE FROM sessions WHERE token=?").bind(tok).run();
          return J({ ok: true }, 200, { "Set-Cookie": clearCookie });
        }
        if (act === "me" && m === "GET") {
          const uidv = await currentUser(request, db);
          if (!uidv) return J({ error: "not authenticated" }, 401);
          const u = await db.prepare("SELECT email, shop_slug, shop_name, shop_blurb FROM users WHERE id=?").bind(uidv).first();
          return J(u || {});
        }
        // Public: the web client ID is not a secret; the app needs it to render the Google button.
        if (act === "config" && m === "GET")
          return J({ google_client_id: env.GOOGLE_CLIENT_ID || null });
        return J({ error: "not found" }, 404);
      }

      // ---------- everything below requires a session ----------
      const userId = await currentUser(request, db);
      if (!userId) return J({ error: "not authenticated" }, 401);
      const ownsSale = async (sid) => !!(await db.prepare("SELECT id FROM sales WHERE id=? AND user_id=?").bind(sid, userId).first());
      const ownsItem = async (iid) => await db.prepare("SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=? AND s.user_id=?").bind(iid, userId).first();

      // ---------- plan / credits (the app shows this on the paywall and the appraisal button) ----------
      if (parts[1] === "me" && parts[2] === "plan" && m === "GET") {
        // rc_web_link is a RevenueCat Web Purchase Link. The web paywall appends /<user_id>, and the
        // RevenueCat webhook credits that same id — the identical path a Play purchase takes.
        const me = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
        // A way to pay with no way to be credited takes someone's money and gives nothing back.
        // The Road Show deployment was exactly that: RC_WEB_LINK set, RC_WEBHOOK_SECRET absent, so
        // every purchase would have 503'd at the webhook and never reached the buyer's account.
        // Fail closed — offer no purchase route unless the webhook that credits it is configured.
        const canCredit = !!env.RC_WEBHOOK_SECRET;
        return J({
          user_id: userId, email: me?.email || null,
          rc_android_key: canCredit ? (env.RC_ANDROID_KEY || null) : null,
          rc_web_link: canCredit ? (env.RC_WEB_LINK || null) : null,
          billing_ready: canCredit,
          play_url: env.PLAY_URL || null,
          ...(await planFor(db, userId)),
        });
      }

      // ---------- sellers (account-wide: the dealer's consignors, not one sale's) ----------
      if (parts[1] === "me" && parts[2] === "sellers") {
        if (parts.length === 3 && m === "GET")
          // The settlement terms come back with the dealer. A list that omitted them would make
          // the page fetch every seller twice to show a commission it already had.
          return J((await db.prepare(
            "SELECT id,name,created_at,commission_pct,rent_cents,booth,terms_note,active,payout_method " +
            "FROM sellers WHERE user_id=? ORDER BY name COLLATE NOCASE").bind(userId).all()).results);
        if (parts.length === 3 && m === "POST") {
          const b = await readJson(request); const name = (b.name || "").trim();
          if (!name) return J({ error: "name required" }, 400);
          const dup = await db.prepare("SELECT id,name FROM sellers WHERE user_id=? AND lower(trim(name))=lower(?)").bind(userId, name).first();
          if (dup) return J(dup);   // idempotent: adding "Mom" twice gives you the same Mom
          const id = uid();
          await db.prepare("INSERT INTO sellers (id,user_id,name,created_at) VALUES (?,?,?,?)").bind(id, userId, name, now()).run();
          return J({ id, name });
        }
        if (parts.length === 4) {
          const sid2 = parts[3];
          const own = await db.prepare("SELECT id FROM sellers WHERE id=? AND user_id=?").bind(sid2, userId).first();
          if (!own) return J({ error: "not found" }, 404);
          if (m === "PUT") {
            const b = await readJson(request); const name = (b.name || "").trim();
            if (!name) return J({ error: "name required" }, 400);
            const clash = await db.prepare("SELECT id FROM sellers WHERE user_id=? AND lower(trim(name))=lower(?) AND id<>?").bind(userId, name, sid2).first();
            if (clash) return J({ error: "You already have a seller by that name" }, 409);
            await db.prepare("UPDATE sellers SET name=? WHERE id=?").bind(name, sid2).run();
            return J({ id: sid2, name });
          }
          // Settlement terms. Separate from PUT, which renames, because renaming a dealer and
          // changing what they are paid are different acts and one should not quietly do the other.
          if (m === "PATCH") {
            const b = await readJson(request);
            // The typo that matters here is 1200 for 12%. Out of range is always a mistake, and
            // a mistake in this field is money.
            if (b.commission_pct !== undefined) {
              const p = Number(b.commission_pct);
              if (!(p >= 0 && p <= 100)) return J({ error: "Commission must be between 0 and 100 percent" }, 400);
            }
            if (b.rent_cents !== undefined && !(Number(b.rent_cents) >= 0))
              return J({ error: "Rent cannot be negative" }, 400);
            await db.prepare(
              "UPDATE sellers SET commission_pct=COALESCE(?,commission_pct), rent_cents=COALESCE(?,rent_cents), " +
              "booth=COALESCE(?,booth), terms_note=COALESCE(?,terms_note), active=COALESCE(?,active), " +
              "payout_method=COALESCE(?,payout_method) WHERE id=?")
              .bind(b.commission_pct ?? null, b.rent_cents === undefined ? null : Math.round(Number(b.rent_cents)),
                    b.booth ?? null, b.terms_note ?? null,
                    b.active === undefined ? null : (b.active ? 1 : 0), b.payout_method ?? null, sid2).run();
            return J(await db.prepare(
              "SELECT id,name,commission_pct,rent_cents,booth,terms_note,active,payout_method FROM sellers WHERE id=?")
              .bind(sid2).first());
          }
          if (m === "DELETE") {
            // Items keep their history; they just lose the attribution. Never delete a seller's items.
            const n = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE seller_id=?").bind(sid2).first();
            if (n.n && url.searchParams.get("force") !== "1")
              return J({ error: "This seller is on items", items: n.n, needs_force: true }, 409);
            await db.prepare("UPDATE items SET seller_id=NULL WHERE seller_id=?").bind(sid2).run();
            await db.prepare("DELETE FROM sellers WHERE id=?").bind(sid2).run();
            return J({ deleted: 1, unassigned: n.n });
          }
        }
        return J({ error: "not found" }, 404);
      }

      // ---------- settlements: what each dealer is owed, and a frozen record of it ----------
      // The arithmetic lives in settlements.js and is tested without a database. What is here is
      // the querying, the freezing, and refusing the things that have to be refused.
      if (parts[1] === "me" && parts[2] === "statements") {
        // Shared by preview and create so the two can never disagree about the numbers. A preview
        // that differs from what gets saved is worse than no preview.
        const settleFor = async (b) => {
          const from = String(b.from || ""), to = String(b.to || "");
          const bad = periodError(from, to);
          if (bad) return { error: bad, status: 400 };
          const seller = await db.prepare("SELECT * FROM sellers WHERE id=? AND user_id=?")
            .bind(String(b.seller_id || ""), userId).first();
          if (!seller) return { error: "Dealer not found", status: 404 };
          // This dealer's sold items, in the period, from this account's sales only. The join on
          // sales is what stops another account's item ever reaching a statement.
          const items = (await db.prepare(
            "SELECT i.id, i.name, i.price_cents, i.sold_at FROM items i " +
            "JOIN sales sa ON sa.id = i.sale_id " +
            "WHERE i.seller_id=? AND sa.user_id=? AND i.status='sold' " +
            "AND i.sold_at IS NOT NULL AND i.sold_at >= ? AND i.sold_at <= ? " +
            "ORDER BY i.sold_at, i.name")
            .bind(seller.id, userId, from, to + "￿").all()).results;
          // Terms are read ONCE, here. Everything downstream uses this copy and nothing reads
          // sellers.commission_pct again, which is what stops a later rate change rewriting a
          // statement that has already been handed to someone.
          const settled = settle({ items, commission_pct: seller.commission_pct,
                                   rent_cents: seller.rent_cents, adjustments: b.adjustments || [] });
          return { seller: { id: seller.id, name: seller.name, booth: seller.booth }, from, to, settled };
        };

        if (parts.length === 3 && m === "GET") {
          return J({ statements: (await db.prepare(
            "SELECT st.*, s.name AS seller_name, s.booth FROM statements st " +
            "JOIN sellers s ON s.id=st.seller_id WHERE st.user_id=? " +
            "ORDER BY st.period_start DESC, s.name COLLATE NOCASE").bind(userId).all()).results });
        }

        // The numbers, saved nowhere. This is what the owner looks at before committing.
        if (parts.length === 4 && parts[3] === "preview" && m === "POST") {
          const built = await settleFor(await readJson(request));
          return built.error ? J({ error: built.error }, built.status) : J(built);
        }

        if (parts.length === 3 && m === "POST") {
          const b = await readJson(request);
          const built = await settleFor(b);
          if (built.error) return J({ error: built.error }, built.status);
          // The partial unique index enforces this in the database too. It is here so the answer
          // is a sentence rather than a constraint error.
          const clash = await db.prepare(
            "SELECT id FROM statements WHERE seller_id=? AND period_start=? AND period_end=? AND status<>'void'")
            .bind(b.seller_id, built.from, built.to).first();
          if (clash) return J({ error: "A statement for this dealer and period already exists",
                                statement_id: clash.id }, 409);
          const id = uid(), ts = now(), s = built.settled;
          await db.prepare(
            "INSERT INTO statements (id,user_id,seller_id,period_start,period_end,basis,commission_pct,rent_cents," +
            "gross_cents,commission_cents,rent_charged_cents,adjust_cents,net_cents,item_count,status,note,created_at) " +
            "VALUES (?,?,?,?,?,'sold_at',?,?,?,?,?,?,?,?,'draft',?,?)")
            .bind(id, userId, b.seller_id, built.from, built.to, s.commission_pct, s.rent_cents,
                  s.gross_cents, s.commission_cents, s.rent_charged_cents, s.adjust_cents, s.net_cents,
                  s.item_count, b.note ?? null, ts).run();
          // The lines are copied, not joined. From here the statement does not care whether the
          // items are renamed, repriced, reassigned to another dealer or deleted outright.
          for (const l of s.lines)
            await db.prepare("INSERT INTO statement_items (id,statement_id,item_id,name,price_cents,sold_at) VALUES (?,?,?,?,?,?)")
              .bind(uid(), id, l.item_id, l.name, l.price_cents, l.sold_at).run();
          for (const a of (b.adjustments || []))
            await db.prepare("INSERT INTO statement_adjustments (id,statement_id,label,cents,created_at) VALUES (?,?,?,?,?)")
              .bind(uid(), id, String(a.label || "adjustment").slice(0, 80), Math.round(Number(a.cents) || 0), ts).run();
          return J({ statement_id: id, ...s }, 201);
        }

        if (parts.length === 4 && m === "GET") {
          const st = await db.prepare(
            "SELECT st.*, s.name AS seller_name, s.booth, s.payout_method FROM statements st " +
            "JOIN sellers s ON s.id=st.seller_id WHERE st.id=? AND st.user_id=?").bind(parts[3], userId).first();
          if (!st) return J({ error: "not found" }, 404);
          return J({ ...st, owes: st.net_cents < 0,
            items: (await db.prepare("SELECT * FROM statement_items WHERE statement_id=? ORDER BY sold_at, name").bind(st.id).all()).results,
            adjustments: (await db.prepare("SELECT * FROM statement_adjustments WHERE statement_id=? ORDER BY created_at").bind(st.id).all()).results });
        }

        // The thing a dealer is actually handed. CSV because every dealer already has something
        // that opens one, and a print view because a mall owner hands over paper.
        if (parts.length === 5 && (parts[4] === "csv" || parts[4] === "print") && m === "GET") {
          const st = await db.prepare(
            "SELECT st.*, s.name AS seller_name, s.booth, s.payout_method FROM statements st " +
            "JOIN sellers s ON s.id=st.seller_id WHERE st.id=? AND st.user_id=?").bind(parts[3], userId).first();
          if (!st) return J({ error: "not found" }, 404);
          const lines = (await db.prepare("SELECT * FROM statement_items WHERE statement_id=? ORDER BY sold_at, name").bind(st.id).all()).results;
          const adj = (await db.prepare("SELECT * FROM statement_adjustments WHERE statement_id=? ORDER BY created_at").bind(st.id).all()).results;
          const d = c => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toFixed(2);
          const owner = await db.prepare("SELECT shop_name FROM users WHERE id=?").bind(userId).first();
          const who = (owner && owner.shop_name) || "";
          const head = `${st.seller_name}${st.booth ? ` (booth ${st.booth})` : ""}`;
          const period = `${st.period_start} to ${st.period_end}`;

          if (parts[4] === "csv") {
            // Excel decides a field is a formula if it starts with = + - or @, so a name like
            // "-- spare parts" becomes #NAME? or worse. Prefixing a quote is the standard defusing
            // and it survives the round trip back out.
            const cell = v => {
              let s = String(v ?? "");
              if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
              return `"${s.replace(/"/g, '""')}"`;
            };
            const rows = [
              ["Statement", st.id], ["Dealer", head], ["Period", period], ["Status", st.status], [],
              ["Sold", "Item", "Price"],
              ...lines.map(l => [l.sold_at || "", l.name, (l.price_cents / 100).toFixed(2)]),
              [],
              ["", "Gross", (st.gross_cents / 100).toFixed(2)],
              ["", `Commission ${st.commission_pct}%`, (-st.commission_cents / 100).toFixed(2)],
              ["", "Booth rent", (-st.rent_charged_cents / 100).toFixed(2)],
              ...adj.map(a => ["", a.label, (a.cents / 100).toFixed(2)]),
              ["", st.net_cents < 0 ? "OWES" : "Net due", (st.net_cents / 100).toFixed(2)],
            ];
            return new Response(rows.map(r => r.map(cell).join(",")).join("\r\n"), { headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="statement-${st.period_start}-${String(st.seller_name).replace(/[^\w-]+/g, "_")}.csv"`,
              "cache-control": "no-store" } });
          }

          const row = (label, cents, cls = "") =>
            `<tr class="${cls}"><td>${esc(label)}</td><td class="n">${esc(d(cents))}</td></tr>`;
          return H(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Statement ${esc(period)} — ${esc(head)}</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111}
 h1{font-size:1.25rem;margin:0 0 2px} .sub{color:#666;margin:0 0 18px}
 table{width:100%;border-collapse:collapse;margin:14px 0}
 th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #eee}
 .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 .tot td{border-top:2px solid #111;border-bottom:none;font-weight:700;font-size:1.05rem}
 .owed td{color:#b00}
 .st{display:inline-block;padding:1px 8px;border:1px solid #bbb;border-radius:99px;font-size:.78rem;color:#555}
 @media print{body{margin:0}.noprint{display:none}}
</style>
<h1>${esc(who || "Settlement statement")}</h1>
<p class="sub">${esc(head)} · ${esc(period)} · <span class="st">${esc(st.status)}</span></p>
<table><thead><tr><th>Sold</th><th>Item</th><th class="n">Price</th></tr></thead><tbody>
${lines.map(l => `<tr><td>${esc(String(l.sold_at || "").slice(0, 10))}</td><td>${esc(l.name)}</td><td class="n">${esc(d(l.price_cents))}</td></tr>`).join("")
  || `<tr><td colspan="3">No items sold in this period.</td></tr>`}
</tbody></table>
<table><tbody>
${row("Gross", st.gross_cents)}
${row(`Commission ${st.commission_pct}%`, -st.commission_cents)}
${row("Booth rent", -st.rent_charged_cents)}
${adj.map(a => row(a.label, a.cents)).join("")}
${row(st.net_cents < 0 ? "Owes" : "Net due", st.net_cents, st.net_cents < 0 ? "tot owed" : "tot")}
</tbody></table>
${st.payout_method ? `<p class="sub">Paid by ${esc(st.payout_method)}.</p>` : ""}
${st.note ? `<p class="sub">${esc(st.note)}</p>` : ""}
<p class="sub noprint"><a href="/api/me/statements/${esc(st.id)}/csv">Download CSV</a></p>`, 200, "no-store");
        }

        if (parts.length === 5 && parts[4] === "status" && m === "POST") {
          const st = await db.prepare("SELECT * FROM statements WHERE id=? AND user_id=?").bind(parts[3], userId).first();
          if (!st) return J({ error: "not found" }, 404);
          const to = String((await readJson(request)).to || "");
          if (!canTransition(st.status, to))
            return J({ error: st.status === "paid"
              ? "A paid statement cannot be changed — void it and issue a new one"
              : `Cannot go from ${st.status} to ${to || "nothing"}` }, 409);
          const ts = now();
          await db.prepare(
            "UPDATE statements SET status=?, issued_at=CASE WHEN ?='issued' THEN ? ELSE issued_at END, " +
            "paid_at=CASE WHEN ?='paid' THEN ? ELSE paid_at END WHERE id=?")
            .bind(to, to, ts, to, ts, st.id).run();
          return J({ id: st.id, status: to });
        }
        return J({ error: "not found" }, 404);
      }

      // ---------- device key (for the counter kiosk) ----------
      if (parts[1] === "me" && parts[2] === "device-key") {
        if (m === "GET") { const u = await db.prepare("SELECT device_key FROM users WHERE id=?").bind(userId).first(); return J({ device_key: u.device_key || null }); }
        if (m === "POST") { const k = "btd_" + randHex(20); await db.prepare("UPDATE users SET device_key=? WHERE id=?").bind(k, userId).run(); return J({ device_key: k }); }
        if (m === "DELETE") { await db.prepare("UPDATE users SET device_key=NULL WHERE id=?").bind(userId).run(); return J({ ok: true }); }
      }

      // ---------- shop settings ----------
      if (parts[1] === "me" && parts[2] === "shop") {
        if (m === "GET") return J(await db.prepare("SELECT shop_slug, shop_name, shop_blurb FROM users WHERE id=?").bind(userId).first());
        if (m === "PUT") {
          const b = await readJson(request);
          const slug = slugify(b.slug || b.shop_name);
          if (slug.length < 3) return J({ error: "slug must be at least 3 characters" }, 400);
          const taken = await db.prepare("SELECT id FROM users WHERE shop_slug=? AND id<>?").bind(slug, userId).first();
          if (taken) return J({ error: "that shop address is taken" }, 409);
          await db.prepare("UPDATE users SET shop_slug=?, shop_name=?, shop_blurb=? WHERE id=?").bind(slug, (b.shop_name || "").trim() || slug, (b.shop_blurb || "").trim() || null, userId).run();
          return J({ shop_slug: slug, shop_name: (b.shop_name || "").trim() || slug, url: `${env.PUBLIC_ORIGIN || url.origin}/shop/${slug}` });
        }
      }

      // ---------- sales ----------
      if (parts[1] === "sales" && parts.length === 2) {
        if (m === "GET") {
          const { results } = await db.prepare(
            "SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.sale_id=s.id) AS items, " +
            "(SELECT COALESCE(SUM(total_cents),0) FROM txns t WHERE t.sale_id=s.id AND t.status='complete') AS revenue_cents " +
            "FROM sales s WHERE s.user_id=? ORDER BY created_at DESC").bind(userId).all();
          return J(results);
        }
        if (m === "POST") {
          const b = await readJson(request);
          const name = (b.name || "").trim() || "Untitled sale";
          const id = uid();
          await db.prepare("INSERT INTO sales (id,name,status,created_at,user_id) VALUES (?,?,'open',?,?)").bind(id, name, now(), userId).run();
          if (b.seller && b.seller.trim())
            await db.prepare("INSERT OR IGNORE INTO sellers (id,user_id,name,created_at) VALUES (?,?,?,?)").bind(uid(), userId, b.seller.trim(), now()).run();
          return J({ id, name });
        }
      }
      if (parts[1] === "sales" && parts.length >= 3) {
        const sid = parts[2];
        if (!(await ownsSale(sid))) return J({ error: "not found" }, 404);
        if (parts.length === 3 && m === "GET") {
          const sale = await db.prepare("SELECT * FROM sales WHERE id=?").bind(sid).first();
          const sellers = (await db.prepare("SELECT id,name FROM sellers WHERE user_id=? ORDER BY name COLLATE NOCASE").bind(userId).all()).results;
          const items = (await db.prepare(
            "SELECT i.*, (SELECT r2_key FROM photos p WHERE p.item_id=i.id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key, " +
            "(SELECT status FROM appraisals a WHERE a.item_id=i.id ORDER BY a.created_at DESC LIMIT 1) AS appraisal_status " +
            "FROM items i WHERE i.sale_id=? ORDER BY i.created_at DESC").bind(sid).all()).results;
          const txns = (await db.prepare("SELECT * FROM txns WHERE sale_id=? ORDER BY created_at DESC").bind(sid).all()).results;
          return J({ sale, sellers, items, txns });
        }
        if (parts.length === 3 && m === "DELETE") {
          // A sale with recorded sales is the dealer's books — refuse unless they say so explicitly.
          // A voided transaction is not takings, so it must not be what makes deleting a sale
          // feel dangerous — otherwise every corrected mistake leaves a permanent scary warning.
          const sold = await db.prepare("SELECT COUNT(*) AS n FROM txns WHERE sale_id=? AND status='complete'").bind(sid).first();
          if (sold.n && url.searchParams.get("force") !== "1")
            return J({ error: "This sale has recorded sales", sold: sold.n, needs_force: true }, 409);
          const ps = (await db.prepare(
            "SELECT p.r2_key FROM photos p JOIN items i ON i.id=p.item_id WHERE i.sale_id=?").bind(sid).all()).results;
          // Nothing below can be undone, and a statement is a promise about money. If any item in
          // this sale has been settled on a statement that was issued or paid, deleting the sale
          // pulls the evidence out from under a document a dealer is holding. statement_items
          // keeps its own copy of the line, so the figures would survive - but the items behind
          // them would not, and "where did the March sale go" is not a question to answer after
          // the fact. Drafts do not block: nothing has been handed over yet.
          const settled = await db.prepare(
            "SELECT COUNT(*) AS n FROM statement_items si JOIN statements st ON st.id=si.statement_id " +
            "WHERE st.status IN ('issued','paid') AND si.item_id IN (SELECT id FROM items WHERE sale_id=?)")
            .bind(sid).first();
          if (settled.n)
            return J({ error: `${settled.n} item${settled.n === 1 ? "" : "s"} in this sale ` +
              `${settled.n === 1 ? "is" : "are"} on a statement that has already been issued. ` +
              `Void that statement first if it really needs to go.`, settled_items: settled.n }, 409);
          // R2 deletes are best-effort: a failed key must not leave the rows behind.
          await Promise.all(ps.map(x => env.PHOTOS.delete(x.r2_key).catch(() => {})));
          await db.prepare("DELETE FROM photos WHERE item_id IN (SELECT id FROM items WHERE sale_id=?)").bind(sid).run();
          await db.prepare("DELETE FROM appraisals WHERE item_id IN (SELECT id FROM items WHERE sale_id=?)").bind(sid).run();
          await db.prepare("DELETE FROM items WHERE sale_id=?").bind(sid).run();
          await db.prepare("DELETE FROM txns WHERE sale_id=?").bind(sid).run();
          // Sellers are the dealer's, not the sale's — deleting a sale must not delete their consignors.
          const r = await db.prepare("DELETE FROM sales WHERE id=? AND user_id=?").bind(sid, userId).run();
          return J({ deleted: r.meta.changes, photos: ps.length });
        }
        // Kept for older clients: adding a seller "to a sale" now adds them to the account.
        if (parts[3] === "sellers" && m === "POST") {
          const b = await readJson(request); const name = (b.name || "").trim();
          if (!name) return J({ error: "name required" }, 400);
          const dup = await db.prepare("SELECT id,name FROM sellers WHERE user_id=? AND lower(trim(name))=lower(?)").bind(userId, name).first();
          if (dup) return J(dup);
          const id = uid();
          await db.prepare("INSERT INTO sellers (id,user_id,name,created_at) VALUES (?,?,?,?)").bind(id, userId, name, now()).run();
          return J({ id, name });
        }
        if (parts[3] === "items" && m === "POST") {
          const b = await readJson(request);
          const name = (b.name || "").trim() || "New item";
          const price_cents = b.price === undefined || b.price === "" || b.price === null ? 0 : Math.round(Number(b.price) * 100);
          if (!Number.isFinite(price_cents) || price_cents < 0) return J({ error: "bad price" }, 400);
          const id = uid();
          await db.prepare("INSERT INTO items (id,sale_id,seller_id,name,price_cents,status,created_at,description,markings) VALUES (?,?,?,?,?,'available',?,?,?)")
            .bind(id, sid, b.seller_id || null, name, price_cents, now(), (b.description || "").trim() || null, (b.markings || "").trim() || null).run();
          return J({ id });
        }
        if (parts[3] === "checkout" && m === "POST") {
          const b = await readJson(request);
          const ids = Array.isArray(b.item_ids) ? b.item_ids.filter(Boolean) : [];
          if (!ids.length) return J({ error: "no items" }, 400);
          const ph = ids.map(() => "?").join(",");
          const rows = (await db.prepare(`SELECT id,name,price_cents FROM items WHERE sale_id=? AND status='available' AND id IN (${ph})`).bind(sid, ...ids).all()).results;
          if (!rows.length) return J({ error: "items unavailable" }, 400);
          // An item created before it was priced would otherwise ring up free and be marked sold,
          // with nothing on screen to say so. Giving something away is a real thing at a sale, so
          // it stays possible — but only on purpose.
          const unpriced = rows.filter(r => r.price_cents <= 0);
          if (unpriced.length && b.allow_free !== true)
            return J({
              error: unpriced.length === 1
                ? `${unpriced[0].name} has no price`
                : `${unpriced.length} items have no price`,
              unpriced: unpriced.map(r => ({ id: r.id, name: r.name })),
              needs_price: true,
            }, 409);
          const total = rows.reduce((a, r) => a + r.price_cents, 0);
          const txnId = uid();
          await db.prepare("INSERT INTO txns (id,sale_id,total_cents,item_count,tender,created_at) VALUES (?,?,?,?,?,?)").bind(txnId, sid, total, rows.length, (b.tender || "cash"), now()).run();
          const soldIds = rows.map(r => r.id), ph2 = soldIds.map(() => "?").join(",");
          await db.prepare(`UPDATE items SET status='sold', txn_id=?, sold_at=?, listing_status=CASE WHEN listing_status='live' THEN 'hidden' ELSE listing_status END WHERE id IN (${ph2})`).bind(txnId, now(), ...soldIds).run();
          return J({ txn_id: txnId, total_cents: total, item_count: rows.length });
        }
        // Undo a sale that should not have happened: wrong tag scanned, customer changed their
        // mind at the door, card declined after the drawer opened. The transaction is kept and
        // marked, never deleted — the drawer has to reconcile against something, and "it is not
        // there any more" is not an explanation anybody can give a customer or an accountant.
        if (parts[3] === "txns" && parts[5] === "void" && m === "POST") {
          const t = await db.prepare("SELECT * FROM txns WHERE id=? AND sale_id=?").bind(parts[4], sid).first();
          if (!t) return J({ error: "not found" }, 404);
          if (t.status === "void") return J({ error: "This sale was already voided", voided_at: t.voided_at }, 409);
          // An online sale took real money through Stripe. Marking it void here would put the
          // books and the card processor permanently out of step, and this app cannot move
          // money. The refund has to happen where the charge did.
          if (t.tender === "stripe")
            return J({ error: "This was an online card sale. Refund it in Stripe first — " +
                              "voiding it here would leave the books and the card processor disagreeing.",
                       tender: "stripe" }, 409);
          const b = await readJson(request);
          // The items go back on the shelf, but a listing that was pulled down when they sold
          // stays down: we recorded that it went from live to hidden, not that it should come
          // back, and silently republishing something to a storefront is not ours to decide.
          const back = (await db.prepare("SELECT id,name,price_cents FROM items WHERE txn_id=?").bind(t.id).all()).results;
          // A statement that has already been issued has a frozen copy of these lines, and the
          // money on it has been promised to a dealer. Voiding is still allowed — a return is a
          // real event and refusing to record it would be worse — but it cannot be silent: the
          // correction belongs on the next statement as an adjustment, and the owner has to be
          // the one who decides that. Drafts do not count; they recompute.
          const ids = back.map(r => r.id);
          if (ids.length) {
            const ph3 = ids.map(() => "?").join(",");
            const hit = (await db.prepare(
              "SELECT st.id, st.status, s.name AS seller_name, st.period_start, st.period_end, " +
              "COUNT(si.id) AS n, COALESCE(SUM(si.price_cents),0) AS cents " +
              "FROM statement_items si JOIN statements st ON st.id=si.statement_id " +
              "JOIN sellers s ON s.id=st.seller_id " +
              `WHERE st.status IN ('issued','paid') AND si.item_id IN (${ph3}) ` +
              "GROUP BY st.id ORDER BY st.period_start").bind(...ids).all()).results;
            if (hit.length && b.acknowledge_statements !== true)
              return J({
                error: hit.length === 1
                  ? `${hit[0].n} of these items ${hit[0].n === 1 ? "is" : "are"} on ${hit[0].seller_name}'s ` +
                    `${hit[0].status} statement for ${hit[0].period_start} to ${hit[0].period_end}. ` +
                    `Voiding does not change that statement — deduct it on their next one.`
                  : `These items are on ${hit.length} statements that have already been issued. ` +
                    `Voiding does not change them — deduct the returns on the next statements.`,
                statements: hit, needs_acknowledgement: true }, 409);
          }
          await db.prepare("UPDATE txns SET status='void', voided_at=?, void_reason=? WHERE id=?")
            .bind(now(), (b.reason || "").trim().slice(0, 200) || null, t.id).run();
          // sold_at is what a statement filters on, so clearing it is what actually takes these
          // items back out of every future payout. status alone would not.
          await db.prepare("UPDATE items SET status='available', txn_id=NULL, sold_at=NULL WHERE txn_id=?").bind(t.id).run();
          return J({ voided: t.id, total_cents: t.total_cents, items_returned: back.length,
                     items: back.map(r => ({ id: r.id, name: r.name })) });
        }
        if (parts[3] === "summary" && m === "GET") {
          const totals = await db.prepare("SELECT COALESCE(SUM(total_cents),0) AS revenue_cents, COUNT(*) AS txn_count FROM txns WHERE sale_id=? AND status='complete'").bind(sid).first();
          const sold = await db.prepare("SELECT COUNT(*) AS sold_items FROM items WHERE sale_id=? AND status='sold'").bind(sid).first();
          const avail = await db.prepare("SELECT COUNT(*) AS available_items, COALESCE(SUM(price_cents),0) AS available_cents FROM items WHERE sale_id=? AND status='available'").bind(sid).first();
          const split = (await db.prepare(
            "SELECT COALESCE(s.name,'Unassigned') AS seller, COUNT(i.id) AS items, COALESCE(SUM(i.price_cents),0) AS cents " +
            "FROM items i LEFT JOIN sellers s ON s.id=i.seller_id WHERE i.sale_id=? AND i.status='sold' GROUP BY i.seller_id ORDER BY cents DESC").bind(sid).all()).results;
          return J({ ...totals, ...sold, ...avail, split });
        }
      }

      // ---------- items: photos, appraisal, publish ----------
      if (parts[1] === "items" && parts.length >= 3) {
        const iid = parts[2];
        const item = await ownsItem(iid);
        if (!item) return J({ error: "not found" }, 404);

        if (parts.length === 3 && m === "GET") return J(await itemBundle(db, iid));
        if (parts.length === 3 && m === "DELETE") {
          if (item.status !== "available") return J({ error: "sold items can't be deleted" }, 400);
          const ps = (await db.prepare("SELECT r2_key FROM photos WHERE item_id=?").bind(iid).all()).results;
          await Promise.all(ps.map(x => env.PHOTOS.delete(x.r2_key)));
          await db.prepare("DELETE FROM photos WHERE item_id=?").bind(iid).run();
          await db.prepare("DELETE FROM appraisals WHERE item_id=?").bind(iid).run();
          const r = await db.prepare("DELETE FROM items WHERE id=?").bind(iid).run();
          return J({ deleted: r.meta.changes });
        }
        if (parts[3] === "photos" && m === "POST") {
          const fd = await request.formData();
          const files = fd.getAll("photos").filter(f => typeof f === "object" && f.size);
          if (!files.length) return J({ error: "no photos" }, 400);
          const kinds = String(fd.get("kinds") || "").split(",").map(k => k.trim());
          const existing = await db.prepare("SELECT COUNT(*) AS n FROM photos WHERE item_id=?").bind(iid).first();
          if (existing.n + files.length > 12) return J({ error: "max 12 photos per item" }, 400);
          const out = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (f.size > 10 * 1024 * 1024) return J({ error: `${f.name || "photo"} over 10 MB` }, 413);
            const ctype = f.type || "image/jpeg";
            const ext = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp" : ctype.includes("heic") ? "heic" : "jpg";
            const key = `${iid}/${uid()}.${ext}`;
            await env.PHOTOS.put(key, f.stream(), { httpMetadata: { contentType: ctype } });
            const kind = PHOTO_KINDS.has(kinds[i]) ? kinds[i] : "other";
            const id = uid();
            await db.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
              .bind(id, iid, key, kind, ctype, f.size, existing.n + i, now()).run();
            out.push({ id, kind, url: `/p/${key}` });
          }
          return J({ photos: out });
        }
        if (parts[3] === "appraise" && m === "POST") {
          const photos = (await db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(iid).all()).results;
          if (!photos.length) return J({ error: "add at least one photo first" }, 400);
          // Photographs alone are not enough. Four rolls of nickels stood on end were identified
          // five different ways across five runs — shotgun shells once, a 2023 Silver Eagle set
          // another time, which priced the lot at $260 when its silver alone was worth $585. One
          // line from the dealer settles what no amount of pixel-reading can. Checked here and
          // not only in the page, because the client is not the only way in.
          const b = await readJson(request).catch(() => ({}));
          // `dealer_description` — never `description`. The item page's description box is the
          // LISTING copy the model wrote, and it used to be posted here under the name this
          // endpoint reads as the dealer's own account, replacing "4 rolls of world war 2 silver
          // nickels" with a paragraph about a single modern nickel and pricing a $576 lot at
          // $1.42. Two endpoints meant opposite things by one word. Now they use two words, and
          // `description` is honoured here by nothing at all: an older cached client that still
          // sends it gets its re-run, and the dealer keeps what they wrote.
          if (b.description !== undefined) {
            console.log("appraise: ignoring legacy `description` field for item", iid);
            delete b.description;
          }
          if (!String(b.dealer_description ?? item.description ?? "").trim() &&
              !String(b.markings ?? item.markings ?? "").trim())
            return J({ error: "Tell us what it is, even roughly — a photo on its own is identified wrong too often.",
                       needs_description: true }, 400);
          if (!env.APPRAISER_URL && !env.NEBIUS_API_KEY) return J({ error: "appraiser not configured" }, 503);
          // Belt and braces on top of the rename: even under the new name, the model's own
          // listing copy is never accepted as what the dealer said. Losing a dealer's own words
          // cannot be undone, so this stays even though it should now be unreachable.
          if (b.dealer_description !== undefined && item.ai_description &&
              String(b.dealer_description).trim() === String(item.ai_description).trim()) {
            console.log("appraise: refused ai_description as dealer_description for item", iid);
            delete b.dealer_description;
          }
          if (b.dealer_description !== undefined || b.markings !== undefined) {
            await db.prepare("UPDATE items SET description=COALESCE(?,description), markings=COALESCE(?,markings) WHERE id=?")
              .bind(b.dealer_description ?? null, b.markings ?? null, iid).run();
            item.description = b.dealer_description ?? item.description; item.markings = b.markings ?? item.markings;
          }
          // metered: unlimited plan -> pro plan (300/mo) -> credits -> 402 with the paywall hint
          const fundedBy = await consumeEstimate(db, userId);
          if (!fundedBy) return J({ error: "You're out of estimates", paywall: true, plan: await planFor(db, userId) }, 402);
          const apId = uid();
          await db.prepare("INSERT INTO appraisals (id,item_id,status,created_at,funded_by) VALUES (?,?,'pending',?,?)").bind(apId, iid, now(), fundedBy).run();
          if (env.APPRAISALS) await env.APPRAISALS.send({ appraisalId: apId, itemId: iid });
          else ctx.waitUntil(runAppraisal(env, apId, item, photos));   // local dev without the queue binding
          return J({ appraisal_id: apId, status: "pending", funded_by: fundedBy }, 202);
        }
        if (parts[3] === "publish" && m === "POST") {
          const b = await readJson(request);
          const u = await db.prepare("SELECT shop_slug FROM users WHERE id=?").bind(userId).first();
          if (!u.shop_slug) return J({ error: "set up your shop address first" }, 400);
          const status = b.listing_status === "hidden" ? "hidden" : "live";
          const price_cents = b.price === undefined ? item.price_cents : Math.round(Number(b.price) * 100);
          if (!Number.isFinite(price_cents) || price_cents < 0) return J({ error: "bad price" }, 400);
          if (status === "live" && price_cents <= 0) return J({ error: "set a price before listing" }, 400);
          // listing_description is the shop-page copy. `description` is accepted only as a
          // fallback for an older cached client, and writes ai_description here exactly as it
          // always did — this endpoint never touched the dealer's own words, so honouring the
          // legacy name costs nothing.
          const listingDesc = b.listing_description ?? b.description;
          await db.prepare("UPDATE items SET ai_title=COALESCE(?,ai_title), ai_description=COALESCE(?,ai_description), price_cents=?, listing_status=?, listed_at=COALESCE(listed_at,?) WHERE id=?")
            .bind((b.title || "").trim() || null, (listingDesc || "").trim() || null, price_cents, status, now(), iid).run();
          return J({ listing_status: status, url: `${env.PUBLIC_ORIGIN || url.origin}/shop/${u.shop_slug}/item/${iid}` });
        }
      }
      if (parts[1] === "photos" && parts.length === 3 && m === "DELETE") {
        const ph = await db.prepare("SELECT p.* FROM photos p JOIN items i ON i.id=p.item_id JOIN sales s ON s.id=i.sale_id WHERE p.id=? AND s.user_id=?").bind(parts[2], userId).first();
        if (!ph) return J({ error: "not found" }, 404);
        await env.PHOTOS.delete(ph.r2_key);
        await db.prepare("DELETE FROM photos WHERE id=?").bind(ph.id).run();
        return J({ deleted: 1 });
      }
      return J({ error: "not found" }, 404);
    } catch (e) {
      return J({ error: String(e && e.message || e) }, 500);
    }
  },

  // An appraisal takes ~2 minutes of waiting on Token Factory. ctx.waitUntil() only buys 30s after the
  // response, so the old fire-and-forget would have been killed mid-run — leaving the row 'pending'
  // forever and silently eating the dealer's estimate. A queue consumer gets the time it needs.
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const { appraisalId, itemId } = msg.body;
        const ap = await env.DB.prepare("SELECT status FROM appraisals WHERE id=?").bind(appraisalId).first();
        if (!ap || ap.status !== "pending") { msg.ack(); continue; }   // already done, or gone
        const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(itemId).first();
        if (!item) { msg.ack(); continue; }
        const photos = (await env.DB.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(itemId).all()).results;
        await runAppraisal(env, appraisalId, item, photos);
        msg.ack();
      } catch (e) {
        // runAppraisal already records its own failures and refunds; this is for anything outside it.
        msg.retry();
      }
    }
  }
};
