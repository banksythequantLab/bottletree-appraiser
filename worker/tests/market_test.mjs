// Run:  node worker/tests/market_test.mjs
// Matching the model's kept comparables back to the live eBay listings, so the market headline
// can be rebuilt from the listings the price actually rests on.
import { keptLive } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};
const L = (price, title, url) => ({ price, title, url });
const prices = ls => ls.map(l => l.price);

// The production run: 12 war-nickel listings, the model kept the one that was actually 4 rolls.
const LIVE = [
  L(730, "LOT OF 4 FULL ROLLS SILVER WAR NICKELS 35% SILVER 1942-45 MIX DATES", "https://ebay.com/a"),
  L(159, "WWII War Nickels - Full Roll (40 Coins) - 35% Silver", "https://ebay.com/b"),
  L(90, "Silver War Nickels Half Roll, 20 Coins, 35% Silver", "https://ebay.com/c"),
];
eq("matches on url", prices(keptLive(LIVE, [{ title: "anything", url: "https://ebay.com/a" }])), [730]);
eq("matches on exact title", prices(keptLive(LIVE,
  [{ title: "LOT OF 4 FULL ROLLS SILVER WAR NICKELS 35% SILVER 1942-45 MIX DATES" }])), [730]);
// Models tidy titles. A truncated one still has to match.
eq("matches a truncated title", prices(keptLive(LIVE,
  [{ title: "LOT OF 4 FULL ROLLS SILVER WAR NICKELS" }])), [730]);
eq("matches despite case and spacing", prices(keptLive(LIVE,
  [{ title: "  lot of 4 full rolls silver war nickels 35% silver  " }])), [730]);
eq("several kept", prices(keptLive(LIVE,
  [{ url: "https://ebay.com/a" }, { url: "https://ebay.com/c" }])), [730, 90]);

// A comparable the model invented or took from a search hit must not match a live listing.
eq("unrelated title matches nothing", keptLive(LIVE, [{ title: "Griswold No 8 Cast Iron Skillet" }]), []);
eq("no comparables", keptLive(LIVE, []), []);
eq("no live listings", keptLive([], [{ url: "https://ebay.com/a" }]), []);
eq("null inputs", keptLive(null, null), []);
// A short title must not match everything by prefix.
eq("short title is not a wildcard", keptLive(LIVE, [{ title: "LOT" }]), []);

// Production, 2026-09-23: three near-identical Silver Eagle listings, the model kept one and
// called the other two "Duplicate listing of same item". One kept comparable must not claim all
// three, or the market line reads "3 comparables listed" for one thing listed three times.
const DUPES = [
  L(289, "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC IN OGP", "https://ebay.com/d1"),
  L(280, "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC IN OGP BOX", "https://ebay.com/d2"),
  L(300, "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC", "https://ebay.com/d3"),
];
eq("one comparable claims one listing",
  prices(keptLive(DUPES, [{ title: "2023 S PROOF SILVER EAGLE LIMITED EDITION PROOF SET 23RC IN OGP" }])), [289]);
eq("two comparables claim two listings",
  keptLive(DUPES, [{ url: "https://ebay.com/d1" }, { url: "https://ebay.com/d3" }]).length, 2);
eq("a comparable matching nothing claims nothing",
  keptLive(DUPES, [{ title: "Griswold No 8 Cast Iron Skillet Large Block Logo" }]), []);
// A short comparable title must not reach the prefix rule at all.
eq("short title cannot claim by prefix", keptLive(DUPES, [{ title: "2023 SILVER" }]), []);
eq("order follows the live listings, not the comparables",
  prices(keptLive(DUPES, [{ url: "https://ebay.com/d3" }, { url: "https://ebay.com/d1" }])), [289, 300]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
