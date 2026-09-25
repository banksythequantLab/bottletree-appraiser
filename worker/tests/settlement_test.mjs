// Run:  node worker/tests/settlement_test.mjs
// Dealer payout arithmetic. Every case is a number someone would check by hand against a
// printout, which is the standard this has to meet.
import { settle, commissionOn, inPeriod, periodError, canTransition } from "../settlements.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};
const I = (name, price_cents, sold_at) => ({ id: name, name, price_cents, sold_at });

// ---- the worked example from the schema check ----
// Marge, booth B12, March 2026: three items, 12%, $60 rent.
const MARCH = [I("Roseville vase", 6500, "2026-03-04"), I("Griswold No 8", 4295, "2026-03-19"),
               I("Crock", 3000, "2026-03-31")];
const m = settle({ items: MARCH, commission_pct: 12, rent_cents: 6000 });
eq("gross", m.gross_cents, 13795);
eq("commission is 1655.4 rounded once", m.commission_cents, 1655);
eq("rent", m.rent_charged_cents, 6000);
eq("net", m.net_cents, 6140);
eq("item count", m.item_count, 3);
eq("not owing", m.owes, false);

// ---- rounding, stated rather than assumed ----
eq("exact half rounds up", commissionOn(1000, 12.5), 125);      // 125.0
eq("a third of a cent rounds down", commissionOn(101, 1), 1);   // 1.01
eq("half a cent rounds up", commissionOn(150, 1), 2);           // 1.5
eq("no commission on nothing", commissionOn(0, 30), 0);
eq("no commission at 0%", commissionOn(50000, 0), 0);
eq("negative gross earns no commission", commissionOn(-500, 10), 0);

// ---- the three mall models are the same two numbers ----
eq("rent only", settle({ items: MARCH, commission_pct: 0, rent_cents: 7500 }).net_cents, 13795 - 7500);
eq("commission only at 40%", settle({ items: MARCH, commission_pct: 40, rent_cents: 0 }).net_cents, 13795 - 5518);
eq("hybrid", settle({ items: MARCH, commission_pct: 10, rent_cents: 6000 }).net_cents, 13795 - 1380 - 6000);

// ---- a dealer who sold nothing still owes the rent ----
const quiet = settle({ items: [], commission_pct: 12, rent_cents: 6000 });
eq("no items, no gross", quiet.gross_cents, 0);
eq("no items, no commission", quiet.commission_cents, 0);
eq("net is the rent, owed", quiet.net_cents, -6000);
eq("and it says so", quiet.owes, true);

// ---- adjustments are signed and both directions work ----
const adj = settle({ items: MARCH, commission_pct: 12, rent_cents: 6000,
  adjustments: [{ label: "bag charges", cents: -400 }, { label: "layaway settled", cents: 2500 }] });
eq("adjustments net out", adj.adjust_cents, 2100);
eq("and land in net", adj.net_cents, 6140 + 2100);
eq("a single deduction", settle({ items: MARCH, commission_pct: 0, rent_cents: 0,
  adjustments: [{ label: "damage", cents: -1295 }] }).net_cents, 13795 - 1295);

// ---- lines are copied, not referenced ----
eq("lines carry what the printout needs", adj.lines[0],
  { item_id: "Roseville vase", name: "Roseville vase", price_cents: 6500, sold_at: "2026-03-04" });

// ---- period membership ----
eq("first day is in", inPeriod("2026-03-01", "2026-03-01", "2026-03-31"), true);
eq("last day is in", inPeriod("2026-03-31", "2026-03-01", "2026-03-31"), true);
// The case that would silently lose a sale: a timestamp with a time on the last day.
eq("23:59 on the last day is in", inPeriod("2026-03-31T23:59:59Z", "2026-03-01", "2026-03-31"), true);
eq("midnight on the next day is out", inPeriod("2026-04-01T00:00:00Z", "2026-03-01", "2026-03-31"), false);
eq("the day before is out", inPeriod("2026-02-28", "2026-03-01", "2026-03-31"), false);
eq("an unsold item has no stamp", inPeriod(null, "2026-03-01", "2026-03-31"), false);
eq("empty string is not a date", inPeriod("", "2026-03-01", "2026-03-31"), false);

// ---- a period has to be two real dates the right way round ----
eq("good period", periodError("2026-03-01", "2026-03-31"), null);
eq("reversed", periodError("2026-03-31", "2026-03-01"), "period end is before period start");
eq("not a date", periodError("March", "2026-03-31"), "period start must be YYYY-MM-DD");
eq("missing end", periodError("2026-03-01", ""), "period end must be YYYY-MM-DD");
eq("one day period is fine", periodError("2026-03-05", "2026-03-05"), null);

// ---- status transitions ----
eq("draft issues", canTransition("draft", "issued"), true);
eq("issued is paid", canTransition("issued", "paid"), true);
eq("issued can be voided", canTransition("issued", "void"), true);
eq("paid is final", canTransition("paid", "issued"), false);
eq("paid cannot be voided - void and re-issue instead", canTransition("paid", "void"), false);
eq("a void does not come back", canTransition("void", "draft"), false);
eq("no skipping issue", canTransition("draft", "paid"), false);
eq("nonsense", canTransition("draft", "banana"), false);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
