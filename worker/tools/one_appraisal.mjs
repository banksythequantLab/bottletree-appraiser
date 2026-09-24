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

const [url, description, markings = ""] = process.argv.slice(2);
if (!url || !description) {
  console.error('Usage: node worker/tools/one_appraisal.mjs "<photo url>" "<dealer description>" ["<markings>"]');
  process.exit(2);
}

const env = loadEnv();
const r = await appraise(env, {
  photos: [{ url, kind: "front" }],
  description,
  markings,
  currency: "USD",
});

const money = p => p ? `$${p.low}-$${p.high} (suggested $${p.suggested_retail}, floor $${p.floor})` : "none";
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
