// Run:  node worker/tests/spec_test.mjs
// Every case is a listing eBay actually returned for one of ten real antique queries,
// or a good comp from the same result set that must survive the filter.
import { contradictsSpec as c, sizesIn } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};

// ---- size ----
const CROCK = "Red Wing 5 gallon salt glaze stoneware crock";
eq("3 gallon answering 5", c(CROCK, "Antique Red Wing 3 Gallon Salt Glaze Crock Birch Leaf"), true);
eq("2 gal abbreviated", c(CROCK, "Red Wing 2 Gal Stoneware Crock with Wing"), true);
eq("6 gallon", c(CROCK, "Red Wing 6 Gallon Crock Union Oval"), true);
eq("5 gallon matches", c(CROCK, "Red Wing 5 Gallon Salt Glaze Crock Double P Wing"), false);
eq("5 gal abbreviated matches", c(CROCK, "RED WING 5 GAL CROCK ANTIQUE STONEWARE"), false);
eq("size unstated in title", c(CROCK, "Red Wing Salt Glaze Stoneware Crock Antique Primitive"), false);
eq("size unstated in query", c("Red Wing salt glaze crock", "Red Wing 3 Gallon Crock"), false);
eq("hyphenated unit", c(CROCK, "Red Wing 3-Gallon Salt Glaze Crock"), true);
eq("fraction gallon", c("Red Wing 1/2 gallon jug", "Red Wing 1 Gallon Jug Brown Top"), true);
eq("fraction matches", c("Red Wing 1/2 gallon jug", "Red Wing 1/2 Gallon Jug Salt Glaze"), false);
eq("two sizes in title, one matches", c(CROCK, "Red Wing Crock Lot 3 Gallon and 5 Gallon Pair"), false);
eq("quarts", c("Pyrex Cinderella 4 quart mixing bowl", "Pyrex Cinderella 2 Quart Butterprint Bowl"), true);
eq("quarts match", c("Pyrex Cinderella 4 quart mixing bowl", "Pyrex 4 Qt Cinderella Bowl Butterprint"), false);
eq("inches differ", c('Roseville Freesia 8 inch vase', 'Roseville Freesia Vase 6" Blue 119-6'), true);
eq("inches match", c('Roseville Freesia 8 inch vase', 'Roseville Freesia 8" Blue Vase 120-8'), false);
eq("different units do not collide", c("Red Wing 5 gallon crock", 'Red Wing Crock 12" Tall Salt Glaze'), false);
// "in" as the English word must never be read as inches.
eq('bare "in" is not inches', c("Griswold 8 inch skillet", "Griswold No 8 Skillet Made in Erie PA"), false);

// ---- reproductions ----
eq("reproduction", c(CROCK, "Reproduction Red Wing 5 Gallon Crock Salt Glaze Style"), true);
eq("repro abbreviated", c("Hull Little Red Riding Hood cookie jar", "Repro Little Red Riding Hood Cookie Jar"), true);
eq("replica", c("Griswold No 8 large block logo skillet", "Replica Griswold No 8 Cast Iron Skillet"), true);
eq("dealer asked about a repro", c("reproduction Hull cookie jar", "Reproduction Hull Little Red Riding Hood Jar"), false);
eq("real one survives", c("Hull Little Red Riding Hood cookie jar", "Hull Little Red Riding Hood Cookie Jar 967 Gold"), false);

// ---- parts and accessories ----
const RADIO = "Zenith Bakelite tube radio";
eq("knob leading the title", c(RADIO, "Knob for Zenith Bakelite Tube Radio Vintage Brown"), true);
eq("knobs plural leading", c(RADIO, "Knobs Set of 4 Zenith Radio Bakelite Original"), true);
eq("dial only", c(RADIO, "Zenith Radio Dial Only Glass Bakelite Vintage"), true);
eq("for parts", c(RADIO, "Zenith Bakelite Tube Radio For Parts Not Working"), true);
eq("parts/repair", c(RADIO, "Zenith Tube Radio Parts / Repair Bakelite Case"), true);
eq("knob mentioned but not the item", c(RADIO, "Zenith Bakelite Tube Radio with Original Knobs Works"), false);
eq("dealer asked about the knob", c("Zenith radio bakelite knob", "Knob Zenith Radio Bakelite Original"), false);
eq("plain radio survives", c(RADIO, "Vintage Zenith Bakelite Tube Radio Model 6D030 Works"), false);
// The lid case: a bowl set sold with its lids is a good comp, not a lid.
eq("with lids is fine", c("Pyrex Butterprint Cinderella bowl set",
  "Pyrex Butterprint Cinderella Bowl Set of 4 with Lids"), false);
eq("lids only is not", c("Pyrex Butterprint Cinderella bowl set",
  "Pyrex Butterprint Lids Only Set of 3 Replacement"), true);
eq("lid leading the title", c("Griswold No 8 skillet", "Lid for Griswold No 8 Cast Iron Skillet"), true);
eq("handle leading", c("Singer Featherweight 221 sewing machine",
  "Handle for Singer Featherweight 221 Case Leather"), true);
eq("case is not a part word", c("Singer Featherweight 221 sewing machine",
  "Singer Featherweight 221 with Case and Attachments"), false);
eq("feet as a part", c("Towle Old Master sterling teaspoon", "Feet Set Towle Old Master Sterling Replacement"), true);
eq("coin roll unaffected", c("1964 Kennedy half dollar roll of 20",
  "1964 Kennedy Half Dollar Roll 20 Coins 90% Silver BU"), false);

// ---- sizesIn itself ----
eq("parses gallons", [...(sizesIn("5 gallon crock").get("gal") || [])], [5]);
eq("parses both units", [...sizesIn('3 gal 12" crock').keys()], ["gal", "in"]);
eq("empty on no size", sizesIn("Red Wing crock").size, 0);
eq("ignores zero", sizesIn("0 gallon crock").size, 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
