// Run:  node worker/tests/split_test.mjs
// Telling a pool that is wide because it is incoherent from a pool that is wide because the
// search terms cover two different markets. Prices below are from live eBay pools.
import { splitByPrice } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};
const P = ns => ns.map(price => ({ price }));
const of = s => s ? { lower: s.lower.map(l => l.price), upper: s.upper.map(l => l.price), ratio: s.ratio } : null;

// "Pyrex Butterprint Cinderella mixing bowl set", live: blue sets around $250, and Pumpkin and
// Yellow colourways at four times that, sharing every search term.
const PYREX = P([125, 201, 210, 220, 285, 299, 300, 300, 999, 1115]);
eq("Pyrex splits into two markets", of(splitByPrice(PYREX)), {
  lower: [125, 201, 210, 220, 285, 299, 300, 300], upper: [999, 1115], ratio: 3.33 });

// A tight pool is one market, however many listings it has.
eq("war nickel rolls are one market", splitByPrice(P([124.95, 130, 134.99, 135, 145, 169])), null);
eq("Griswold skillets are one market", splitByPrice(P([89.99, 105.99, 115, 127, 165, 225])), null);

// A single dear item across a gap is an outlier, not a second market. Splitting on one listing
// would invent a market from a typo or a gold-plated one-off.
eq("one item across the gap is not a market", splitByPrice(P([100, 110, 120, 130, 900])), null);
eq("one cheap item across the gap either", splitByPrice(P([20, 900, 950, 1000, 1100])), null);

// Both sides need two, and the gap needs to be a real one.
eq("two and two is enough", of(splitByPrice(P([100, 110, 900, 950]))),
  { lower: [100, 110], upper: [900, 950], ratio: 8.18 });
eq("a gentle gap is not a boundary", splitByPrice(P([100, 110, 180, 200])), null);
eq("threshold is configurable", of(splitByPrice(P([100, 110, 180, 200]), 1.5)),
  { lower: [100, 110], upper: [180, 200], ratio: 1.64 });

// Not enough to say anything.
eq("three listings is too few", splitByPrice(P([100, 110, 900])), null);
eq("empty", splitByPrice([]), null);
eq("null", splitByPrice(null), null);
eq("zero and negative prices are dropped", splitByPrice(P([0, -5, 100, 110, 900, 950])).lower.length, 2);
// Unsorted input must give the same answer as sorted.
eq("order does not matter", of(splitByPrice(P([1115, 125, 300, 999, 201, 285, 210, 300, 220, 299]))),
  of(splitByPrice(PYREX)));

// The live Pyrex pool on 2026-09-24, with a $450 listing sitting in what used to be a clean
// gap. This is the case the function was written for and it now misses it: 1115/450 = 2.48,
// under the 2.5 threshold. Pinned as a test so the limit is visible rather than forgotten, and
// so that whoever replaces this with title-based grouping has the failing case in front of them.
eq("a bridging listing hides a real two-market pool",
  splitByPrice(P([200, 200, 210, 285, 285, 299, 300, 300, 450, 1114.99, 1225])), null);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
