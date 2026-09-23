// Run:  node worker/tests/dedupe_test.mjs
// Collapsing one seller's repeat listings of the same thing. Every case is from a live pool.
import { dedupeOffers } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};
const L = (price, title, seller, url) => ({ price, title, seller, url });
const prices = ls => ls.map(l => l.price).sort((a, b) => a - b);

// Live, 2026-09-23: one seller, one roll of war nickels, listed twice under an identical title.
const NICKELS = [
  L(124.95, "WWII War Nickels – Full Roll (40 Coins) – 35% Silver – ~2.25 Troy Oz ASW", "coinguy", "u1"),
  L(134.99, "WWII War Nickels – Full Roll (40 Coins) – 35% Silver – ~2.25 Troy Oz ASW", "coinguy", "u2"),
  L(130, "Roll of Silver War Nickels with Dates 40 Coins Circulated", "otherseller", "u3"),
];
eq("one seller's repeat collapses", dedupeOffers(NICKELS).length, 2);
eq("and the cheaper one survives", prices(dedupeOffers(NICKELS)), [124.95, 130]);

// Two DIFFERENT sellers with the same title are two real offers. Collapsing them would
// understate the market, which is worse than miscounting it.
eq("different sellers are not duplicates", dedupeOffers([
  L(289, "2023 S PROOF SILVER EAGLE LIMITED EDITION SET", "a", "u1"),
  L(300, "2023 S PROOF SILVER EAGLE LIMITED EDITION SET", "b", "u2"),
]).length, 2);

// The Silver Eagle trio: same seller, titles differing only in their tail.
eq("near-identical titles from one seller collapse", dedupeOffers([
  L(289, "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC IN OGP", "mint", "u1"),
  L(280, "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC IN OGP BOX", "mint", "u2"),
  L(300, "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC", "mint", "u3"),
]).length, 1);
// Same seller, genuinely different items, must both survive.
eq("one seller's different items both stay", dedupeOffers([
  L(130, "Roll of 40 War Nickels 1942-1945", "coinguy", "u1"),
  L(730, "LOT OF 4 FULL ROLLS SILVER WAR NICKELS", "coinguy", "u2"),
]).length, 2);

// Case and spacing are not differences.
eq("case and spacing ignored", dedupeOffers([
  L(130, "Roll of 40 War Nickels", "s", "u1"),
  L(140, "  ROLL  OF 40   WAR NICKELS ", "s", "u2"),
]).length, 1);

// A missing seller means we cannot tell a duplicate from a coincidence, so nothing is collapsed.
eq("no seller, no collapsing", dedupeOffers([
  L(130, "Roll of 40 War Nickels", "", "u1"),
  L(140, "Roll of 40 War Nickels", "", "u2"),
]).length, 2);

eq("empty", dedupeOffers([]), []);
eq("null", dedupeOffers(null), []);
eq("single", dedupeOffers([L(130, "x", "s", "u")]).length, 1);
// Order of the survivors follows first appearance, so the pool stays in relevance order.
eq("keeps relevance order", dedupeOffers(NICKELS).map(l => l.url), ["u1", "u3"]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
