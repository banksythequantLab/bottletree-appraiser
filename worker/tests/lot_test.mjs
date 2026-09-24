// Lot detection tests.  Run:  node worker/tests/lot_test.mjs
import { detectLot } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};
const n = (d, m) => { const r = detectLot(d, m); return r ? r.count : null; };

// The case this was built for: the dealer never typed the number 8.
eq("total over unit capacity", n("256 gb total", "32gb 2rx4 c424trb111"), 8);
eq("terabyte total", n("2 tb total", "256gb"), 8);
eq("total in markings instead", n("server pull", "512gb total, 64gb per stick"), 8);

// Counts a dealer actually writes on a tag.
eq("times notation", n("8x 32gb sticks", ""), 8);
eq("lot of", n("Lot of 12 sterling teaspoons", ""), 12);
eq("set of", n("set of 6 pressed glass tumblers", ""), 6);
eq("roll of", n("roll of 20 Kennedy half dollars", ""), 20);
eq("box of", n("box of 40 records", ""), 40);
eq("qty", n("qty: 24", ""), 24);
eq("bare pcs", n("24 pcs flatware", ""), 24);
eq("pair", n("pair of brass candlesticks", ""), 2);
eq("dozen", n("dozen ball canning jars", ""), 12);
eq("half dozen", n("half-dozen etched wine glasses", ""), 6);
eq("explicit count beats capacity", n("lot of 4, 256 gb total", "64gb"), 4);

// "Lot 14" on an estate-sale tag is a lot NUMBER. Multiplying a price by it is the worst
// thing this code can do, so "of" is mandatory after lot/box/set.
eq("bare lot number is not a quantity", n("lot 14", ""), null);
eq("lot number with hash", n("Lot #7 oak dresser", ""), null);

// A matched set is one object with parts, not N sellable things.
eq("3 piece carving set", n("3 piece carving set in case", ""), null);
eq("2 pc cruet set", n("2 pc salt and pepper set", ""), null);
eq("4 piece tea service", n("sterling tea service 4 piece", ""), null);
eq("place setting", n("8 piece place setting", ""), null);

// Measurements are not counts.
eq("gallons", n("5 gallon stoneware crock", "RED WING"), null);
eq("inches", n("12 inch cast iron skillet", ""), null);
eq("tubes in a radio", n("1940s 5 tube radio", ""), null);
eq("dimensions", n("quilt, 6 feet by 8 feet", ""), null);
eq("uneven capacity division is a coincidence", n("250 gb total", "32gb"), null);

// Not lots at all.
eq("single item", n("Victorian oak dresser, good condition", ""), null);
eq("one module", n("32gb stick", "32gb 2rx4"), null);
eq("set with no number", n("set of dishes", ""), null);
eq("count of one is not a lot", n("1x sterling bowl", ""), null);
eq("absurd count ignored", n("900 x widgets", ""), null);
eq("empty input", n("", ""), null);
eq("null input", n(null, null), null);

// Known gap, deliberately left: a bare number before a plural noun ("8 oak dining chairs") is
// not distinguishable from "5 gallon crock" or "12 inch skillet" without far more machinery.
// Missing a lot costs a multiply we never do; inventing one triples a price.
eq("bare count is not detected (documented gap)", n("8 oak dining chairs", ""), null);

// The division must be stated, not assumed.
eq("explains itself", detectLot("256 gb total", "32gb 2rx4").how, "256GB total divided by 32GB per piece");

// "N containers", the way a dealer actually writes it. Production, 2026-09-23: "These are 4
// rolls of world war 2 silver nickels" detected no lot, so the model priced the group as one
// object and the re-pricer discarded eight live single-roll listings at $130-$200 as "single
// roll, not four rolls" — the best evidence available for the item.
const LOT = (count, unit) => ({ count, unit, how: "the dealer stated the count" });
eq("4 rolls", detectLot("These are 4 rolls of world war 2 silver nickels", ""), LOT(4, "roll"));
eq("2 boxes", detectLot("2 boxes of Fiesta plates", ""), LOT(2, "box"));
eq("3 bags", detectLot("3 bags of marbles from the attic", ""), LOT(3, "bag"));
eq("12 sleeves", detectLot("12 sleeves of wheat pennies", ""), LOT(12, "sleeve"));
eq("2 sets of shakers is two sets", detectLot("2 sets of salt and pepper shakers", ""), LOT(2, "set"));
eq("2 cases", detectLot("2 cases of soda bottles", ""), LOT(2, "case"));
// The unit is what the comps have to be priced in. Production, 2026-09-24: without it, "4 rolls
// of world war 2 silver nickels" searched as a single nickel, returned coins at $5-$10, and the
// lot arithmetic multiplied a $6 coin by four for a lot holding $573 of silver.
eq("the counted unit travels with the count", detectLot("4 rolls of war nickels", "").unit, "roll");
// "lot of 6" names no container to price in, so there is no unit to add to the search.
eq("no unit when the count came from 'lot of N'", detectLot("lot of 6 plates", ""),
  { count: 6, unit: null, how: "the dealer stated the count" });
// A year must never be read as a count. The three-digit cap means "1943 rolls" matches nothing
// at all rather than picking "194" or "943" out of the middle of the year.
eq("a year is not a count", detectLot("1943 rolls of war nickels", ""), null);
eq("a tube radio is still one radio", detectLot("1940s 5 tube radio", ""), null);
eq("a single roll is not a lot", detectLot("Roll of war nickels", ""), null);
eq("no digit, no lot", detectLot("rolls of war nickels", ""), null);
// The matched-set guard still holds.
eq("3 piece carving set is one object", detectLot("3 piece carving set", ""), null);
eq("4 piece tea service is one object", detectLot("4 piece tea service, silver plate", ""), null);

// ---- an adjective between the number and the piece word ----
// First real camera run, 2026-09-24. "4 candle sticks made of brass roughly 1/2 a pound each"
// read as no lot at all, because "candle" sits between the digit and "sticks", so the per-piece
// arithmetic never ran on a set of four.
eq("4 candle sticks is a lot of four",
  detectLot("4 candle sticks made of brass roughly 1/2 a pound each", ""),
  { count: 4, unit: null, how: "the dealer stated the count" });
eq("no unit is guessed from the adjective",
  detectLot("4 wooden sticks from the barn", "").unit, null);
eq("still works with pcs", detectLot("6 dinner pcs boxed", "").count, 6);
// The intervening word is allowed before a PIECE word only. These count what the container holds,
// not how many things there are, and reading them as lots would be wrong.
eq("4 drawer case is one case", detectLot("4 drawer case oak", ""), null);
eq("6 bottle crate is one crate", detectLot("6 bottle crate wooden", ""), null);
eq("2 slice toaster is one toaster", detectLot("2 slice toaster chrome", ""), null);
// And the rule that has been protecting tube radios all along still holds.
eq("5 tube radio is still one radio", detectLot("a 1940s 5 tube radio", ""), null);
// A matched set is not a lot, whichever branch found the count.
eq("3 piece carving set is still one set", detectLot("3 piece carving set", ""), null);
eq("4 silver pieces tea service is still one service",
  detectLot("4 silver pieces tea service", ""), null);
// KNOWN GAP, recorded rather than guessed at: written as one word it finds nothing, because
// "candlesticks" is not a piece word and "N <any plural noun>" is far too broad to match safely.
eq("one-word candlesticks finds no count", detectLot("4 candlesticks brass", ""), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
