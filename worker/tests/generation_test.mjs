// Run:  node worker/tests/generation_test.mjs
// Every case is a listing eBay actually returned for a 32GB DDR4 ECC RDIMM query.
import { contradictsGeneration as c, cleanForEbay } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};
const Q = "32GB DDR4 ECC Registered RDIMM Memory Module";

// Listings that halved the median in a live run.
eq("PC3L-8500R is DDR3", c(Q, "Samsung 32GB 4Rx4 PC3L-8500R-07-10-AB0-P1 ECC REG Server"), true);
eq("PC3L-12800R is DDR3", c(Q, "2x Samsung 16GB (32GB Total) PC3L-12800R ECC Server RAM"), true);
eq("explicit DDR3", c(Q, "Kingston 32GB DDR3 ECC RDIMM"), true);
eq("DDR56400 is DDR5", c(Q, "CrucialPro Overclocking 32GB 2x16GB RAM DDR56400 Desktop"), true);
eq("SO-DIMM is laptop memory", c(Q, "32GB Kit (2x16GB) 2Rx8 DDR-4 3200AA SO-DIMM Micron"), true);

// The right parts must survive.
eq("PC4 part", c(Q, "MICRON 32GB 2RX4 PC4-2933Y DDR4 SERVER MEMORY"), false);
eq("PC4-2666V part", c(Q, "sk Hynix 32GB 2Rx4 PC4-2666V-RB2-1 DDR4 HMA84GR7AFR4N-VK"), false);
eq("DDR4 title", c(Q, "Samsung 32GB DDR4 PC4-2933Y 2Rx4 ECC REG DIMM"), false);
eq("no generation in title", c(Q, "Server Memory Module 32GB ECC"), false);

// Never reject on absence, and never trip on an antique.
eq("no generation in query", c("Red Wing 5 gallon crock", "Red Wing PC4 crock"), false);
eq("antique unaffected", c("Griswold No 8 cast iron skillet", "Griswold 8 Cast Iron Skillet 704"), false);
eq("empty", c("", ""), false);

// Query hygiene: what compsQuery hands over is not what eBay should be asked.
eq("strips brackets and filler",
   cleanForEbay("32GB DDR4 SDRAM DIMM (Part C424TRB111)"), "32GB DDR4 SDRAM DIMM C424TRB111");
eq("drops a period range",
   cleanForEbay("32GB DDR4 SDRAM DIMM 2015-2023"), "32GB DDR4 SDRAM DIMM");
eq("keeps a single year, which is gold on an antique",
   cleanForEbay("Roseville Freesia vase 1945"), "Roseville Freesia vase 1945");
eq("keeps hyphenated part codes", cleanForEbay("PC4-2933Y 2Rx4"), "PC4-2933Y 2Rx4");
eq("drops circa", cleanForEbay("Red Wing crock circa 1930"), "Red Wing crock 1930");
eq("empty query", cleanForEbay(""), "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
