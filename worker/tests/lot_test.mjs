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

// Explicit counts the dealer did type.
eq("times notation", n("8x 32gb sticks", ""), 8);
eq("lot of", n("Lot of 12 sterling teaspoons", ""), 12);
eq("set of", n("set of 6 pressed glass tumblers", ""), 6);
eq("qty", n("qty: 24", ""), 24);
eq("pieces", n("20 pieces", ""), 20);
eq("bare count wins over capacity", n("lot of 4, 256 gb total", "64gb"), 4);

// Things that are NOT lots.
eq("single item", n("Victorian oak dresser, good condition", ""), null);
eq("one module", n("32gb stick", "32gb 2rx4"), null);
eq("uneven division is a coincidence", n("250 gb total", "32gb"), null);
eq("no capacities at all", n("Red Wing 5 gallon crock", ""), null);
eq("count of one is not a lot", n("1x sterling bowl", ""), null);
eq("absurd count ignored", n("900 x widgets", ""), null);
eq("empty input", n("", ""), null);
eq("null input", n(null, null), null);

// The division must be stated, not assumed.
const r = detectLot("256 gb total", "32gb 2rx4");
eq("explains itself", r.how, "256GB total divided by 32GB per piece");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
