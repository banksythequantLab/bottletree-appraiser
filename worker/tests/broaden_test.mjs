// Run:  node worker/tests/broaden_test.mjs
// eBay's search is AND-ish: one unknown token returns nothing at all.
import { broaden } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// The case that cost us: the dealer's marking zeroes a 6,325-result search.
eq("drops a dealer marking first",
   broaden("32GB DDR4 SDRAM DIMM 2Rx4 C424TRB111"),
   ["32GB DDR4 SDRAM DIMM 2Rx4", "32GB DDR4 SDRAM DIMM", "32GB DDR4 SDRAM"]);

// 2Rx4 is short and only has two digits — it is a real spec, not a serial, and must survive.
eq("keeps a short spec token",
   broaden("32GB DDR4 ECC RDIMM 2Rx4").includes("32GB DDR4 ECC RDIMM"), true);

// A genuine manufacturer part number is dropped only on the broadening pass, never from the first
// query — the first query is the unmodified original, which callers try before these.
eq("drops a manufacturer part number too",
   broaden("Hynix HMA84GR7AFR4N 32GB DDR4")[0], "Hynix 32GB DDR4");

// Antiques carry years, not part numbers. A year must not look like a serial.
eq("keeps a year", broaden("Roseville Freesia vase 1945")[0], "Roseville Freesia vase");
eq("year survives the short fallback",
   broaden("Roseville Pottery Freesia blue vase 1945").some(q => q.startsWith("Roseville")), true);

// Nothing to broaden.
eq("three words have nothing left to drop", broaden("Red Wing crock"), []);
eq("empty", broaden(""), []);
eq("null", broaden(null), []);

// The original is never repeated back.
eq("no duplicate of the original",
   broaden("32GB DDR4 SDRAM DIMM").every(q => q !== "32GB DDR4 SDRAM DIMM"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
