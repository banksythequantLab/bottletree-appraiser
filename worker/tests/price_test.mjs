// Run:  node worker/tests/price_test.mjs
// Measured 2026-09-27 on a phone: an Intel Optane 256GB module came back with four good eBay
// comparables ($190-$390, median $242) and an EMPTY price range, no warning. The re-pricing pass
// had returned the prompt's blank template - all zeros - and a truthiness check accepted it.
import { usablePrice } from "../appraiser.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log(`FAIL ${n}`)); };

// The exact object production stored.
const PHONE = { low: 0, high: 0, suggested_retail: 0, floor: 0, currency: "USD",
  basis: "Price range reflects the spread of current asking prices for identical 256GB Optane DC persistent memory modules, from used to new condition." };
ok("the all-zero range from the phone is NOT usable", usablePrice(PHONE, "USD") === null);
ok("even with a sensible basis note beside it", usablePrice({ ...PHONE, basis: "$190-$390" }, "USD") === null);
ok("a missing range is not usable", usablePrice(undefined, "USD") === null);
ok("nor null", usablePrice(null, "USD") === null);
ok("nor a string", usablePrice("190-390", "USD") === null);

const real = usablePrice({ low: 190, high: 390, suggested_retail: 240, floor: 170, currency: "USD", basis: "comps" }, "USD");
ok("a real range is usable", !!real && real.high === 390 && real.low === 190);
ok("and keeps its suggested retail", real && real.suggested_retail === 240);
// A high with no low is still a price; priceOf fills the rest in.
const highOnly = usablePrice({ high: 300 }, "USD");
ok("a high-only range is usable", !!highOnly && highOnly.high === 300);
ok("reversed low/high is normalised, not rejected", usablePrice({ low: 390, high: 190 }, "USD")?.high === 390);

// The two call sites the fix lives in, asserted against the real source.
const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "appraiser.js"), "utf8");
ok("the re-pricing pass uses usablePrice, not truthiness",
   /const secondPrice = usablePrice\(second\.price_range, currency\);\s*\n\s*if \(secondPrice\) price = secondPrice;/.test(APP));
ok("the old truthiness check is gone", !/if \(second\.price_range\) price = priceOf/.test(APP));
ok("a zero range never leaves the pipeline unflagged",
   /if \(!\(price\.high > 0\) && !warnings\.some/.test(APP));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
