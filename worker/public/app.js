// Bottle Tree app v0.1 — front-end
const $ = s => document.querySelector(s);
const app = $("#app"), tabs = $("#tabs"), ctx = $("#ctx"), backBtn = $("#backBtn"),
      cartbar = $("#cartbar");
let state = { view: "sales", saleId: null, detail: null, tab: "items", cart: new Set() };
let user = null;

const money = c => "$" + (c / 100).toFixed(2);
const esc = s => (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
async function api(path, opts) {
  const r = await fetch("/api" + path, { headers: { "content-type": "application/json" }, credentials: "same-origin", ...opts });
  if (r.status === 401 && !path.startsWith("/auth")) { user = null; renderAuth(); throw new Error("Please sign in"); }
  if (!r.ok) { let e = {}; try { e = await r.json(); } catch {} throw new Error(e.error || ("HTTP " + r.status)); }
  return r.json();
}
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); }

function setChrome() {
  const inSale = state.view === "sale";
  tabs.classList.toggle("hidden", !inSale);
  backBtn.classList.toggle("hidden", !inSale);
  ctx.textContent = inSale && state.detail ? state.detail.sale.name : "";
  cartbar.classList.toggle("hidden", !(inSale && state.tab === "cashier" && state.cart.size));
  [...tabs.children].forEach(b => b.classList.toggle("on", b.dataset.tab === state.tab));
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
}
async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  user = null; renderAuth("login");
}

// ---------- Sales list ----------
async function renderSales() {
  state.view = "sales"; state.saleId = null; state.detail = null; setChrome();
  app.innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline;margin-top:6px">
      <h1 class="h1" style="margin:0">Your sales</h1>
      <span><a href="#" id="myshop" class="muted" style="font-size:.85rem;font-weight:700;margin-right:12px">My shop</a><a href="#" id="signout" class="muted" style="font-size:.85rem;font-weight:700">Sign out</a></span></div>
    <div class="muted" style="font-size:.82rem;margin:2px 0 4px">${esc(user || "")}</div>
    <div class="card">
      <label>Start a new sale</label>
      <div class="row"><input id="newName" placeholder="e.g. Saturday Garage Sale" enterkeyhint="go"></div>
      <div style="height:8px"></div>
      <button class="btn" id="newBtn">+ New sale</button>
    </div>
    <div id="salesList" class="list"></div>`;
  $("#newBtn").onclick = createSale;
  $("#newName").addEventListener("keydown", e => { if (e.key === "Enter") createSale(); });
  $("#signout").onclick = e => { e.preventDefault(); logout(); };
  $("#myshop").onclick = e => { e.preventDefault(); renderShopSetup(renderSales); };
  const list = await api("/sales");
  const el = $("#salesList");
  if (!list.length) { el.innerHTML = `<div class="empty"><div class="em">🏷️</div>No sales yet. Start one above.</div>`; return; }
  el.innerHTML = list.map(s => `<div class="li tap" data-id="${s.id}">
      <div><div class="nm">${esc(s.name)}</div><div class="muted" style="font-size:.82rem">${s.items} items · ${money(s.revenue_cents)} sold</div></div>
      <span class="pr">${s.status === "open" ? "" : "✓ "}<span class="pill">${s.status}</span></span>
    </div>`).join("");
  el.querySelectorAll(".li").forEach(li => li.onclick = () => openSale(li.dataset.id));
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
      <button class="btn" id="addItem">+ Add item</button>
      <div style="height:6px"></div>
      <button class="btn sec sm" id="addSeller">+ Add a seller</button>
    </div>
    <div class="row" style="justify-content:space-between;margin:6px 2px"><h3>Items (${avail.length} available)</h3></div>
    <div id="itemList" class="list"></div>`;
  $("#addItem").onclick = addItem;
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
      <div><div class="nm">${esc(i.ai_title || i.name)}</div><div class="muted" style="font-size:.8rem">${i.status === "sold" ? "sold" : "available"}${i.seller_id ? " · " + esc(nameOf(i.seller_id) || "") : ""} ${badge(i)}</div></div>
      <span class="pr">${money(i.price_cents)}</span>
      ${i.status === "available" ? `<button class="btn rust sm" data-del="${i.id}" style="margin-left:8px">✕</button>` : ""}
    </div>`).join("");
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = async (e) => { e.stopPropagation(); if (!confirm("Delete this item?")) return; await api("/items/" + b.dataset.del, { method: "DELETE" }); await loadDetail(); renderItems(); });
  el.querySelectorAll("[data-open]").forEach(li => li.onclick = () => renderItemDetail(li.dataset.open));
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
      <label class="shot" data-kind="${s.kind}"><input type="file" accept="image/*" capture="environment" hidden>
        <div class="ph" id="ph-${s.kind}">📷</div><div class="sl">${s.label}</div><div class="sh">${s.hint}</div></label>`).join("")}</div>
      <div style="height:8px"></div>
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
  app.querySelectorAll(".shot input").forEach(inp => inp.onchange = () => {
    const kind = inp.closest(".shot").dataset.kind, f = inp.files[0]; if (!f) return;
    shots[kind] = f; const ph = $("#ph-" + kind); ph.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
  });
  $("#moreShots").onchange = e => { more.push(...e.target.files); $("#moreCount").textContent = more.length + " extra"; };
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
      <label>Shop name</label><input id="sName" value="${esc(me.shop_name || "")}" placeholder="e.g. Bottle Tree Antiques">
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
  try { await api("/sales/" + state.saleId + "/items", { method: "POST", body: JSON.stringify({ name, price, seller_id }) }); }
  catch (e) { return toast(e.message); }
  toast("Added"); await loadDetail(); renderItems(); $("#iName").focus();
}
async function addSeller() {
  const name = prompt("Seller name (e.g. Mom, Booth 12):");
  if (!name || !name.trim()) return;
  await api("/sales/" + state.saleId + "/sellers", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
  toast("Seller added"); await loadDetail(); renderItems();
}

// Cashier tab: tap available items into cart, charge
function cartTotal() { const d = state.detail; return d.items.filter(i => state.cart.has(i.id)).reduce((a, i) => a + i.price_cents, 0); }
function renderCashier() {
  const d = state.detail;
  const avail = d.items.filter(i => i.status === "available");
  app.innerHTML = `<div class="row" style="justify-content:space-between;margin:8px 2px"><h3>Tap items to sell</h3><span class="muted" style="font-size:.85rem">${avail.length} available</span></div>
    <div id="cashList" class="list"></div>`;
  const el = $("#cashList");
  if (!avail.length) { el.innerHTML = `<div class="empty"><div class="em">💵</div>Nothing available to sell. Add items first.</div>`; }
  else el.innerHTML = avail.map(i => `<div class="li tap ${state.cart.has(i.id) ? "selected" : ""}" data-id="${i.id}">
      <div class="nm">${state.cart.has(i.id) ? "✓ " : ""}${esc(i.name)}</div><span class="pr">${money(i.price_cents)}</span></div>`).join("");
  el.querySelectorAll(".li").forEach(li => li.onclick = () => { const id = li.dataset.id; state.cart.has(id) ? state.cart.delete(id) : state.cart.add(id); renderCashier(); });
  updateCart();
}
function updateCart() { $("#cartTot").textContent = money(cartTotal()); $("#cartCnt").textContent = state.cart.size + " item" + (state.cart.size === 1 ? "" : "s"); setChrome(); }
async function charge() {
  if (!state.cart.size) return;
  const ids = [...state.cart];
  try { const r = await api("/sales/" + state.saleId + "/checkout", { method: "POST", body: JSON.stringify({ item_ids: ids }) });
    toast("Sold — " + money(r.total_cents) + " (cash)"); state.cart = new Set(); await loadDetail(); renderCashier(); }
  catch (e) { toast(e.message); }
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
    <div class="muted" style="font-size:.8rem;text-align:center;margin-top:10px">Bottle Tree v0.3 · cash in store, cards online · AI appraisals by NVIDIA Nemotron on Nebius.</div>`;
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
