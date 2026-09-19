// Bottle Tree billing UI — the paywall and the "estimates left" pill.
// Native (Capacitor Android): purchases go through RevenueCat -> Google Play; the RevenueCat webhook credits the
// account server-side, so after a purchase we just re-read /api/me/plan. Web: shows the plans + a Play link.
window.BTBilling = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const native = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
  let plan = null, Purchases = null, configured = false;

  async function refresh() {
    const r = await fetch("/api/me/plan", { credentials: "same-origin" });
    plan = r.ok ? await r.json() : null;
    return plan;
  }

  // RevenueCat: prefer the bundled SDK wrapper (rc-sdk.js), fall back to the raw native plugin bridge.
  async function ensurePurchases() {
    if (!native || configured) return configured;
    if (!plan) await refresh();
    if (!plan || !plan.rc_android_key) return false;
    Purchases = window.RCPurchases || (window.Capacitor.registerPlugin && window.Capacitor.registerPlugin("Purchases"));
    if (!Purchases) return false;
    // appUserID = our user id, so the webhook can credit the right account
    await Purchases.configure({ apiKey: plan.rc_android_key, appUserID: plan.user_id });
    configured = true;
    return true;
  }

  function summary() {
    if (!plan) return "";
    if (plan.plan === "unlimited") return "Unlimited estimates";
    if (plan.plan === "pro") return `${Math.max(0, plan.monthly_cap - plan.used_this_month)} of ${plan.monthly_cap} left this month`;
    return `${plan.credits} estimate${plan.credits === 1 ? "" : "s"} left`;
  }

  const ORDER = ["estimate_1", "estimate_10", "pro_monthly", "unlimited_monthly"];
  const BLURB = {
    estimate_1: "One photo-to-price estimate",
    estimate_10: "Ten estimates, never expire",
    pro_monthly: "300 estimates a month + eBay/Etsy crosslisting (coming)",
    unlimited_monthly: "No cap. For estate-sale weeks and full shops",
  };

  async function open(reason) {
    if (!plan) await refresh();
    const products = (plan && plan.products) || {};
    let pkgs = {};
    let storeReady = false;
    if (native) {
      try {
        if (await ensurePurchases()) {
          const { offerings } = await Purchases.getOfferings();
          const cur = offerings && offerings.current;
          (cur ? cur.availablePackages : []).forEach(p => { const k = String(p.product.identifier).split(":")[0]; pkgs[k] = p; });
          storeReady = Object.keys(pkgs).length > 0;
        }
      } catch (e) { console.warn("offerings", e); }
    }
    const sheet = document.createElement("div");
    sheet.className = "paywall";
    sheet.innerHTML = `
      <div class="pw-card">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <div class="big" style="font-size:1.25rem">Estimates</div>
          <button class="btn sec sm" id="pwClose">Close</button>
        </div>
        <div class="muted" style="font-size:.85rem;margin:4px 0 10px">${esc(reason || "Inventory, photos and your shop are free. Estimates are what we charge for.")}<br><b>${esc(summary())}</b></div>
        ${ORDER.map(k => {
          const p = products[k]; if (!p) return "";
          const price = pkgs[k] ? pkgs[k].product.priceString : ("$" + p.usd.toFixed(2));
          const per = p.kind === "plan" ? "/month" : "";
          return `<button class="pw-opt" data-k="${k}" ${native && !storeReady ? "disabled" : ""}>
              <div><div class="nm">${esc(p.label)}</div><div class="muted" style="font-size:.8rem">${esc(BLURB[k] || "")}</div></div>
              <div class="pr">${esc(price)}<span class="muted" style="font-size:.75rem">${per}</span></div>
            </button>`;
        }).join("")}
        ${native ? `<div style="height:6px"></div><button class="btn sec sm" id="pwRestore">Restore purchases</button>
                    ${!storeReady ? `<div class="muted" style="font-size:.78rem;margin-top:6px">Store not reachable right now. Try again in a moment.</div>` : ""}`
                 : `<div class="muted" style="font-size:.8rem;margin-top:8px">Buy estimates in the Bottle Tree Android app${plan && plan.play_url ? ` — <a href="${esc(plan.play_url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">get it on Google Play</a>` : " (Google Play, coming this week)"}. Your inventory is the same account everywhere.</div>`}
        <div class="muted" style="font-size:.7rem;margin-top:10px">Estimates are AI guesses for pricing help, not formal appraisals. Subscriptions renew monthly; cancel any time in Google Play.</div>
      </div>`;
    document.body.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelector("#pwClose").onclick = close;
    sheet.addEventListener("click", e => { if (e.target === sheet) close(); });
    sheet.querySelectorAll(".pw-opt").forEach(b => b.onclick = async () => {
      const k = b.dataset.k;
      if (!native) return;
      b.disabled = true; b.querySelector(".pr").textContent = "…";
      try {
        await Purchases.purchasePackage({ aPackage: pkgs[k] });
        // the RevenueCat webhook credits the account; poll briefly until it lands
        for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 1200)); const before = plan && plan.credits; const bp = plan && plan.plan; await refresh(); if (plan.credits !== before || plan.plan !== bp) break; }
        close(); window.dispatchEvent(new CustomEvent("bt:plan", { detail: plan }));
        if (window.toast) window.toast("Thanks — " + summary());
      } catch (e) {
        b.disabled = false; b.querySelector(".pr").textContent = pkgs[k] ? pkgs[k].product.priceString : "";
        if (!(e && (e.userCancelled || /cancel/i.test(String(e.message || e))))) { if (window.toast) window.toast("Purchase didn't go through"); console.warn(e); }
      }
    });
    const rs = sheet.querySelector("#pwRestore");
    if (rs) rs.onclick = async () => { try { await Purchases.restorePurchases(); await refresh(); if (window.toast) window.toast(summary()); } catch (e) { console.warn(e); } };
  }

  async function init() {
    await refresh();
    if (native) { try { await ensurePurchases(); } catch (e) { console.warn("rc init", e); } }
    return plan;
  }

  return { init, refresh, open, summary, get plan() { return plan; }, native };
})();
