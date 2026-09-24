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
// One matching size is enough — a title naming several sizes is not a contradiction. The query
// has to name a set here, or the lot rule below rejects this title first, for its own good reason.
eq("one matching size is enough", c("Red Wing crock pair 5 gallon", "Red Wing Crock Pair 3 Gallon and 5 Gallon"), false);
eq("but a lot answering a single-item query still goes", c(CROCK, "Red Wing Crock Lot 3 Gallon and 5 Gallon Pair"), true);
eq("quarts", c("Pyrex Cinderella 4 quart mixing bowl", "Pyrex Cinderella 2 Quart Butterprint Bowl"), true);
eq("quarts match", c("Pyrex Cinderella 4 quart mixing bowl", "Pyrex 4 Qt Cinderella Bowl Butterprint"), false);
eq("inches differ", c('Roseville Freesia 8 inch vase', 'Roseville Freesia Vase 6" Blue 119-6'), true);
eq("inches match", c('Roseville Freesia 8 inch vase', 'Roseville Freesia 8" Blue Vase 120-8'), false);
eq("different units do not collide", c("Red Wing 5 gallon crock", 'Red Wing Crock 12" Tall Salt Glaze'), false);
// "in" as the English word must never be read as inches.
eq('bare "in" is not inches', c("Griswold 8 inch skillet", "Griswold No 8 Skillet Made in Erie PA"), false);

// Spelled-out capacities. The six-gallon crock at $1,195 sailed through a digits-only pattern
// while the three-gallon ones were being correctly rejected, which moved the median the wrong way.
eq("six gallon spelled out", c(CROCK, "Antique Red Wing Stoneware Company Salt Glaze Six Gallon Crock Leaf"), true);
eq("three gallon spelled out", c(CROCK, "Red Wing Three Gallon Salt Glaze Crock Birch Leaf"), true);
eq("five gallon spelled out matches", c(CROCK, "Antique Red Wing Five Gallon Salt Glaze Crock Leaf Decorated"), false);
eq("word in query, digit in title", c("Red Wing five gallon crock", "Red Wing 5 Gallon Crock Salt Glaze"), false);
eq("word in query, wrong digit in title", c("Red Wing five gallon crock", "Red Wing 3 Gallon Crock"), true);
eq("half gallon word", c("Red Wing half gallon jug", "Red Wing 1 Gallon Jug"), true);
eq("half gallon matches the fraction", c("Red Wing half gallon jug", "Red Wing 1/2 Gallon Jug"), false);
eq("word number not near a unit is ignored", c(CROCK, "Red Wing 5 Gallon Crock One Owner Estate Find"), false);

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

// ---- multi-option listings ----
// These display the cheapest variant's price, so the number is not a price for this item.
const FIESTA = "Fiesta radioactive red dinner plate";
eq("choose listing", c(FIESTA, "Choose FIESTA Dinner Plates Ivory Yellow Turquoise Radioactive Red"), true);
eq("you pick", c(FIESTA, "Vintage Fiesta Dinner Plate You Pick Color Radioactive Red Turquoise"), true);
eq("your choice", c(FIESTA, "Fiestaware Dinner Plates Your Choice of Color HLC"), true);
eq("plain listing survives", c(FIESTA, 'Fiesta "Radioactive Red" 10 Dinner Plate Retired Color Genuine HLC'), false);

// ---- set vs single, both directions ----
const BOWLSET = "Pyrex Butterprint Cinderella mixing bowl set";
eq("single bowl answering a set query", c(BOWLSET, "Vintage Pyrex Amish Butterprint 442 Cinderella Mixing Bowl Blue"), true);
eq("set survives", c(BOWLSET, "Pyrex Vintage Amish Butterprint Cinderella Bowl Set of 4"), false);
eq("plural noun counts as a set", c(BOWLSET, "Vintage Pyrex Amish Blue Butterprint Cinderella Nesting Bowls"), false);
eq("piece count counts as a set", c(BOWLSET, "PYREX Cinderella Butterprint Nesting 3pc Mixing Bowl Handled"), false);
const SPOON = "Towle Old Master sterling teaspoon";
eq("set of 2 answering a single query", c(SPOON, "Towle OLD MASTER Sterling Silver Teaspoons Set of 2 Spoons"), true);
eq("parenthetical count", c(FIESTA, "Two (2) 1930s FIESTA PLATES ORANGE RED Radioactive"), true);
eq("single spoon survives", c(SPOON, "Towle Silver OLD MASTER Sterling 1942 6 Teaspoon EXCELLENT Condition"), false);
// The coin roll query asks for twenty coins, so roll listings must survive.
const ROLL = "1964 Kennedy half dollar roll of 20";
eq("roll answering a roll query", c(ROLL, "90% Silver 1964-P/D Kennedy Half Dollar 20-Coin Roll Avg Circ"), false);
eq("roll of 20 spelled out", c(ROLL, "Original Choice to GEM BU Roll of 20 1964 Kennedy Half Dollars"), false);
eq("single coin answering a roll query", c(ROLL, "1964 Kennedy Half Dollar 90% Silver BU Coin"), true);
const JAR = "Hull Little Red Riding Hood cookie jar";
eq("7 pc set answering a single jar query", c(JAR, "7 pc Hull Little Red Riding Hood set Cookie Jar, Teapot, Creamer"), true);
eq("6 piece set", c(JAR, "Vintage Hull Little Red Riding Hood 6 Piece Set Cookie Jar Butter Dish"), true);
eq("a lot is several", c(JAR, "Hull Ceramic Hand-Painted Little Red Riding Hood Girl Figurine Lot, Flawed"), true);
eq("one jar survives", c(JAR, "Vintage Hull #967 Little Red Riding Hood Cookie Jar"), false);
// A plain single-item query must not start rejecting ordinary listings.
eq("no set logic on a plain query", c("Singer Featherweight 221 sewing machine",
  "Vintage Singer Featherweight Sewing Machine 221-1 Black 1948 Portable"), false);
eq("accessories mentioned, no count", c("Singer Featherweight 221 sewing machine",
  "Singer Featherweight 221 with Case and Attachments"), false);

// ---- parts/repair, whatever the separator ----
// A live Featherweight sweep kept this $149.90 listing in a pool of working machines whose
// median was $400. "Part Or Repair" is "parts/repair" spelled with a word.
const FW = "Singer Featherweight 221 sewing machine";
eq("part or repair", c(FW, "Vintage SINGER 221 Featherweight Sewing Machine Part Or Repair"), true);
eq("parts or repair", c(FW, "Singer 221 Featherweight Sewing Machine Parts Or Repair As Is"), true);
eq("parts and repair", c(FW, "Singer 221 Featherweight Parts and Repair Lot"), true);
eq("parts/repair still", c(FW, "Singer 221 Featherweight Sewing Machine Parts/Repair"), true);
eq("parts & repair still", c(FW, "Singer 221 Featherweight Sewing Machine Parts & Repair"), true);
eq("repair or parts, reversed", c(FW, "Singer 221 Featherweight Sewing Machine Repair Or Parts"), true);
eq("for parts still", c(FW, "Singer 221 Featherweight Sewing Machine For Parts"), true);
// The dealer asking about a broken one keeps them.
eq("dealer asked for parts", c(FW + " for parts or repair",
  "Vintage SINGER 221 Featherweight Sewing Machine Part Or Repair"), false);
// No separator at all. Found by repeating the repricer six times against one frozen Zenith
// pool: three different sets of four came back, and one of them kept this as a comparable for
// a working radio. The deterministic filter should never have handed it over.
const ZEN = "Zenith Bakelite tube radio";
eq("bare Parts Repair", c(ZEN, "Zenith H724Z Tube Radio AM FM Bakelite Brown Portable Parts Repair Handle"), true);
eq("bare Part Repair singular", c(ZEN, "Zenith Bakelite Tube Radio Part Repair"), true);
eq("repair parts, reversed and bare", c(ZEN, "Zenith Bakelite Tube Radio Repair Parts Lot"), true);
// Working radios in the same live pool must survive all of it.
eq("tested working survives", c(ZEN, "Vintage Zenith H724Z1 Bakelite Am Fm Table Radio Tested Working Green"), false);
eq("needs love survives", c(ZEN, "Vintage 1950s(?) Zenith Bakelite Tube Radio H725 Brown Tested Working Needs Love"), false);
eq("works original survives", c(ZEN, "Vintage Zenith 5D810Y Black Bakelite Tube Radio AM Works Original USA"), false);

// Words that merely sit near each other are not the phrase.
eq("repaired is not repair-or-parts", c(FW, "Singer 221 Featherweight Professionally Repaired and Serviced"), false);
eq("part of a collection", c(FW, "Singer Featherweight 221 Part of a Large Estate Collection"), false);
eq("working machine untouched", c(FW, "Vintage 1936 Singer Featherweight 221 Sewing Machine - RUNNING Motor"), false);

// ---- sizesIn itself ----
eq("parses gallons", [...(sizesIn("5 gallon crock").get("gal") || [])], [5]);
eq("parses both units", [...sizesIn('3 gal 12" crock').keys()], ["gal", "in"]);
eq("empty on no size", sizesIn("Red Wing crock").size, 0);
eq("ignores zero", sizesIn("0 gallon crock").size, 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
