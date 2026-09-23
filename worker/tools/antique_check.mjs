// Manual verification harness. NOT part of the test suite — it hits the live eBay Browse API,
// costs real calls, and its numbers move as the market moves.
//
//   node worker/tools/antique_check.mjs
//
// Reads EBAY_CLIENT_ID / EBAY_CLIENT_SECRET from worker/.dev.vars (gitignored) or the
// environment. Never prints them. Runs ten real antique identifications through the worker's
// own query path — cleanForEbay, broaden, contradictsGeneration, contradictsSpec — and reports
// what survives, so a change to any of those filters can be checked against live listings
// before it ships.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ebayActive, ebayFailure, ebayBroadenedTo } from "../appraiser.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(here, "..", ".dev.vars"), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* environment only */ }
  return env;
}

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

const med = ps => {
  const s = [...ps].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const env = loadEnv();
if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
  console.error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.");
  console.error("Put the PRODUCTION pair in worker/.dev.vars (gitignored):");
  console.error("  EBAY_CLIENT_ID=...");
  console.error("  EBAY_CLIENT_SECRET=...");
  console.error("A sandbox App ID (SBX-...) authenticates but returns test inventory.");
  process.exit(2);
}
if (/^SBX-/i.test(env.EBAY_CLIENT_ID)) {
  console.error("That is a sandbox App ID. Browse answers with synthetic listings, not real");
  console.error("ones, so the medians below would be meaningless. Use the production pair.");
  process.exit(2);
}

for (const q of ITEMS) {
  const out = await ebayActive(env, q);
  const why = ebayFailure();
  if (!out) { console.log(`${q}\n  FAILED - ${why}\n`); continue; }
  if (!out.length) { console.log(`${q}\n  no comps survived the filters\n`); continue; }
  const ps = out.map(x => x.price);
  const b = ebayBroadenedTo();
  console.log(q);
  console.log(`  kept ${ps.length}  $${Math.min(...ps)}-$${Math.max(...ps)}  median $${med(ps)}${b ? `  [broadened to "${b}"]` : ""}`);
  for (const x of out.slice(0, 3)) console.log(`    $${x.price}  ${x.title.slice(0, 72)}`);
  console.log();
}
