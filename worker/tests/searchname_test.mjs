// Run:  node worker/tests/searchname_test.mjs
// Which name the comps search uses when the model's identification shares no words with the
// dealer's description. Both cases below happened in production.
import { ignoresDealer, dealerName, significantWords, searchPhrase } from "../appraiser.js";

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

// One shared word is not agreement. Production, 2026-09-23: "2023 American Silver Eagle Coin
// Set" against "4 rolls of world war 2 silver nickels" shares only "silver". The old test let it
// through, the dealer's identification never took over, and melt priced four one-ounce Eagles at
// $260 instead of 160 wartime nickels at $585 — below the lot's own scrap value.
eq("one incidental shared word is still a conflict",
  ignoresDealer("2023 American Silver Eagle Coin Set",
    "These are 4 rolls of world war 2 silver nickels"), true);
eq("and the dealer's words drive the search",
  searchesDealerWords("2023 American Silver Eagle Coin Set",
    "These are 4 rolls of world war 2 silver nickels"), true);
eq("two shared words is agreement",
  ignoresDealer("WWII silver nickel rolls, 4 rolls",
    "These are 4 rolls of world war 2 silver nickels"), false);
// With a short description one shared word is a large part of everything the dealer said, so a
// specific identification is not overridden on that basis.
eq("short description keeps the model's identification",
  ignoresDealer("Red Wing 5 gallon salt glaze crock", "big stoneware crock"), false);
eq("sentence scaffolding is not something the dealer told us",
  significantWords("these are some of them").size, 0);

// dealerName takes the first clause, which is where people put the identification.
eq("first clause only", dealerName("WWII Silver Jefferson Nickels, 4 rolls, from my father's estate"),
  "WWII Silver Jefferson Nickels");
eq("empty in, empty out", dealerName(""), "");

// significantWords drops the filler that would otherwise clear the threshold on its own.
eq("filler does not count", significantWords("old antique vintage heavy cast iron piece").size, 0);
eq("substance counts", significantWords("WWII Silver Jefferson Nickels").size >= 3, true);

// searchPhrase: a dealer's sentence reduced to something eBay can use. Production, 2026-09-23:
// the raw sentence went to eBay, broaden() shortened it to "United States Mint These", and the
// comparables came back as rolls of postage stamps for a lot of silver nickels.
eq("strips the leading sentence filler",
  searchPhrase("These are 4 rolls of world war 2 silver nickels"), "4 rolls world war 2 silver nickels");
eq("keeps a plain name untouched",
  searchPhrase("Red Wing 5 gallon salt glaze crock"), "Red Wing 5 gallon salt glaze crock");
eq("drops a leading article", searchPhrase("a Griswold No 8 skillet"), "Griswold No 8 skillet");
eq("keeps numbers", searchPhrase("I have 4 rolls"), "4 rolls");
eq("keeps model numbers with periods", searchPhrase("Zenith model H725"), "Zenith model H725");
eq("empty in, empty out", searchPhrase(""), "");
eq("filler only", searchPhrase("these are"), "");
eq("caps run-on descriptions at ten words",
  searchPhrase("Griswold No 8 cast iron skillet large block logo heat ring erie pennsylvania usa")
    .split(" ").length, 10);

// ---- the override firing on a CORRECT identification ----
// Production, 2026-09-24, first real run through a camera. Four brass candlesticks photographed
// from directly overhead. The model got it exactly right - "Set of Four Brass Candlesticks" - and
// the override threw it away, because "brass" is a stopword, "four" is a count, and "candle
// sticks" and "candlesticks" are different strings. The dealer's raw typed sentence became the
// item's NAME, and the card told them their description and the photographs disagreed about what
// it was when the two agreed completely.
const CANDLES = "4 candle sticks made of brass roughly 1/2 a pound each";
eq("a correct identification is not an override",
  ignoresDealer("Set of Four Brass Candlesticks", CANDLES), false);
eq("spaced compound matches the joined one",
  ignoresDealer("Antique Brass Candlesticks", CANDLES), false);
eq("joined compound matches the spaced one",
  ignoresDealer("Pair of Candle Sticks", "vintage brass candlesticks I found"), false);
// And the disaster it was written for still fires. One shared word, and that word a material.
eq("silver alone is still not agreement",
  ignoresDealer("2023 American Silver Eagle Coin Set", "4 rolls of world war 2 silver nickels"), true);
eq("a count alone is not agreement",
  ignoresDealer("Set of Four Porcelain Figurines", "four cast iron door stops from the barn"), true);
eq("naming the object is agreement even once",
  ignoresDealer("World War II Silver Nickel Roll", "4 rolls of world war 2 silver nickels"), false);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
