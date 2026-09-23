// Run:  node worker/tests/coherence_test.mjs
// Melt per piece against the asking price per piece. Every figure below is from a real run.
import { unitDisagreement } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};

// The real lot, 2026-09-23: $584 of silver across 4 rolls is $146 a roll, against a $132 median
// asking price for a single roll. That is what agreement looks like.
eq("war nickel rolls agree", unitDisagreement(584, 4, 132), 1.11);

// The same photographs read as four one-ounce Silver Eagles: $65 of silver a piece against a
// $289 median. This is the failure that priced a $585 lot at $260, and the check catches it —
// where comparing the TOTALS ($260 melt vs $289 comps) called it an 11% agreement.
eq("Silver Eagle misread is loud", unitDisagreement(260, 4, 289), 4.45);
eq("and the totals comparison is not", Math.round((289 / 260) * 100) / 100, 1.11);

// Direction does not matter — metal far above the market is equally wrong.
eq("metal far above market", unitDisagreement(4000, 4, 100), 10);
eq("metal far below market", unitDisagreement(100, 4, 250), 10);

// Nothing to compare.
eq("no melt", unitDisagreement(0, 4, 132), null);
eq("no lot", unitDisagreement(584, 1, 132), null);
eq("no market", unitDisagreement(584, 4, 0), null);
eq("all missing", unitDisagreement(null, null, null), null);
eq("negative melt", unitDisagreement(-584, 4, 132), null);

// Borderline: the warning fires at 2x and not below it.
eq("just under the line", unitDisagreement(400, 4, 51) < 2, true);
eq("just over the line", unitDisagreement(400, 4, 49) >= 2, true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
