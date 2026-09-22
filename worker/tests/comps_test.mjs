// Comps extraction tests.  Run:  node worker/tests/comps_test.mjs
//
// Every case here is a failure that actually happened in production, not an invented one.
import { pricesIn, hitPrice } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// ---- pricesIn: which dollar figures on a page are actually the item's price ----
eq("plain title price", pricesIn("SK Hynix 32GB DDR4-2400 ECC RDIMM $159.99"), [159.99]);
eq("shipping after", pricesIn("$159.99 +$12.55 shipping"), [159.99]);
eq("free shipping before price", pricesIn("Free shipping. SK Hynix 32GB DDR4 ECC RDIMM $159.99"), [159.99]);
eq("save badge", pricesIn("Save $10 - now $189.00"), [189]);
eq("was/now", pricesIn("Was $249.99, now $179.99"), [179.99]);
eq("US prefix", pricesIn("US $1,250.00"), [1250]);
eq("percent off is not a price", pricesIn("$25 off orders over $200"), [200]);
eq("financing", pricesIn("$1,899.00 or $79/mo"), [1899]);
eq("sub-dollar dropped", pricesIn("$0.99 each"), []);
eq("multi-listing page", pricesIn("$145.00 $150.00 $159.99 $162.50"), [145, 150, 159.99, 162.5]);
eq("no prices", pricesIn("Sold out - check back soon"), []);
eq("null safe", pricesIn(null), []);

// ---- hitPrice: title beats body, median beats first ----
eq("title wins", hitPrice("Red Wing 5 gal crock $425", "Shipping $19.99 and handling"), 425);
eq("falls back to body", hitPrice("Red Wing 5 gallon crock", "Sold for $380.00 at auction"), 380);
eq("median of body, not first", hitPrice("DDR4 ECC RDIMM lot", "$150.00 $155.00 $160.00"), 155);
eq("no number anywhere", hitPrice("Antique oak dresser", "Contact for price"), null);
// Shipping used to be the first figure on the page, so shipping won.
eq("shipping no longer wins", hitPrice("SK Hynix 32GB DDR4", "+$5.99 shipping. Buy It Now $164.00"), 164);
// WorthPoint handed back $906,000 for a Griswold skillet.
eq("six-figure junk dropped", hitPrice("Griswold Colonial Breakfast Skillet 666 B", "$906,000"), null);
eq("genuine high price kept", hitPrice("Tiffany Studios leaded glass lamp", "$42,000"), 42000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
