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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
