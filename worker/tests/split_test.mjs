// Run:  node worker/tests/split_test.mjs
// Telling a pool that is wide because it is incoherent from a pool that is wide because the
// search terms cover two different markets. Prices below are from live eBay pools.
import { splitByPrice, tooWide, MAX_COHERENT_SPREAD } from "../appraiser.js";

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

// ---- tooWide, the backstop for exactly that miss ----
// The pool splitByPrice cannot split is still 6.1x wide, and the dealer still needs telling.
eq("the pool that hides from splitByPrice does not hide from tooWide", tooWide(200, 1225), true);
eq("threshold is shared with the Tavily path", MAX_COHERENT_SPREAD, 6);
eq("exactly 6x is not too wide", tooWide(100, 600), false);
eq("a hair over 6x is", tooWide(100, 600.01), true);
// Real pools from the live sweep of 2026-09-24. Five of the ten RAW eBay pools clear 6x, which
// looked like a warning that would fire on half of all appraisals. It is not, and the numbers
// below are raw because that is the scary case; tooWide runs on the KEPT pool.
//
// MEASURED, same day, with tools/kept_pool_check.mjs driving the real repricer over the same ten
// live queries: raw pools over 6x, 5/10. Kept pools that warn, 0/10. The repricer collapses
// every wide pool on its own and names why - "Pumpkin orange colorway, a rare variant not
// comparable to standard turquoise/white Butterprint" takes Pyrex from 20.42x raw to 2.25x kept;
// "Bee Sting #5 butter churn crock, a different functional form" takes Red Wing 6.2x to 3.27x;
// "Iced tea spoon, longer than a teaspoon" takes Towle 4.72x to 1.64x. The widest kept pool of
// the ten was 4.1x.
//
// So tooWide is a backstop that did not fire once on a healthy pipeline, which is what a backstop
// should look like and is also zero evidence that it ever fires in production. It earns its place
// only when the repricer returns nothing usable or keeps junk, and that case has not been
// observed. Do not read these passing tests as proof the warning works in the field.
eq("Griswold skillets", tooWide(59.99, 224.99), false);
eq("Zenith radios", tooWide(39, 160), false);
eq("Featherweights after the parts fix", tooWide(219.95, 599), false);
// These two do warn, and should. I asserted false on the crocks first and the test caught me.
// The live pool runs from a $125 "Primitive Bee Sting #5 Stoneware Butter Churn ~ Early Red
// Wing" to a $775 "5 Gallon Salt Glaze Crock - Leaf Decorated - Red Wing". Decorated stoneware
// against plain is the same two-market shape as Butterprint blue against Pumpkin, so 6.2x is
// the warning doing its job rather than a false positive.
eq("Red Wing crocks, 6.2x, decorated against plain", tooWide(125, 775), true);
eq("Roseville, 7.3x, warns", tooWide(24, 175), true);
// Degenerate inputs must not warn.
eq("no low", tooWide(0, 500), false);
eq("no high", tooWide(100, 0), false);
eq("undefined", tooWide(undefined, undefined), false);
eq("a single listing is not a spread", tooWide(300, 300), false);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
