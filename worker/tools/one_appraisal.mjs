// Manual harness. NOT part of the test suite - it spends real Nebius tokens and real eBay calls.
//
//   node worker/tools/one_appraisal.mjs "<photo url>" "<dealer description>" ["<markings>"]
//
// Runs the production appraise() against one photograph and one line of dealer text, and prints
// what a dealer would actually be shown: the identification, the confidence, the price, the
// comparables kept and rejected, the melt check, the lot maths, every warning, and any
// clarification the model asks for. The worker's own /appraise route wraps this same call; this
// skips the account, the item record and the credit, so a photo can be put through the real
// pipeline without creating a sale.
import { appraise } from "../appraiser.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
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

// A repeat count turns this into an identification-stability measurement. The photograph and the
// dealer's line are identical every time, so any difference is the pipeline changing its mind.
// This is the expensive half of the appraiser - vision, reasoner, eBay, melt, repricer - so N
// runs cost N appraisals, which is exactly the number the self-consistency decision turns on.
const [url, description, markings = "", timesArg] = process.argv.slice(2);
const times = Math.max(1, parseInt(timesArg, 10) || 1);
if (!url || !description) {
  console.error('Usage: node worker/tools/one_appraisal.mjs "<photo url>" "<dealer description>" ["<markings>"] [runs]');
  process.exit(2);
}

const env = loadEnv();
const money = p => p ? `$${p.low}-$${p.high} (suggested $${p.suggested_retail}, floor $${p.floor})` : "none";
const runs = [];

for (let i = 0; i < times; i++) {
  if (times > 1) console.log(`\n=================== run ${i + 1} of ${times} ===================`);
  const r = await appraise(env, {
    photos: [{ url, kind: "front" }],
    description,
    markings,
    currency: "USD",
  });
  runs.push(r);
  report(r);
}

if (times > 1) summarise(runs);

function summarise(rs) {
  console.log(`\n=================== identification stability ===================`);
  const names = rs.map(r => (r.identification || {}).name || "(none)");
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  console.log(`${ranked.length} distinct identification${ranked.length === 1 ? "" : "s"} in ${rs.length} runs:`);
  for (const [n, c] of ranked) console.log(`  ${String(c).padStart(2)}x  ${n}`);
  // Majority vote is the cheapest possible self-consistency: run N, keep the answer that recurs.
  // It is only worth paying for if the modal answer is (a) a majority and (b) the right one.
  const [topName, topCount] = ranked[0];
  console.log(`\nmodal answer wins ${topCount}/${rs.length}` +
    `${topCount > rs.length / 2 ? " - a majority, so a vote of N would settle on it" :
      " - NOT a majority, so a vote of N would be settling a tie by luck"}`);

  const confs = rs.map(r => r.confidence).filter(x => typeof x === "number");
  if (confs.length) console.log(`confidence   ${Math.min(...confs)} to ${Math.max(...confs)}`);
  const lows = rs.map(r => r.price_range && r.price_range.low).filter(x => x > 0);
  const highs = rs.map(r => r.price_range && r.price_range.high).filter(x => x > 0);
  const sugg = rs.map(r => r.price_range && r.price_range.suggested_retail).filter(x => x > 0);
  if (sugg.length) {
    const lo = Math.min(...sugg), hi = Math.max(...sugg);
    console.log(`suggested    $${lo} to $${hi}   swing ${Math.round((hi / lo) * 100) / 100}x`);
  }
  if (lows.length && highs.length)
    console.log(`band         $${Math.min(...lows)}-$${Math.max(...highs)} across all runs`);
  console.log(`\nThe price swing above is what a dealer is actually exposed to. Compare it with the`);
  console.log(`repricer's 1.00x-1.26x (tools/kept_pool_check.mjs) before deciding where N-way`);
  console.log(`sampling is worth paying for.`);
}

function report(r) {
const id = r.identification || {};
console.log(`\nIDENT    ${id.name || "(none)"}`);
console.log(`         ${[id.maker, id.period, id.category].filter(Boolean).join("  |  ")}`);
console.log(`CONF     ${r.confidence}`);
console.log(`PRICE    ${money(r.price_range)}`);
if (r.price_range && r.price_range.basis) console.log(`BASIS    ${r.price_range.basis}`);
if (r.melt) console.log(`MELT     ${JSON.stringify(r.melt)}`);
if (r.lot) console.log(`LOT      ${JSON.stringify(r.lot)}`);
if (r.market) console.log(`MARKET   ${JSON.stringify(r.market)}`);
for (const e of r.evidence || []) console.log(`EVIDENCE ${e}`);
for (const t of r.transcribed_text || []) console.log(`TEXT     ${t}`);
for (const c of r.comparables || []) console.log(`COMP     $${c.price}  ${String(c.title).slice(0, 80)}`);
for (const x of r.rejected_comparables || []) console.log(`REJECT   ${String(x.why).slice(0, 90)}`);
for (const q of r.dealer_questions || []) console.log(`ASK      ${q.q}   ${JSON.stringify(q.options)}`);
if (r.needs_clarification) console.log(`CLARIFY  ${JSON.stringify(r.needs_clarification)}`);
for (const w of r.warnings || []) console.log(`WARN     ${w}`);
}
