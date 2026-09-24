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
//
// MEASURED, 2026-09-24, ten categories x four runs each, every pool fetched once and reused:
//
//   tooWide fired on          0/40 runs   (5/10 RAW pools are over 6x)
//   identical kept sets       13/40 runs  - only Red Wing picked the same four every time
//   median price swing        1.00x to 1.26x, worst case the Featherweight at $425 vs $535
//
// That second and third line together are the finding, and they point the opposite way to what
// "the repricer is unstable" suggested. The model swaps which four equivalent listings it keeps
// on nearly every run, and lands on almost the same market anyway. A 1.1x-1.26x band is smaller
// than the asking-versus-sold gap this tool is already honest about.
//
// So paying N times over for self-consistency HERE buys close to nothing. The 3.3x swings - the
// same photograph priced at $260 and at $850 - live in the IDENTIFICATION, not in the comparable
// choice. That is where the money goes if it goes anywhere.
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

// Optional substring filter, so one suspicious category can be re-run on its own with its kept
// titles shown:   node worker/tools/kept_pool_check.mjs zenith
// Optional repeat count, to measure how stable the repricer's choice is across runs against one
// unchanging live pool:   node worker/tools/kept_pool_check.mjs zenith 5
// "all" means every category, and is how you ask for a repeat count without a filter:
//   node worker/tools/kept_pool_check.mjs all 4
const arg2 = (process.argv[2] || "").toLowerCase();
const only = (arg2 === "all" || arg2 === "-") ? "" : arg2;
const times = Math.max(1, parseInt(process.argv[3], 10) || 1);

const env = loadEnv();
for (const [k, hint] of [["EBAY_CLIENT_ID", "production eBay pair"], ["EBAY_CLIENT_SECRET", "production eBay pair"], ["NEBIUS_API_KEY", "Nebius key"]]) {
  if (!env[k]) { console.error(`Missing ${k} - put the ${hint} in worker/.dev.vars (gitignored).`); process.exit(2); }
}
if (/^SBX-/i.test(env.EBAY_CLIENT_ID)) {
  console.error("That is a sandbox App ID; Browse would answer with synthetic listings.");
  process.exit(2);
}

const c = cfg(env);
let rawWide = 0, keptWide = 0, measured = 0, categories = 0;
const byCategory = new Map();
const median = ps => { const s = [...ps].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100; };

for (const q of ITEMS) {
  if (only && !q.toLowerCase().includes(only)) continue;
  const live = await ebayActive(env, q);
  if (!live || !live.length) { console.log(`${q}\n  no live pool (${ebayFailure() || "empty"})\n`); continue; }
  const rawPs = live.map(x => x.price);
  const rawR = ratio(rawPs);

  // The production repricer prompt, minus the identification preamble the model does not need
  // when the query IS the identification.
  const user = `Item: ${q}\nYour earlier estimate: unknown; price it from the comparables.\n` +
    `\nComparables:\n${JSON.stringify(live.map(l => ({ title: l.title, price: l.price, url: l.url, source: "ebay" })), null, 1)}`;

  console.log(q);
  console.log(`  raw  ${live.length} listings  $${Math.min(...rawPs)}-$${Math.max(...rawPs)}  ${rawR}x`);
  categories++;
  if (tooWide(Math.min(...rawPs), Math.max(...rawPs))) rawWide++;

  // The live pool is fetched once and reused for every repeat, so any difference below is the
  // repricer changing its mind, not the market moving.
  for (let i = 0; i < times; i++) {
    let kept = [], rejected = [];
    try {
      const second = await textJson(c, REPRICE_SYSTEM, user, 1000);
      const comps = (second.comparables || []).slice(0, 4).filter(x => x && x.title);
      rejected = (second.rejected || []).filter(r => r && r.title);
      kept = keptLive(live, comps);
    } catch (e) { console.log(`  run ${i + 1}: repricer failed: ${e.message}`); continue; }

    measured++;
    const tag = times > 1 ? `  run ${i + 1}: ` : "  ";
    if (!kept.length) {
      console.log(`${tag}kept 0 of ${live.length} (all ${rejected.length} rejected) - no pool, so ` +
        `tooWide cannot fire; the "different items" warning covers this`);
      continue;
    }
    const ps = kept.map(x => x.price);
    const warns = tooWide(Math.min(...ps), Math.max(...ps));
    if (warns) keptWide++;
    // The kept set's identity, for counting how often the model picks the same four.
    if (!byCategory.has(q)) byCategory.set(q, []);
    byCategory.get(q).push({ key: [...ps].sort((a, b) => a - b).join(","), median: median(ps) });
    console.log(`${tag}kept ${ps.length} listings  $${Math.min(...ps)}-$${Math.max(...ps)}  ${ratio(ps)}x` +
      `${warns ? "   <<< tooWide WARNS" : ""}${splitByPrice(kept) ? "   [splitByPrice fires]" : ""}`);
    // With a filter argument, print what was KEPT as well. A spread number cannot tell you
    // whether a warning is right; only the titles can.
    if (only) for (const x of kept) console.log(`      kept:    $${x.price}  ${String(x.title).slice(0, 76)}`);
    if (only && times === 1) for (const x of rejected) console.log(`      dropped: ${String(x.why).slice(0, 84)}`);
    else if (!only) for (const x of rejected.slice(0, 3)) console.log(`      dropped: ${String(x.why).slice(0, 84)}`);
  }
  console.log();
}

// How much the repricer's choice moves when nothing else does. Each category's live pool is
// fetched once, so every difference between runs of the same category is the model changing its
// mind on identical input. The median is what a dealer would be quoted; the spread between the
// lowest and highest median across runs is the size of the coin-flip they are subject to.
if (times > 1) {
  console.log(`--- run-to-run variance on an unchanging pool ---`);
  console.log(`category                        distinct kept sets   median low-high   swing`);
  for (const [q, rows] of byCategory) {
    if (!rows.length) continue;
    const sets = new Set(rows.map(r => r.key));
    const meds = rows.map(r => r.median).sort((a, b) => a - b);
    const lo = meds[0], hi = meds[meds.length - 1];
    console.log(`${q.slice(0, 30).padEnd(30)}  ${String(sets.size + "/" + rows.length).padEnd(18)}   ` +
      `$${lo}-$${hi}`.padEnd(16) + `  ${lo > 0 ? Math.round((hi / lo) * 100) / 100 + "x" : "-"}`);
  }
  console.log();
}

console.log(`--- ${categories} categories, ${measured} repricer runs, threshold ${MAX_COHERENT_SPREAD}x ---`);
console.log(`raw pools wider than ${MAX_COHERENT_SPREAD}x:  ${rawWide}/${categories} categories`);
console.log(`kept pools that WARN:       ${keptWide}/${measured} runs`);
console.log(`If the kept number is most of them, the warning is noise and the threshold should`);
console.log(`rise or the check should go. If it is a few, it is doing what it was written to do.`);
