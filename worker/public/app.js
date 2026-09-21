// Estate Sale Road Show — front end (fork of Bottle Tree v0.1) — front-end
const $ = s => document.querySelector(s);
const app = $("#app"), tabs = $("#tabs"), ctx = $("#ctx"), backBtn = $("#backBtn"),
      cartbar = $("#cartbar");
let state = { view: "sales", saleId: null, detail: null, tab: "items", cart: new Set() };
let user = null;
let billingInit = false;
let pendingPhotos = [];   // photos staged on the manual "Add an item" card
window.addEventListener("bt:plan", () => { if (state.view === "sales") renderSales(); });

const money = c => "$" + (c / 100).toFixed(2);
const esc = s => (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
async function api(path, opts) {
  const r = await fetch("/api" + path, { headers: { "content-type": "application/json" }, credentials: "same-origin", ...opts });
  if (r.status === 401 && !path.startsWith("/auth")) { user = null; renderAuth(); throw new Error("Please sign in"); }
  if (!r.ok) {
    let e = {}; try { e = await r.json(); } catch {}
    if (r.status === 402 && e.paywall && window.BTBilling) { BTBilling.refresh().then(() => BTBilling.open("You're out of estimates. Your items and photos are saved.")); }
    throw new Error(e.error || ("HTTP " + r.status));
  }
  return r.json();
}
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); }
window.toast = toast;
// estimates pill (sales screen); refreshed after purchases
function planPill() {
  const p = window.BTBilling && BTBilling.plan;
  if (!p) return "";
  return `<a href="#" id="planPill" class="pill" style="text-decoration:none">${esc(BTBilling.summary())}${p.plan === "free" ? " · get more" : ""}</a>`;
}

function setChrome() {
  const inSale = state.view === "sale";
  tabs.classList.toggle("hidden", !inSale);
  backBtn.classList.toggle("hidden", !inSale);
  ctx.textContent = inSale && state.detail ? state.detail.sale.name : "";
  const showCart = inSale && state.tab === "cashier" && state.cart.size;
  cartbar.classList.toggle("hidden", !showCart);
  // Reserve the height of whichever fixed bars are up, so the bottom of the list stays reachable.
  document.body.classList.toggle("has-tabs", inSale && !showCart);
  document.body.classList.toggle("has-cart", !!showCart);
  [...tabs.children].forEach(b => b.classList.toggle("on", b.dataset.tab === state.tab));
}

// ---------- Sign in with Google ----------
// Two paths, one endpoint. On the web we use Google Identity Services. Inside the
// Capacitor shell GIS is unusable (Google blocks OAuth in embedded WebViews with
// disallowed_useragent), so the native build uses Credential Manager via the
// social-login plugin and hands us the same ID token.
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
let authCfg = null, gisReady = null, gInit = false;

async function getAuthCfg() {
  if (authCfg) return authCfg;
  try { authCfg = await api("/auth/config"); } catch { authCfg = { google_client_id: null }; }
  return authCfg;
}
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.id) return res();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error("gsi load failed"));
    document.head.appendChild(s);
  });
  return gisReady;
}
async function signInWithGoogleToken(credential) {
  try {
    const r = await api("/auth/google", { method: "POST", body: JSON.stringify({ credential }) });
    user = r.email; billingInit = false; toast("Signed in"); renderSales();
  } catch (e) { toast(e.message); }
}
async function nativeGoogleSignIn(btn) {
  const cfg = await getAuthCfg();
  const SL = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SocialLogin;
  if (!SL) return toast("Google sign-in isn't available in this build");
  btn.disabled = true;
  try {
    if (!gInit) { await SL.initialize({ google: { webClientId: cfg.google_client_id } }); gInit = true; }
    const res = await SL.login({ provider: "google", options: { scopes: ["email", "profile"] } });
    const idToken = res && res.result && res.result.idToken;
    if (!idToken) throw new Error("Google didn't return a token");
    await signInWithGoogleToken(idToken);
  } catch (e) {
    toast((e && e.message) ? e.message : "Google sign-in was cancelled");
  } finally { btn.disabled = false; }
}
async function mountGoogle() {
  const wrap = $("#gWrap"); if (!wrap) return;
  const cfg = await getAuthCfg();
  if (!cfg.google_client_id) { wrap.remove(); return; }   // not configured yet — stay password-only
  wrap.style.display = "";
  if (isNative) {
    wrap.querySelector("#gBtn").innerHTML =
      `<button class="btn" id="gNative" style="background:#fff;color:#222;border:1px solid #dadce0">Continue with Google</button>`;
    $("#gNative").onclick = () => nativeGoogleSignIn($("#gNative"));
    return;
  }
  try {
    await loadGis();
    google.accounts.id.initialize({
      client_id: cfg.google_client_id,
      callback: r => signInWithGoogleToken(r.credential),
      ux_mode: "popup"
    });
    google.accounts.id.renderButton($("#gBtn"), {
      theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: 300
    });
  } catch { wrap.remove(); }
}

// ---------- Auth ----------
function renderAuth(mode) {
  mode = mode || "login";
  state.view = "auth"; state.saleId = null; state.detail = null; setChrome();
  ctx.textContent = "";
  const isLogin = mode === "login";
  app.innerHTML = `
    <div style="text-align:center;margin:34px 0 8px">
      <div class="big" style="font-size:1.7rem">${isLogin ? "Welcome back" : "Create your account"}</div>
      <div class="muted">${isLogin ? "Sign in to your sales." : "Free — start selling in a minute."}</div>
    </div>
    <div class="card">
      <label>Email</label>
      <input id="auEmail" type="email" autocomplete="email" placeholder="you@example.com" enterkeyhint="next">
      <div style="height:10px"></div>
      <label>Password</label>
      <input id="auPw" type="password" autocomplete="${isLogin ? "current-password" : "new-password"}" placeholder="${isLogin ? "Your password" : "At least 8 characters"}" enterkeyhint="go">
      <div style="height:14px"></div>
      <button class="btn" id="auGo">${isLogin ? "Sign in" : "Create account"}</button>
      <div id="gWrap" style="display:none">
        <div class="muted" style="text-align:center;margin:14px 0 10px">or</div>
        <div id="gBtn" style="display:flex;justify-content:center"></div>
      </div>
    </div>
    <div class="muted" style="text-align:center">${isLogin ? "New here?" : "Already have an account?"}
      <a href="#" id="auToggle" style="color:var(--cobalt);font-weight:800">${isLogin ? "Create an account" : "Sign in"}</a></div>`;
  const go = async () => {
    const email = $("#auEmail").value.trim(), password = $("#auPw").value;
    if (!email || !password) return toast("Email and password, please");
    try {
      await api("/auth/" + (isLogin ? "login" : "register"), { method: "POST", body: JSON.stringify({ email, password }) });
      user = email; toast(isLogin ? "Signed in" : "Account created"); renderSales();
    } catch (e) { toast(e.message); }
  };
  $("#auGo").onclick = go;
  $("#auPw").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  $("#auToggle").onclick = e => { e.preventDefault(); renderAuth(isLogin ? "register" : "login"); };
  mountGoogle();
}
async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch {}
  user = null; billingInit = false; renderAuth("login");
}

// ---------- Sales list ----------
async function renderSales() {
  state.view = "sales"; state.saleId = null; state.detail = null; setChrome();
  app.innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline;margin-top:6px">
      <h1 class="h1" style="margin:0">Your sales</h1>
      <span><a href="#" id="myshop" class="muted" style="font-size:.85rem;font-weight:700;margin-right:12px">My shop</a><a href="#" id="signout" class="muted" style="font-size:.85rem;font-weight:700">Sign out</a></span></div>
    <div class="row" style="justify-content:space-between;align-items:center;margin:2px 0 4px"><span class="muted" style="font-size:.82rem">${esc(user || "")}</span>${planPill()}</div>
    <div class="card">
      <label>Start a new sale</label>
      <div class="row"><input id="newName" placeholder="e.g. Saturday Garage Sale" enterkeyhint="go"></div>
      <div style="height:8px"></div>
      <button class="btn" id="newBtn">+ New sale</button>
    </div>
    <div id="salesList" class="list"></div>
    <div class="card" style="margin-top:14px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <label style="margin:0">Your sellers</label>
        <button class="btn sec sm" id="sellAdd" style="margin:0">+ Add</button>
      </div>
      <div class="muted" style="font-size:.8rem;margin-top:4px">Consignors and booth partners. They carry across every sale.</div>
      <div id="sellList" style="margin-top:8px"></div>
    </div>`;
  $("#newBtn").onclick = createSale;
  $("#sellAdd").onclick = async () => {
    const name = prompt("Seller name (e.g. Mom, Booth 12):");
    if (!name || !name.trim()) return;
    try { await api("/me/sellers", { method: "POST", body: JSON.stringify({ name: name.trim() }) }); }
    catch (e) { return toast(e.message); }
    toast("Seller added"); loadSellers();
  };
  loadSellers();
  $("#newName").addEventListener("keydown", e => { if (e.key === "Enter") createSale(); });
  $("#signout").onclick = e => { e.preventDefault(); logout(); };
  $("#myshop").onclick = e => { e.preventDefault(); renderShopSetup(renderSales); };
  if ($("#planPill")) $("#planPill").onclick = e => { e.preventDefault(); BTBilling.open(); };
  if (window.BTBilling && !billingInit) { billingInit = true; BTBilling.init().then(p => { if (p && state.view === "sales") renderSales(); }); }
  const list = await api("/sales");
  const el = $("#salesList");
  if (!list.length) { el.innerHTML = `<div class="empty"><div class="em">🏷️</div>No sales yet. Start one above.</div>`; return; }
  el.innerHTML = list.map(s => `<div class="li tap" data-id="${s.id}">
      <div><div class="nm">${esc(s.name)}</div><div class="muted" style="font-size:.82rem">${s.items} items · ${money(s.revenue_cents)} sold</div></div>
      <span class="pr">${s.status === "open" ? "" : "✓ "}<span class="pill">${s.status}</span></span>
      <button class="btn rust sm" data-del="${s.id}" data-name="${esc(s.name)}" title="Delete sale" style="margin-left:8px">✕</button>
    </div>`).join("");
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = e => { e.stopPropagation(); deleteSale(b.dataset.del, b.dataset.name); });
  el.querySelectorAll(".li").forEach(li => li.onclick = () => openSale(li.dataset.id));
}
async function loadSellers() {
  const el = $("#sellList"); if (!el) return;
  let rows = [];
  try { rows = await api("/me/sellers"); } catch { return; }
  if (!rows.length) { el.innerHTML = `<div class="muted" style="font-size:.82rem">None yet — add the people whose things you sell.</div>`; return; }
  el.innerHTML = rows.map(s => `<div class="row" style="justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)">
      <span style="font-weight:700">${esc(s.name)}</span>
      <span><a href="#" data-ren="${s.id}" data-n="${esc(s.name)}" class="muted" style="font-size:.8rem;font-weight:700;margin-right:12px">Rename</a>
            <a href="#" data-del="${s.id}" data-n="${esc(s.name)}" class="muted" style="font-size:.8rem;font-weight:700">Remove</a></span>
    </div>`).join("");
  el.querySelectorAll("[data-ren]").forEach(a => a.onclick = async e => {
    e.preventDefault();
    const name = prompt("Rename seller:", a.dataset.n);
    if (!name || !name.trim() || name.trim() === a.dataset.n) return;
    try { await api("/me/sellers/" + a.dataset.ren, { method: "PUT", body: JSON.stringify({ name: name.trim() }) }); }
    catch (err) { return toast(err.message); }
    toast("Renamed"); loadSellers();
  });
  el.querySelectorAll("[data-del]").forEach(a => a.onclick = async e => {
    e.preventDefault();
    if (!confirm(`Remove ${a.dataset.n}?`)) return;
    try { await api("/me/sellers/" + a.dataset.del, { method: "DELETE" }); }
    catch (err) {
      if (!/on items/i.test(err.message)) return toast(err.message);
      // Their items stay; they just stop being attributed to anyone.
      if (!confirm(`${a.dataset.n} is on items already.\n\nRemoving them keeps those items and their sales, but the items stop being attributed to anyone and drop out of the payout split.\n\nRemove anyway?`)) return;
      try { await api("/me/sellers/" + a.dataset.del + "?force=1", { method: "DELETE" }); }
      catch (e2) { return toast(e2.message); }
    }
    toast("Removed"); loadSellers();
  });
}
async function deleteSale(id, name) {
  if (!confirm(`Delete "${name}"?\n\nThis removes its items and their photos for good. Your sellers are kept.`)) return;
  try {
    await api("/sales/" + id, { method: "DELETE" });
  } catch (e) {
    // The API refuses a sale with recorded sales unless we say we mean it.
    if (!/recorded sales/i.test(e.message)) return toast(e.message);
    if (!confirm(`"${name}" has recorded sales in it.\n\nDeleting it also erases those takings and the seller payout split. There is no undo.\n\nStill delete?`)) return;
    try { await api("/sales/" + id + "?force=1", { method: "DELETE" }); }
    catch (e2) { return toast(e2.message); }
  }
  toast("Sale deleted"); renderSales();
}
async function createSale() {
  const name = $("#newName").value.trim();
  const r = await api("/sales", { method: "POST", body: JSON.stringify({ name }) });
  toast("Sale created"); openSale(r.id);
}

// ---------- Sale detail ----------
async function openSale(id) {
  state.view = "sale"; state.saleId = id; state.tab = "items"; state.cart = new Set();
  await loadDetail(); renderTab();
}
async function loadDetail() { state.detail = await api("/sales/" + state.saleId); }

function renderTab() { setChrome(); ({ items: renderItems, cashier: renderCashier, summary: renderSummary }[state.tab])(); }

function sellerOptions(sel) {
  const s = state.detail.sellers;
  return `<option value="">— seller (optional) —</option>` +
    s.map(x => `<option value="${x.id}"${x.id === sel ? " selected" : ""}>${esc(x.name)}</option>`).join("");
}

// Items tab: add item + list
function renderItems() {
  const d = state.detail;
  const avail = d.items.filter(i => i.status === "available");
  app.innerHTML = `
    <div class="card" style="border-color:var(--green)">
      <label>Photograph &amp; price with AI</label>
      <div class="muted" style="font-size:.85rem;margin-bottom:8px">Snap a few shots, tell us what you know, and get an identification, price range and listing draft.</div>
      <button class="btn" id="aiAdd">📷 Add item with AI</button>
    </div>
    <div class="card">
      <label>Add an item</label>
      <div class="row"><input id="iName" placeholder="Item name" enterkeyhint="next" style="flex:2"><input id="iPrice" placeholder="$0.00" inputmode="decimal" style="flex:1"></div>
      <div style="height:8px"></div>
      <select id="iSeller">${sellerOptions("")}</select>
      <div style="height:8px"></div>
      <div class="row" style="gap:8px;align-items:center">
        <button class="btn sec sm" id="iCam" style="display:none">📷 Photo</button>
        <label class="btn sec sm" style="display:inline-block;margin:0">Choose photos<input type="file" accept="image/*" multiple hidden id="iFiles"></label>
        <span class="muted" id="iCount" style="font-size:.82rem"></span>
      </div>
      <div id="iThumbs" class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px"></div>
      <div style="height:8px"></div>
      <button class="btn" id="addItem">+ Add item</button>
      <div style="height:6px"></div>
      <button class="btn sec sm" id="addSeller">+ Add a seller</button>
    </div>
    <div class="card">
      <label>Price tags</label>
      <div class="muted" style="font-size:.85rem;margin-bottom:8px">Print a tag for every item — number, name and price, with a code your phone can scan at the cashier.</div>
      <button class="btn sec" id="printLabels"${avail.length ? "" : " disabled"}>🏷️ Print price labels${avail.length ? ` (${avail.length})` : ""}</button>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;margin:6px 2px">
      <h3 style="margin:0">Items (${avail.length} available)</h3>
    </div>
    <div id="itemList" class="list"></div>`;
  // Photos on a manual add: a plain item is still an item you want a picture of, and the
  // storefront uses the first photo as its thumbnail.
  pendingPhotos = [];
  const drawThumbs = () => {
    const t = $("#iThumbs"); if (!t) return;
    t.innerHTML = pendingPhotos.map((f, n) =>
      `<span style="position:relative;display:inline-block">
         <img src="${URL.createObjectURL(f)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:8px">
         <button data-rm="${n}" title="Remove" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;background:var(--rust,#a33);color:#fff;font-size:.7rem;line-height:1;cursor:pointer">✕</button>
       </span>`).join("");
    t.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { pendingPhotos.splice(+b.dataset.rm, 1); drawThumbs(); });
    $("#iCount").textContent = pendingPhotos.length ? `${pendingPhotos.length} photo${pendingPhotos.length === 1 ? "" : "s"}` : "";
  };
  $("#iFiles").onchange = e => { pendingPhotos.push(...e.target.files); e.target.value = ""; drawThumbs(); };
  if (canUseCamera()) {
    const ic = $("#iCam"); ic.style.display = "inline-block";
    ic.onclick = async () => { const f = await openCamera("Photo of the item"); if (f) { pendingPhotos.push(f); drawThumbs(); } };
  }
  $("#addItem").onclick = addItem;
  $("#printLabels").onclick = () => window.open("/labels?sale=" + encodeURIComponent(state.saleId), "_blank", "noopener");
  $("#aiAdd").onclick = () => renderCapture();
  $("#iPrice").addEventListener("keydown", e => { if (e.key === "Enter") addItem(); });
  $("#addSeller").onclick = addSeller;
  const el = $("#itemList");
  if (!d.items.length) { el.innerHTML = `<div class="empty"><div class="em">📦</div>No items yet. Add your first one.</div>`; return; }
  const nameOf = id => (d.sellers.find(s => s.id === id) || {}).name;
  const badge = i => i.listing_status === "live" ? `<span class="pill" style="background:var(--green);color:#fff">online</span>` :
    i.appraisal_status === "pending" ? `<span class="pill">appraising…</span>` : i.appraisal_status === "done" ? `<span class="pill">AI priced</span>` : "";
  el.innerHTML = d.items.map(i => `<div class="li ${i.status === "sold" ? "sold" : ""} tap" data-open="${i.id}">
      ${i.thumb_key ? `<img src="/p/${esc(i.thumb_key)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:8px">` : ""}
      <div><div class="nm">${i.tag_no ? `<span class="muted" style="font-weight:800">#${String(i.tag_no).padStart(3, "0")}</span> ` : ""}${esc(i.ai_title || i.name)}</div><div class="muted" style="font-size:.8rem">${i.status === "sold" ? "sold" : "available"}${i.seller_id ? " · " + esc(nameOf(i.seller_id) || "") : ""} ${badge(i)}</div></div>
      <span class="pr">${money(i.price_cents)}</span>
      ${i.status === "available" ? `<button class="btn rust sm" data-del="${i.id}" style="margin-left:8px">✕</button>` : ""}
    </div>`).join("");
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = async (e) => { e.stopPropagation(); if (!confirm("Delete this item?")) return; await api("/items/" + b.dataset.del, { method: "DELETE" }); await loadDetail(); renderItems(); });
  el.querySelectorAll("[data-open]").forEach(li => li.onclick = () => renderItemDetail(li.dataset.open));
}

// ---------- In-page camera ----------
// `capture="environment"` only opens a camera on phones; on a laptop or a shop counter
// machine it just opens a file picker. This gives every platform a real viewfinder.
const canUseCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

function openCamera(title) {
  return new Promise(resolve => {
    let stream = null, facing = "environment", settled = false;
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column";
    const btn = "background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer";
    ov.innerHTML = `
      <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;color:#fff">
        <button id="camX" style="${btn}">Cancel</button>
        <span style="font-weight:800;font-size:.95rem;text-align:center">${esc(title || "Take a photo")}</span>
        <button id="camFlip" style="${btn}">Flip</button>
      </div>
      <div style="flex:1 1 auto;position:relative;min-height:0">
        <video id="camV" playsinline autoplay muted style="width:100%;height:100%;object-fit:contain;background:#000"></video>
        <div id="camErr" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;text-align:center;color:#fff;padding:28px;font-size:.95rem;line-height:1.45"></div>
      </div>
      <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:18px;padding:18px 14px 26px">
        <button id="camShot" aria-label="Take photo" style="width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid rgba(255,255,255,.45);cursor:pointer"></button>
      </div>`;
    document.body.appendChild(ov);
    const v = ov.querySelector("#camV"), err = ov.querySelector("#camErr");

    const stop = () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {} stream = null; };
    const done = f => { if (settled) return; settled = true; stop(); document.removeEventListener("keydown", onKey); ov.remove(); resolve(f); };
    const onKey = e => { if (e.key === "Escape") done(null); };
    document.addEventListener("keydown", onKey);

    const fail = msg => { err.textContent = msg; err.style.display = "flex"; ov.querySelector("#camShot").style.opacity = ".35"; };

    async function start() {
      stop(); err.style.display = "none"; ov.querySelector("#camShot").style.opacity = "1";
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
          audio: false
        });
        v.srcObject = stream;
        await v.play().catch(() => {});
      } catch (e) {
        const n = e && e.name;
        if (n === "NotAllowedError" || n === "SecurityError")
          fail("Camera access was blocked. Allow it from the camera icon in your browser's address bar, then try again — or use “choose file” instead.");
        else if (n === "NotFoundError" || n === "OverconstrainedError")
          fail("No camera found on this device. Use “choose file” instead.");
        else if (n === "NotReadableError")
          fail("Another app is using the camera. Close it and try again.");
        else fail("Couldn't start the camera. Use “choose file” instead.");
      }
    }

    ov.querySelector("#camX").onclick = () => done(null);
    ov.querySelector("#camFlip").onclick = () => { facing = facing === "environment" ? "user" : "environment"; start(); };
    ov.querySelector("#camShot").onclick = () => {
      if (!v.videoWidth) return;
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => done(b ? new File([b], "shot-" + Date.now() + ".jpg", { type: "image/jpeg" }) : null), "image/jpeg", 0.92);
    };
    start();
  });
}

// ---------- AI capture flow ----------
const SHOTS = [
  { kind: "front", label: "Front", hint: "Whole item, straight on, good light" },
  { kind: "back", label: "Back", hint: "Reverse side" },
  { kind: "underside", label: "Underside / inside", hint: "Joinery, base, foot rim, interior" },
  { kind: "marks", label: "Marks & labels", hint: "Stamps, signatures, labels, numbers — close and sharp" },
  { kind: "detail", label: "Detail", hint: "Decoration, hardware, texture" },
  { kind: "damage", label: "Damage", hint: "Chips, repairs, wear (optional)" },
];
function renderCapture() {
  state.tab = "items"; setChrome();
  const shots = {};
  app.innerHTML = `<h1 class="h1">Add item with AI</h1>
    <div class="muted" style="font-size:.85rem;margin-bottom:6px">Take the shots you can. The marks photo matters most.</div>
    <div class="card"><div class="shots" id="shots">${SHOTS.map(s => `
      <div class="shot" data-kind="${s.kind}"><input type="file" accept="image/*" capture="environment" hidden>
        <div class="ph" id="ph-${s.kind}">📷</div><div class="sl">${s.label}</div><div class="sh">${s.hint}</div>
        <a href="#" class="pick" style="font-size:.64rem;color:var(--sub);text-decoration:underline">choose file</a></div>`).join("")}</div>
      <div style="height:8px"></div>
      <button class="btn sec sm" id="moreCam" style="display:none">📷 Another photo</button>
      <label class="btn sec sm" style="display:inline-block">+ More photos <input type="file" accept="image/*" multiple hidden id="moreShots"></label>
      <span class="muted" id="moreCount" style="font-size:.82rem;margin-left:8px"></span>
    </div>
    <div class="card">
      <label>Brief description</label>
      <textarea id="cDesc" rows="3" placeholder="What do you know? Where it came from, how old you think it is, condition…"></textarea>
      <div style="height:10px"></div>
      <label>Any writing, stamps or marks on it</label>
      <textarea id="cMarks" rows="2" placeholder="Copy exactly what you can read, e.g. 'Stickley', 'Made in Occupied Japan', '1847 Rogers Bros'"></textarea>
      <div style="height:10px"></div>
      <select id="cSeller">${sellerOptions("")}</select>
      <div style="height:12px"></div>
      <button class="btn" id="cGo">✨ Identify &amp; price</button>
      <div style="height:6px"></div>
      <button class="btn sec" id="cCancel">Cancel</button>
    </div>`;
  const more = [];
  const setShot = (kind, f) => {
    shots[kind] = f;
    const ph = $("#ph-" + kind); ph.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
  };
  app.querySelectorAll(".shot input").forEach(inp => inp.onchange = () => {
    const kind = inp.closest(".shot").dataset.kind, f = inp.files[0]; if (!f) return;
    setShot(kind, f);
  });
  // Tapping a tile opens the live viewfinder where we can; "choose file" is always there as a fallback.
  app.querySelectorAll(".shot").forEach(tile => {
    const kind = tile.dataset.kind, inp = tile.querySelector("input"), s = SHOTS.find(x => x.kind === kind);
    tile.querySelector(".pick").onclick = e => { e.preventDefault(); e.stopPropagation(); inp.click(); };
    tile.onclick = async () => {
      if (!canUseCamera()) return inp.click();
      const f = await openCamera(s ? s.label + " — " + s.hint : "Take a photo");
      if (f) setShot(kind, f);
    };
  });
  const bumpMore = () => $("#moreCount").textContent = more.length ? more.length + " extra" : "";
  $("#moreShots").onchange = e => { more.push(...e.target.files); bumpMore(); };
  if (canUseCamera()) {
    const mc = $("#moreCam"); mc.style.display = "inline-block"; mc.style.marginRight = "8px";
    mc.onclick = async () => { const f = await openCamera("Another photo"); if (f) { more.push(f); bumpMore(); } };
  }
  $("#cCancel").onclick = renderItems;
  $("#cGo").onclick = async () => {
    const files = [...Object.entries(shots).map(([k, f]) => ({ kind: k, f })), ...more.map(f => ({ kind: "other", f }))];
    if (!files.length) return toast("Take at least one photo");
    const description = $("#cDesc").value.trim(), markings = $("#cMarks").value.trim(), seller_id = $("#cSeller").value;
    $("#cGo").disabled = true; $("#cGo").textContent = "Uploading…";
    try {
      const { id } = await api("/sales/" + state.saleId + "/items", { method: "POST", body: JSON.stringify({ name: "New item", description, markings, seller_id }) });
      const fd = new FormData();
      for (const { kind, f } of files) fd.append("photos", await shrink(f), f.name || (kind + ".jpg"));
      fd.append("kinds", files.map(x => x.kind).join(","));
      const up = await fetch("/api/items/" + id + "/photos", { method: "POST", body: fd, credentials: "same-origin" });
      if (!up.ok) throw new Error((await up.json()).error || "upload failed");
      $("#cGo").textContent = "Asking the appraiser…";
      await api("/items/" + id + "/appraise", { method: "POST", body: JSON.stringify({}) });
      await loadDetail(); renderItemDetail(id);
    } catch (e) { toast(e.message); $("#cGo").disabled = false; $("#cGo").textContent = "✨ Identify & price"; }
  };
}
// downscale to <=1600px JPEG so uploads are quick on cell data
async function shrink(file, max = 1600) {
  if (!file.type.startsWith("image/") || file.type === "image/heic") return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.size < 2.5e6) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
    return new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return file; }
}
// ---------- Item detail: photos, appraisal card, approve & list ----------
let pollT;
async function renderItemDetail(id) {
  clearTimeout(pollT);
  state.tab = "items"; setChrome();
  let b;
  try { b = await api("/items/" + id); } catch (e) { return toast(e.message); }
  const { item, photos, appraisal } = b;
  const r = appraisal && appraisal.result;
  const pending = appraisal && appraisal.status === "pending";
  const pr = r && r.price_range;
  const conf = r ? Math.round(r.confidence * 100) : 0;
  app.innerHTML = `
    <button class="back" id="toItems" style="padding:8px 0">‹ Items</button>
    <div class="thumbs">${photos.map(p => `<img src="${esc(p.url)}" alt="${esc(p.kind)}" title="${esc(p.kind)}">`).join("")}</div>
    ${pending ? `<div class="card" style="text-align:center"><div class="big" style="font-size:1.3rem">Appraising…</div><div class="muted">Nemotron is reading ${photos.length} photo${photos.length === 1 ? "" : "s"}. Usually under a minute.</div></div>` : ""}
    ${appraisal && appraisal.status === "error" ? `<div class="card" style="border-color:var(--rust)"><b>Appraisal failed.</b><div class="muted" style="font-size:.85rem">${esc(appraisal.error)}</div><div style="height:8px"></div><button class="btn sec sm" id="retry">Try again</button></div>` : ""}
    ${r ? `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start"><h3 style="font-size:1.15rem">${esc(r.identification.name)}</h3><span class="pill" title="confidence">${conf}% sure</span></div>
      <div class="muted" style="font-size:.85rem">${[r.identification.maker, r.identification.period, r.identification.origin, r.identification.style].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="kpis" style="margin:12px 0">
        <div class="kpi"><div class="n">$${Math.round(pr.low)}–$${Math.round(pr.high)}</div><div class="l">Price range</div></div>
        <div class="kpi"><div class="n">$${Math.round(pr.suggested_retail)}</div><div class="l">Suggested · floor $${Math.round(pr.floor)}</div></div>
      </div>
      ${r.melt ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--green);background:var(--bg);font-size:.82rem">
          <b>Metal content:</b> ${r.melt.fine_troy_oz} ozt ${esc(r.melt.metal)} × $${r.melt.price_per_oz.toFixed(2)}/ozt = <b>$${r.melt.value} melt</b>
          <div class="muted" style="margin-top:3px">${esc(r.melt.basis)}</div>
          <div class="muted" style="margin-top:3px;font-size:.92em">${esc(r.melt.source)}, ${esc(String(r.melt.as_of).slice(0, 10))}. ${r.melt.applied === false ? "Weight is an estimate, so this has <b>not</b> been used as a price floor — weigh it to be sure." : "Scrap is a floor — never sell below it."}</div>
        </div>` : ""}
      <div class="muted" style="font-size:.82rem">${esc(pr.basis)}</div>
      ${r.evidence.length ? `<h3 style="font-size:.95rem;margin-top:12px">Why</h3><ul class="ev">${r.evidence.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      ${r.transcribed_text.length ? `<div class="muted" style="font-size:.82rem;margin-top:6px">Read on item: ${r.transcribed_text.map(esc).join(" · ")}</div>` : ""}
      ${r.comparables.length ? `<h3 style="font-size:.95rem;margin-top:12px">Comparables</h3>${r.comparables.map(c => `<div class="split"><a href="${esc(c.url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">${esc(c.title)}</a><span class="amt">${c.price ? "$" + Math.round(c.price) : ""}</span></div>`).join("")}` : ""}
      ${r.questions_for_dealer.length ? `<div class="muted" style="font-size:.82rem;margin-top:10px">Would help: ${r.questions_for_dealer.map(esc).join(" · ")}</div>` : ""}
      ${r.warnings.length ? `<div class="muted" style="font-size:.75rem;margin-top:8px">${r.warnings.map(esc).join(" · ")}</div>` : ""}
      <div class="muted" style="font-size:.72rem;margin-top:8px">${esc(r.models.text)} + ${esc(r.models.vision)} on Nebius</div>
    </div>` : ""}
    <div class="card">
      <label>Listing title</label><input id="lTitle" value="${esc(item.ai_title || item.name)}">
      <div style="height:8px"></div>
      <label>Price</label><input id="lPrice" inputmode="decimal" value="${item.price_cents ? (item.price_cents / 100).toFixed(2) : (pr ? Math.round(pr.suggested_retail).toFixed(2) : "")}" placeholder="$0.00">
      <div style="height:8px"></div>
      <label>Description</label><textarea id="lDesc" rows="6">${esc(item.ai_description || item.description || "")}</textarea>
      <div style="height:12px"></div>
      ${item.status !== "available" ? `<div class="muted">Sold.</div>` :
        item.listing_status === "live" ? `<a class="btn" style="display:block;text-align:center;text-decoration:none" id="viewLive" target="_blank">View online listing ↗</a><div style="height:6px"></div><button class="btn sec" id="unlist">Take offline</button><div style="height:6px"></div><button class="btn sec" id="saveDraft">Save changes</button>` :
        `<button class="btn" id="publish">✓ Approve &amp; list online</button><div style="height:6px"></div><button class="btn sec" id="saveDraft">Save (keep in store only)</button>`}
      ${!pending && photos.length ? `<div style="height:6px"></div><button class="btn sec sm" id="reappraise">↻ Re-run appraisal</button>` : ""}
    </div>`;
  $("#toItems").onclick = async () => { clearTimeout(pollT); await loadDetail(); renderItems(); };
  const payload = (extra = {}) => ({ title: $("#lTitle").value, description: $("#lDesc").value, price: $("#lPrice").value, ...extra });
  const publishAs = async (listing_status) => {
    try { const res = await api("/items/" + id + "/publish", { method: "POST", body: JSON.stringify(payload({ listing_status })) });
      toast(listing_status === "live" ? "Listed online" : "Saved"); renderItemDetail(id); return res; }
    catch (e) { if (/shop address/.test(e.message)) return renderShopSetup(() => renderItemDetail(id)); toast(e.message); }
  };
  if ($("#publish")) $("#publish").onclick = () => publishAs("live");
  if ($("#saveDraft")) $("#saveDraft").onclick = () => publishAs(item.listing_status === "live" ? "live" : "hidden");
  if ($("#unlist")) $("#unlist").onclick = () => publishAs("hidden");
  if ($("#viewLive")) { const me = await api("/auth/me"); $("#viewLive").href = "/shop/" + me.shop_slug + "/item/" + id; }
  const rerun = async () => { await api("/items/" + id + "/appraise", { method: "POST", body: JSON.stringify(payload()) }); renderItemDetail(id); };
  if ($("#reappraise")) $("#reappraise").onclick = rerun;
  if ($("#retry")) $("#retry").onclick = rerun;
  if (pending) pollT = setTimeout(() => renderItemDetail(id), 4000);
}

// ---------- Shop setup ----------
async function renderShopSetup(done) {
  const me = await api("/auth/me");
  app.innerHTML = `<h1 class="h1">Your online shop</h1>
    <div class="muted" style="font-size:.85rem">Approved items appear at your shop address. Set it once.</div>
    <div class="card">
      <label>Shop name</label><input id="sName" value="${esc(me.shop_name || "")}" placeholder="e.g. The Miller Estate">
      <div style="height:8px"></div>
      <label>Shop address</label><div class="row"><span class="muted" style="font-size:.85rem">${location.origin}/shop/</span><input id="sSlug" value="${esc(me.shop_slug || "")}" placeholder="bottle-tree" style="flex:1"></div>
      <div style="height:8px"></div>
      <label>Tagline (optional)</label><input id="sBlurb" value="${esc(me.shop_blurb || "")}" placeholder="Antiques, curiosities and estate finds in Hudson, NY">
      <div style="height:12px"></div>
      <button class="btn" id="sSave">Save shop</button><div style="height:6px"></div><button class="btn sec" id="sBack">Back</button>
    </div>
    <div class="card">
      <label>Counter kiosk (Jetson)</label>
      <div class="muted" style="font-size:.85rem">Items appraised on the counter kiosk land here. Paste this key into the kiosk's BOTTLETREE_DEVICE_KEY.</div>
      <div style="height:8px"></div>
      <input id="dKey" readonly placeholder="no device key yet" style="font-family:monospace;font-size:.85rem">
      <div style="height:8px"></div>
      <div class="row"><button class="btn sec sm" id="dNew">Generate new key</button><button class="btn sec sm" id="dCopy">Copy</button><button class="btn rust sm" id="dRevoke">Revoke</button></div>
    </div>`;
  $("#sBack").onclick = done;
  const loadKey = async () => { const k = await api("/me/device-key"); $("#dKey").value = k.device_key || ""; };
  loadKey();
  $("#dNew").onclick = async () => { if ($("#dKey").value && !confirm("Replace the current kiosk key? The old one stops working.")) return; await api("/me/device-key", { method: "POST" }); toast("New kiosk key"); loadKey(); };
  $("#dCopy").onclick = () => { navigator.clipboard?.writeText($("#dKey").value); toast("Copied"); };
  $("#dRevoke").onclick = async () => { if (!confirm("Revoke the kiosk key?")) return; await api("/me/device-key", { method: "DELETE" }); toast("Revoked"); loadKey(); };
  $("#sSave").onclick = async () => {
    try { await api("/me/shop", { method: "PUT", body: JSON.stringify({ shop_name: $("#sName").value, slug: $("#sSlug").value, shop_blurb: $("#sBlurb").value }) }); toast("Shop saved"); done(); }
    catch (e) { toast(e.message); }
  };
}

async function addItem() {
  const name = $("#iName").value.trim(), price = $("#iPrice").value.trim(), seller_id = $("#iSeller").value;
  if (!name) return toast("Item name?");
  if (price === "" || isNaN(Number(price))) return toast("Enter a price");
  if (Number(price) < 0) return toast("That's not a price");
  // $0 is allowed — free stuff is real at a sale — but it should be deliberate, not a typo.
  if (Number(price) === 0 && !confirm(`Add "${name}" with no price?\n\nIt'll show as "needs a price" at the cashier until you set one.`)) return;
  const btn = $("#addItem"), photos = pendingPhotos.slice();
  btn.disabled = true; if (photos.length) btn.textContent = "Uploading…";
  let id;
  try { ({ id } = await api("/sales/" + state.saleId + "/items", { method: "POST", body: JSON.stringify({ name, price, seller_id }) })); }
  catch (e) { btn.disabled = false; btn.textContent = "+ Add item"; return toast(e.message); }
  // The item exists now. A photo upload that fails must not lose it — say so and move on.
  if (photos.length) {
    try {
      const fd = new FormData();
      for (const f of photos) fd.append("photos", await shrink(f), f.name || "photo.jpg");
      fd.append("kinds", photos.map(() => "other").join(","));
      const up = await fetch("/api/items/" + id + "/photos", { method: "POST", body: fd, credentials: "same-origin" });
      if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || "upload failed");
    } catch (e) {
      toast(`Item added, but the photos didn't upload (${e.message}) — open it to try again`);
      pendingPhotos = []; await loadDetail(); return renderItems();
    }
  }
  pendingPhotos = [];
  toast("Added"); await loadDetail(); renderItems(); $("#iName").focus();
}
async function addSeller() {
  const name = prompt("Seller name (e.g. Mom, Booth 12):");
  if (!name || !name.trim()) return;
  await api("/sales/" + state.saleId + "/sellers", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
  toast("Seller added"); await loadDetail(); renderItems();
}

// ---------- tag scanning ----------
// BarcodeDetector is native in Chrome/Android and reads QR and Code 128 alike. Safari has no such
// thing, so there we say so plainly and lean on the number printed under the code. Typing "014" at a
// card table beats a scanner that half-works.
async function addByTag(raw) {
  if (!raw) return;
  let it;
  try { it = await api("/sales/" + state.saleId + "/tag/" + encodeURIComponent(raw)); }
  catch (e) { return toast(e.message); }
  if (it.status !== "available") return toast(`#${it.tag_no} ${it.name} — already sold`);
  if (state.cart.has(it.id)) return toast(`#${it.tag_no} is already in the sale`);
  state.cart.add(it.id);
  const t = $("#tagNo"); if (t) t.value = "";
  renderCashier();
  toast(`#${String(it.tag_no).padStart(3, "0")} ${it.ai_title || it.name} — ${money(it.price_cents)}`);
}

// Safari has no BarcodeDetector, so we ship ZXing — but it is ~474KB, and a phone that already has
// a native decoder should never download it. Fetched on first use only, then cached by the browser.
let zxingLoad = null;
function loadZxing() {
  if (window.BTScan) return Promise.resolve(true);
  if (!zxingLoad) zxingLoad = new Promise(res => {
    const s = document.createElement("script");
    s.src = "/scan.js"; s.async = true;
    s.onload = () => res(!!window.BTScan);
    s.onerror = () => { zxingLoad = null; res(false); };
    document.head.appendChild(s);
  });
  return zxingLoad;
}

async function scanTag() {
  if (!canUseCamera()) return toast("No camera here — type the number under the code");
  let det = null;
  if ("BarcodeDetector" in window) {
    try { det = new BarcodeDetector({ formats: ["qr_code", "code_128"] }); } catch { det = null; }
  }
  if (!det) {
    toast("Starting the scanner…");
    if (!(await loadZxing())) return toast("Couldn't load the scanner — type the number instead");
  }

  let stream = null, stop = false, zx = null;
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column";
  ov.innerHTML = `
    <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;color:#fff">
      <button id="scX" style="background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700">Done</button>
      <span style="font-weight:800;font-size:.95rem">Point at a price tag</span><span style="width:64px"></span>
    </div>
    <div style="flex:1 1 auto;position:relative;min-height:0">
      <video id="scV" playsinline autoplay muted style="width:100%;height:100%;object-fit:cover;background:#000"></video>
      <div style="position:absolute;inset:18% 12%;border:3px solid rgba(255,255,255,.75);border-radius:14px"></div>
    </div>
    <div id="scLog" style="flex:0 0 auto;color:#fff;text-align:center;padding:12px 14px 24px;font-size:.9rem;min-height:2.6em">Scanning…</div>`;
  document.body.appendChild(ov);
  const v = ov.querySelector("#scV"), log = ov.querySelector("#scLog");
  const close = () => {
    stop = true;
    try { zx && zx.stop(); } catch {}
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
    ov.remove(); renderCashier();
  };
  ov.querySelector("#scX").onclick = close;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    v.srcObject = stream; await v.play().catch(() => {});
  } catch { log.textContent = "Couldn't open the camera."; return; }

  // One code per tag per 2.5s, whichever engine saw it — otherwise a tag held in frame fires every frame.
  const seen = new Map();
  let busy = false;
  const onHit = async val => {
    val = (val || "").trim();
    if (!val || busy) return;
    if (Date.now() - (seen.get(val) || 0) < 2500) return;
    seen.set(val, Date.now());
    busy = true;
    try {
      const it = await api("/sales/" + state.saleId + "/tag/" + encodeURIComponent(val));
      if (it.status !== "available") log.textContent = `#${it.tag_no} ${it.name} — already sold`;
      else if (state.cart.has(it.id)) log.textContent = `#${it.tag_no} already added`;
      else {
        state.cart.add(it.id);
        log.textContent = `✓ #${String(it.tag_no).padStart(3, "0")} ${it.ai_title || it.name} — ${money(it.price_cents)}`;
        updateCart();
        if (navigator.vibrate) navigator.vibrate(60);
      }
    } catch (e) { log.textContent = e.message; }
    finally { busy = false; }
  };

  if (det) {
    // Native path: poll the detector. Cheap, and it keeps the camera open between reads.
    while (!stop) {
      try { for (const h of await det.detect(v)) await onHit(h.rawValue); } catch {}
      await new Promise(r => setTimeout(r, 220));
    }
  } else {
    // ZXing drives its own frame loop and calls us on every decode.
    try { zx = await window.BTScan.start(v, onHit); }
    catch { log.textContent = "Scanner wouldn't start — type the number instead"; }
  }
}

// Cashier tab: tap available items into cart, charge
function cartTotal() { const d = state.detail; return d.items.filter(i => state.cart.has(i.id)).reduce((a, i) => a + i.price_cents, 0); }
function renderCashier() {
  const d = state.detail;
  const avail = d.items.filter(i => i.status === "available");
  app.innerHTML = `<div class="card" style="border-color:var(--cobalt)">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn" id="scanGo" style="flex:1 1 60%">📷 Scan a tag</button>
        <input id="tagNo" inputmode="numeric" placeholder="or type #" style="flex:1 1 30%;text-align:center">
      </div>
      <div class="muted" style="font-size:.8rem;margin-top:6px">Scan the QR or barcode on the price tag. No camera? Type the number under it.${!("BarcodeDetector" in window) ? " First scan on this phone downloads the reader — do it once on wifi." : ""}</div>
    </div>
    <div class="row" style="justify-content:space-between;margin:8px 2px"><h3>Tap items to sell</h3><span class="muted" style="font-size:.85rem">${avail.length} available</span></div>
    <div id="cashList" class="list"></div>`;
  $("#scanGo").onclick = scanTag;
  $("#tagNo").addEventListener("keydown", e => { if (e.key === "Enter") addByTag($("#tagNo").value.trim()); });
  const el = $("#cashList");
  if (!avail.length) { el.innerHTML = `<div class="empty"><div class="em">💵</div>Nothing available to sell. Add items first.</div>`; }
  else el.innerHTML = avail.map(i => `<div class="li tap ${state.cart.has(i.id) ? "selected" : ""}" data-id="${i.id}">
      <div class="nm">${state.cart.has(i.id) ? "✓ " : ""}${i.tag_no ? `<span class="muted" style="font-weight:800">#${String(i.tag_no).padStart(3, "0")}</span> ` : ""}${esc(i.ai_title || i.name)}</div>
      <span class="pr" ${i.price_cents <= 0 ? 'style="color:var(--rust,#a33);font-size:.82rem"' : ""}>${i.price_cents > 0 ? money(i.price_cents) : "needs a price"}</span></div>`).join("");
  el.querySelectorAll(".li").forEach(li => li.onclick = async () => {
    const id = li.dataset.id, it = avail.find(x => x.id === id);
    // An unpriced item can't just go in the cart — ask now, while the buyer is standing there.
    if (it && it.price_cents <= 0 && !state.cart.has(id)) {
      const p = prompt(`Price for ${it.ai_title || it.name}?\n\nLeave blank to give it away.`, "");
      if (p === null) return;
      const price = p.trim() === "" ? 0 : Number(p);
      if (!Number.isFinite(price) || price < 0) return toast("That's not a price");
      try { await api("/items/" + id + "/price", { method: "PUT", body: JSON.stringify({ price }) }); }
      catch (e) { return toast(e.message); }
      await loadDetail();
    }
    state.cart.has(id) ? state.cart.delete(id) : state.cart.add(id);
    renderCashier();
  });
  updateCart();
}
function updateCart() { $("#cartTot").textContent = money(cartTotal()); $("#cartCnt").textContent = state.cart.size + " item" + (state.cart.size === 1 ? "" : "s"); setChrome(); }
async function charge() {
  if (!state.cart.size) return;
  const ids = [...state.cart];
  const done = r => { toast("Sold — " + money(r.total_cents) + " (cash)"); state.cart = new Set(); loadDetail().then(renderCashier); };
  try { return done(await api("/sales/" + state.saleId + "/checkout", { method: "POST", body: JSON.stringify({ item_ids: ids }) })); }
  catch (e) {
    // The server refuses a free sale unless we say we mean it. Ask, rather than silently ringing up $0.
    if (!/no price/i.test(e.message)) return toast(e.message);
    if (!confirm(`${e.message}.\n\nGive it away for free?`)) return;
    try { return done(await api("/sales/" + state.saleId + "/checkout", { method: "POST", body: JSON.stringify({ item_ids: ids, allow_free: true }) })); }
    catch (e2) { toast(e2.message); }
  }
}

// Summary tab
async function renderSummary() {
  app.innerHTML = `<div class="muted" style="padding:20px;text-align:center">Loading…</div>`;
  const s = await api("/sales/" + state.saleId + "/summary");
  app.innerHTML = `<h1 class="h1" style="margin-top:16px">Sale summary</h1>
    <div class="kpis" style="margin:10px 0">
      <div class="kpi"><div class="n">${money(s.revenue_cents)}</div><div class="l">Cash taken · ${s.txn_count} sale${s.txn_count === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="n">${s.sold_items}</div><div class="l">Items sold</div></div>
      <div class="kpi"><div class="n">${s.available_items}</div><div class="l">Still available</div></div>
      <div class="kpi"><div class="n">${money(s.available_cents)}</div><div class="l">Unsold value</div></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:6px">Payout split</h3>
      ${s.split.length ? s.split.map(r => `<div class="split"><span>${esc(r.seller)} <span class="muted" style="font-size:.82rem">· ${r.items} item${r.items === 1 ? "" : "s"}</span></span><span class="amt">${money(r.cents)}</span></div>`).join("")
        : `<div class="muted" style="padding:10px 0">No sales yet — the split fills in as you sell.</div>`}
    </div>
    <div class="muted" style="font-size:.8rem;text-align:center;margin-top:10px">Estate Sale Road Show · free POS · cash in person, cards online · AI appraisals by NVIDIA Nemotron on Nebius.</div>`;
}

// tab bar + back
tabs.querySelectorAll("button").forEach(b => b.onclick = () => { state.tab = b.dataset.tab; state.cart = state.tab === "cashier" ? state.cart : new Set(); renderTab(); });
backBtn.onclick = renderSales;
$("#cartGo").onclick = charge;

// PWA
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// boot: check session, then show sales or the sign-in screen
(async function init() {
  try {
    const me = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (me.ok) { const d = await me.json(); user = d.email; renderSales(); }
    else renderAuth("login");
  } catch { renderAuth("login"); }
})();
