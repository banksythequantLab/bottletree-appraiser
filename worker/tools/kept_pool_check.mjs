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
  MAX_COHERENT_SPREAD, textJson, cfg, REPRICE_SYSTEM, repricePrompt,
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
const priceVsMarket = [];
let fellBack = 0, fellBackOk = 0;
// The production PRICE_SYSTEM is not exported; this is its text, and the only copy in this file
// that is allowed to be a copy, because it is three lines and has no per-item substitutions.
const PRICE_SYSTEM_LOCAL = `You are an antiques dealer setting a retail price. You MUST answer with numbers even when unsure:
give a wide range rather than zeros. Return ONLY JSON:
{"low": 0, "high": 0, "suggested_retail": 0, "floor": 0, "currency": "USD", "basis": ""}`;
const median = ps => { const s = [...ps].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100; };

for (const q of ITEMS) {
  if (only && !q.toLowerCase().includes(only)) continue;
  const live = await ebayActive(env, q);
  if (!live || !live.length) { console.log(`${q}\n  no live pool (${ebayFailure() || "empty"})\n`); continue; }
  const rawPs = live.map(x => x.price);
  const rawR = ratio(rawPs);

  // THE production prompt, imported rather than retyped. An earlier version of this file wrote
  // its own paraphrase - "Your earlier estimate: unknown; price it from the comparables" - and
  // reported that only 6-7 of 30 calls returned a price_range. That looked like a production
  // defect and was an artifact of the paraphrase; the real prompt returned 30 of 30. A harness
  // that rewrites the prompt is measuring the harness, so it does not get to rewrite it.
  const marketLine = { count: live.length, low: Math.min(...rawPs), high: Math.max(...rawPs),
    median: median(rawPs) };
  const user = repricePrompt({
    ident: { name: q }, condition: "Very good", lotInfo: null, market: marketLine,
    hits: live.map(l => ({ title: l.title, price: l.price, url: l.url, source: "ebay" })),
  });

  console.log(q);
  console.log(`  raw  ${live.length} listings  $${Math.min(...rawPs)}-$${Math.max(...rawPs)}  ${rawR}x`);
  categories++;
  if (tooWide(Math.min(...rawPs), Math.max(...rawPs))) rawWide++;

  // The live pool is fetched once and reused for every repeat, so any difference below is the
  // repricer changing its mind, not the market moving.
  for (let i = 0; i < times; i++) {
    let kept = [], rejected = [], priced = null;
    try {
      const second = await textJson(c, REPRICE_SYSTEM, user, 1000);
      const comps = (second.comparables || []).slice(0, 4).filter(x => x && x.title);
      rejected = (second.rejected || []).filter(r => r && r.title);
      kept = keptLive(live, comps);
      // What the model priced it at, against the pool it was just shown. Nothing in the appraiser
      // currently compares these two numbers, so nobody knows what the normal relationship is.
      const midOf = pr => Number((pr || {}).suggested_retail) ||
        (Number((pr || {}).low) && Number((pr || {}).high)
          ? (Number(pr.low) + Number(pr.high)) / 2 : 0);
      let mid = midOf(second.price_range);
      // Production's cold fallback, run here too, or this measures only the easy half of the
      // runs. Priced cold, the repricer answers about 13 times in 30; the other 17 are exactly
      // the ones a dealer would otherwise get a pre-listing memory for.
      if (!(mid > 0)) {
        fellBack++;
        const coldAsk = `Item: ${q}\nCondition: Very good\nCurrency: USD\n` +
          `Live asking prices right now: ${live.length} listed, $${Math.min(...rawPs)}-` +
          `$${Math.max(...rawPs)}, median $${median(rawPs)}. Asking, not sold.\n` +
          `\nComparables:\n${JSON.stringify(live.slice(0, 8).map(l => ({ title: l.title, price: l.price })), null, 1)}\n\n` +
          `Set a dealer retail range from these listings alone.`;
        try { mid = midOf(await textJson(c, PRICE_SYSTEM_LOCAL, coldAsk, 300)); } catch { /* counted below */ }
        if (mid > 0) fellBackOk++;
      }
      if (mid > 0) priced = mid;
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
    const med = median(ps);
    byCategory.get(q).push({ key: [...ps].sort((a, b) => a - b).join(","), median: med });
    if (priced && med > 0) priceVsMarket.push({ q, priced, med, ratio: priced / med });
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

// The one relationship in the appraiser that nothing checks: what the model priced the item at,
// against the median of the very comparables it was shown a moment earlier. The melt check has a
// coherence test against the market. The price does not. Before a guard can be written, somebody
// has to know what NORMAL looks like, and nobody did.
//
// MEASURED, 2026-09-24, ten categories x three runs each, three times over.
//
//   WITH a prior seeded at 0.40x of the market median (what production used to do):
//     returned a price    30/30
//     final / median      min 0.29x   p50 0.69x   p90 1.01x   max 1.10x
//     at or above 0.70x   14/30
//   The pass anchored on the number it was handed and recovered about half the distance to the
//   listings in front of it. $140 against a $349.99 median, $200 against $492.88, $16 against
//   $39.25. One went backwards: $165 against a $562.50 median, BELOW the $225 it started from.
//   In production that prior was the first pass's own guess, formed before any listing was seen,
//   so a bad first guess survived into the final number instead of being corrected by evidence.
//
//   COLD, no prior, repricer alone:
//     returned a price    13/30      <- withholding the number also withholds the answer
//     final / median      min 0.83x   p50 1.01x   p90 1.26x   max 1.74x
//
//   COLD, with the pricing-only fallback production now runs when the repricer declines:
//     returned a price    30/30      (repricer declined 16, fallback rescued all 16)
//     final / median      min 0.72x   p50 1.01x   p90 1.15x   max 1.27x
//     at or above 0.70x   30/30
//
// Every price now sits in a tight band around the market it was priced from, and the
// $165-against-$562 shape is gone from this sample.
//
// This last set IS a distribution of healthy production runs - unseeded, production prompt, real
// listings - so unlike the seeded numbers it is a legitimate basis for a coherence threshold, if
// one is ever wanted. Thirty runs across ten categories in one day is still a thin basis for
// picking one, and none has been picked.
if (priceVsMarket.length) {
  const rs = priceVsMarket.map(x => x.ratio).sort((a, b) => a - b);
  const pct = p => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  console.log(`--- where does the price land, priced from the comps COLD? ---`);
  console.log(`no prior estimate is handed to the model; production does not pass one either.`);
  console.log(`${rs.length} of ${measured} runs ended with a price, after the cold fallback.`);
  console.log(`the repricer itself declined on ${fellBack} of them; the fallback rescued ${fellBackOk}.`);
  console.log(`final price / market median:   min ${rs[0].toFixed(2)}x   p50 ${pct(0.5).toFixed(2)}x   ` +
    `p90 ${pct(0.9).toFixed(2)}x   max ${rs[rs.length - 1].toFixed(2)}x`);
  const near = rs.filter(r => r >= 0.7).length;
  console.log(`${near}/${rs.length} landed at 0.70x of median or above`);
  console.log(`the seeded run this replaces, for comparison: p50 0.69x, 14/30 at or above 0.70x`);
  const worst = [...priceVsMarket].sort((a, b) =>
    Math.max(b.ratio, 1 / b.ratio) - Math.max(a.ratio, 1 / a.ratio)).slice(0, 5);
  console.log(`furthest from its own comparables:`);
  for (const w of worst)
    console.log(`  ${w.ratio.toFixed(2)}x  $${Math.round(w.priced)} priced against a $${w.med} median   ${w.q.slice(0, 40)}`);
  console.log(`A number well above 1x is expected and healthy: these are ASKING prices and the`);
  console.log(`model is setting dealer retail. What a guard would be for is the far tail - a`);
  console.log(`price with no visible relationship to the pool it was priced from.\n`);
}

console.log(`--- ${categories} categories, ${measured} repricer runs, threshold ${MAX_COHERENT_SPREAD}x ---`);
console.log(`raw pools wider than ${MAX_COHERENT_SPREAD}x:  ${rawWide}/${categories} categories`);
console.log(`kept pools that WARN:       ${keptWide}/${measured} runs`);
console.log(`If the kept number is most of them, the warning is noise and the threshold should`);
console.log(`rise or the check should go. If it is a few, it is doing what it was written to do.`);
