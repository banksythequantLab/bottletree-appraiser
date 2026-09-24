// Manual measurement harness. NOT part of the test suite - it hits the live eBay Browse API AND
// spends real Nebius tokens on the repricer.
//
//   node worker/tools/kept_pool_check.mjs
//
// WHY THIS EXISTS. tooWide() warns when the comp pool spans more than 6x. Five of the ten RAW
// eBay pools in the 2026-09-24 sweep clear 6x, which would be a warning firing on half of all
// appraisals - worth nothing. But tooWide does not run on the raw pool. It runs on the KEPT
// pool: what survives the repricer, which throws out the Riviera plate and the rare Pumpkin
// colorway that make raw pools wide in the first place. Nobody had measured the kept pool.
// Guessing the threshold from the raw number would have been fitting a sample.
//
// So this drives the real repricer - same REPRICE_SYSTEM, same model, same live listings as a
// production appraisal - over the same ten queries, and reports the spread of what it keeps.
// No photographs needed, because the repricer never sees one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ebayActive, ebayFailure, keptLive, splitByPrice, tooWide,
  MAX_COHERENT_SPREAD, textJson, cfg, REPRICE_SYSTEM,
} from "../appraiser.js";

const here = dirname(fileURLToPath(import.meta.url));

// The eBay pair lives in worker/.dev.vars and the Nebius key in service/.env. Both are
// gitignored and neither is ever printed. Reading both beats copying a secret into a third file.
function loadEnv() {
  const env = { ...process.env };
  for (const f of [join(here, "..", ".dev.vars"), join(here, "..", "..", "service", ".env")]) {
    try {
      for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch { /* optional */ }
  }
  return env;
}

// The same ten as antique_check.mjs, deliberately: the raw numbers are already on record, so the
// kept numbers below are directly comparable to them.
const ITEMS = [
  "Red Wing 5 gallon salt glaze stoneware crock",
  "Roseville Freesia blue vase circa 1945",
  "Griswold No. 8 cast iron skillet large block logo",
  "Fiesta radioactive red dinner plate",
  "Pyrex Butterprint Cinderella mixing bowl set",
  "Singer Featherweight 221 sewing machine",
  "Zenith Bakelite tube radio",
  "Towle Old Master sterling teaspoon",
  "1964 Kennedy half dollar roll of 20",
  "Hull Little Red Riding Hood cookie jar",
];

const ratio = ps => Math.round((Math.max(...ps) / Math.min(...ps)) * 100) / 100;

const env = loadEnv();
for (const [k, hint] of [["EBAY_CLIENT_ID", "production eBay pair"], ["EBAY_CLIENT_SECRET", "production eBay pair"], ["NEBIUS_API_KEY", "Nebius key"]]) {
  if (!env[k]) { console.error(`Missing ${k} - put the ${hint} in worker/.dev.vars (gitignored).`); process.exit(2); }
}
if (/^SBX-/i.test(env.EBAY_CLIENT_ID)) {
  console.error("That is a sandbox App ID; Browse would answer with synthetic listings.");
  process.exit(2);
}

const c = cfg(env);
let rawWide = 0, keptWide = 0, measured = 0;

for (const q of ITEMS) {
  const live = await ebayActive(env, q);
  if (!live || !live.length) { console.log(`${q}\n  no live pool (${ebayFailure() || "empty"})\n`); continue; }
  const rawPs = live.map(x => x.price);
  const rawR = ratio(rawPs);

  // The production repricer prompt, minus the identification preamble the model does not need
  // when the query IS the identification.
  const user = `Item: ${q}\nYour earlier estimate: unknown; price it from the comparables.\n` +
    `\nComparables:\n${JSON.stringify(live.map(l => ({ title: l.title, price: l.price, url: l.url, source: "ebay" })), null, 1)}`;

  let kept = [], rejected = [];
  try {
    const second = await textJson(c, REPRICE_SYSTEM, user, 1000);
    const comps = (second.comparables || []).slice(0, 4).filter(x => x && x.title);
    rejected = (second.rejected || []).filter(r => r && r.title);
    kept = keptLive(live, comps);
  } catch (e) {
    console.log(`${q}\n  repricer failed: ${e.message}\n`);
    continue;
  }

  measured++;
  if (tooWide(Math.min(...rawPs), Math.max(...rawPs))) rawWide++;

  if (!kept.length) {
    console.log(`${q}\n  raw ${live.length} @ ${rawR}x  ->  kept 0 (all ${rejected.length} rejected)`);
    console.log(`  no kept pool, so tooWide cannot fire - the "different items" warning covers this\n`);
    continue;
  }
  const ps = kept.map(x => x.price);
  const r = ratio(ps);
  const warns = tooWide(Math.min(...ps), Math.max(...ps));
  if (warns) keptWide++;
  console.log(q);
  console.log(`  raw  ${live.length} listings  $${Math.min(...rawPs)}-$${Math.max(...rawPs)}  ${rawR}x`);
  console.log(`  kept ${ps.length} listings  $${Math.min(...ps)}-$${Math.max(...ps)}  ${r}x` +
    `${warns ? "   <<< tooWide WARNS" : ""}${splitByPrice(kept) ? "   [splitByPrice also fires]" : ""}`);
  for (const x of rejected.slice(0, 3)) console.log(`    dropped: ${String(x.why).slice(0, 88)}`);
  console.log();
}

console.log(`--- over ${measured} measured categories, threshold ${MAX_COHERENT_SPREAD}x ---`);
console.log(`raw pools wider than ${MAX_COHERENT_SPREAD}x:  ${rawWide}/${measured}`);
console.log(`kept pools that WARN:       ${keptWide}/${measured}`);
console.log(`If the kept number is most of them, the warning is noise and the threshold should`);
console.log(`rise or the check should go. If it is a few, it is doing what it was written to do.`);
