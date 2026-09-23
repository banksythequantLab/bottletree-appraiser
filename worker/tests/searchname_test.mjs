// Run:  node worker/tests/searchname_test.mjs
// Which name the comps search uses when the model's identification shares no words with the
// dealer's description. Both cases below happened in production.
import { ignoresDealer, dealerName, significantWords } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};

// The rule the pipeline applies: the dealer's words win the search only when the dealer said
// enough to be worth searching.
const searchesDealerWords = (modelName, description) =>
  ignoresDealer(modelName, description) && significantWords(dealerName(description)).size >= 3;

// Production, 2026-09-23: the vision model read a box of wartime nickels as shotgun shells.
// Searching its name returned four shotgun-ammo listings and not one coin listing.
eq("shotshells vs nickels: search the dealer's words",
  searchesDealerWords("Reloaded Federal 12 Gauge Shotshells",
    "WWII Silver Jefferson Nickels - 4 Rolls (160 Coins) - United States Mint 1942-1945"), true);

// Production, earlier: the dealer typed almost nothing, and the model's technical name is the
// only thing in the exchange that can find a comparable.
eq("vague dealer wording: keep the model's name",
  searchesDealerWords("SK Hynix 32GB DDR4-2400 ECC RDIMM", "256 gb total"), false);
eq("empty description: keep the model's name",
  searchesDealerWords("SK Hynix 32GB DDR4-2400 ECC RDIMM", ""), false);
eq("two words is still not enough",
  searchesDealerWords("Reloaded Federal 12 Gauge Shotshells", "silver nickels"), false);

// When the two agree on anything at all, nothing changes — the model's name is kept.
eq("shared word means no conflict",
  ignoresDealer("Red Wing 5 gallon salt glaze crock", "big old stoneware crock from the barn"), false);
eq("no shared word is a conflict",
  ignoresDealer("Reloaded Federal 12 Gauge Shotshells", "WWII Silver Jefferson Nickels 4 Rolls"), true);

// dealerName takes the first clause, which is where people put the identification.
eq("first clause only", dealerName("WWII Silver Jefferson Nickels, 4 rolls, from my father's estate"),
  "WWII Silver Jefferson Nickels");
eq("empty in, empty out", dealerName(""), "");

// significantWords drops the filler that would otherwise clear the threshold on its own.
eq("filler does not count", significantWords("old antique vintage heavy cast iron piece").size, 0);
eq("substance counts", significantWords("WWII Silver Jefferson Nickels").size >= 3, true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
