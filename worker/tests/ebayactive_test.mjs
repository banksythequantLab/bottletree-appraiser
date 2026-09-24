// Run:  node worker/tests/ebayactive_test.mjs
// Drives the real ebayActive loop against a stubbed fetch, so the broadening warning and the
// filter's effect on it are tested rather than assumed.
import { ebayActive, ebayBroadenedTo, ebayFailure } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};

const ENV = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret" };
const item = (title, value) => ({ title, itemWebUrl: "https://ebay.com/x", price: { value: String(value), currency: "USD" }, condition: "Used" });

// `byQuery` maps the q sent to eBay -> the itemSummaries to answer with. Anything not listed
// answers empty, which is what makes the loop broaden.
let asked = [];
function stub(byQuery) {
  asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url && url.url ? url.url : url);
    if (u.includes("/identity/v1/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 7200 }) };
    }
    const q = new URL(u).searchParams.get("q");
    asked.push(q);
    return { ok: true, status: 200, json: async () => ({ itemSummaries: byQuery[q] || [] }) };
  };
}
const realFetch = globalThis.fetch;

// 1. Normalisation is not broadening. cleanForEbay turns "Griswold No. 8 skillet, circa 1920"
// into "Griswold No 8 skillet 1920"; that first attempt must NOT warn the dealer.
{
  const Q = "Griswold No. 8 skillet, circa 1920";
  stub({ "Griswold No 8 skillet 1920": [item("Griswold No 8 Cast Iron Skillet Large Block Logo", 121)] });
  const out = await ebayActive(ENV, Q);
  eq("normalised query returns results", out.length, 1);
  eq("normalisation does not warn", ebayBroadenedTo(), null);
  eq("only one search needed", asked.length, 1);
}

// 2. Real broadening does warn.
{
  const Q = "Griswold No. 8 skillet, circa 1920";
  stub({ "Griswold No 8 skillet": [item("Griswold No 8 Cast Iron Skillet", 110)] });
  const out = await ebayActive(ENV, Q);
  eq("broadened query returns results", out.length, 1);
  eq("broadening warns with the query used", ebayBroadenedTo(), "Griswold No 8 skillet");
}

// 3. A result set the filter empties must broaden rather than report nothing — and must warn,
// because the prices that come back are for a looser query.
{
  const Q = "Red Wing 5 gallon salt glaze crock";
  stub({
    "Red Wing 5 gallon salt glaze crock": [item("Red Wing 3 Gallon Salt Glaze Crock", 30)],
    "Red Wing 5 gallon": [item("Red Wing Salt Glaze Crock Antique", 200)],
  });
  const out = await ebayActive(ENV, Q);
  eq("filtered-out set broadens", out.map(x => x.price), [200]);
  eq("and warns", ebayBroadenedTo(), "Red Wing 5 gallon");
}

// 4. Everything filtered out at every width returns empty, not junk, and does not warn about
// a query whose results were all rejected.
{
  const Q = "Red Wing 5 gallon salt glaze crock";
  stub({
    "Red Wing 5 gallon salt glaze crock": [item("Red Wing 3 Gallon Crock", 30)],
    "Red Wing 5 gallon": [item("Reproduction Red Wing Crock", 25)],
    "Red Wing 5": [item("Lid for Red Wing Crock", 12)],
  });
  const out = await ebayActive(ENV, Q);
  eq("no comps survive", out.length, 0);
  eq("no false broadening warning", ebayBroadenedTo(), null);
  eq("no failure reported either", ebayFailure(), null);
}

// 5. Missing keys are reported, not swallowed.
{
  const out = await ebayActive({}, "anything");
  eq("no keys returns null", out, null);
  eq("no keys explained", ebayFailure(), "no eBay API keys are configured");
}

globalThis.fetch = realFetch;
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
