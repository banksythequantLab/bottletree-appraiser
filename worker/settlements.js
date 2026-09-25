// Dealer settlements: the arithmetic, kept out of the route so it can be tested without a
// database, a browser or a live worker.
//
// Every figure is in whole cents and every figure is returned, not derived later. A statement is
// stored as the numbers below and never recomputed, because a dealer who moves from 15% to 12%
// in April must not have March's statement rewritten the next time anyone opens it.

// Cents in, cents out. Money is never a float here - the only place a fraction appears is the
// commission, which is rounded once, on its own line, before anything else is subtracted.
const int = n => Math.round(Number(n) || 0);

// Half-up on exact halves, and explicitly so. JavaScript's Math.round already does half-up for
// positive numbers, but a commission is the number a dealer checks by hand against the printout,
// and "it happened to round the way the platform felt like" is not a thing to leave implicit.
// 12% of $137.95 is 1655.4 cents and must land on 1655, not 1656.
export function commissionOn(grossCents, pct) {
  const g = int(grossCents), p = Number(pct) || 0;
  if (!(g > 0) || !(p > 0)) return 0;
  return Math.round((g * p) / 100);
}

// An item belongs to a period if its basis timestamp falls inside it, inclusive at both ends.
// The dates are plain YYYY-MM-DD and the timestamps are ISO strings, so a string compare against
// the end date plus "￿" catches every time of day on the last day without any date parsing
// or timezone to get wrong. A sale at 23:59 on the 31st is in March; the same sale recorded as
// "2026-04-01T00:00:00Z" is not.
export function inPeriod(stamp, from, to) {
  const s = String(stamp || "");
  if (!s) return false;
  return s >= String(from) && s <= String(to) + "￿";
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A period has to be two real dates the right way round. Refusing a bad one here is cheaper than
// a statement covering an accidental decade.
export function periodError(from, to) {
  if (!DATE_RE.test(String(from || ""))) return "period start must be YYYY-MM-DD";
  if (!DATE_RE.test(String(to || ""))) return "period end must be YYYY-MM-DD";
  if (String(to) < String(from)) return "period end is before period start";
  return null;
}

// The whole statement. `items` are the rows already filtered to this seller and period; this
// function does not query, so what it is given is what it settles.
//
// Adjustments are signed: negative deducts from the dealer, positive credits them.
export function settle({ items = [], commission_pct = 0, rent_cents = 0, adjustments = [] } = {}) {
  const lines = items.map(i => ({
    item_id: i.id ?? null,
    name: String(i.name ?? ""),
    price_cents: int(i.price_cents),
    sold_at: i.sold_at ?? null,
  }));
  const gross_cents = lines.reduce((a, l) => a + l.price_cents, 0);
  const commission_cents = commissionOn(gross_cents, commission_pct);
  const rent_charged_cents = int(rent_cents);
  const adjust_cents = adjustments.reduce((a, x) => a + int(x && x.cents), 0);
  const net_cents = gross_cents - commission_cents - rent_charged_cents + adjust_cents;
  return {
    commission_pct: Number(commission_pct) || 0,
    rent_cents: rent_charged_cents,
    gross_cents, commission_cents, rent_charged_cents, adjust_cents, net_cents,
    item_count: lines.length,
    lines,
    // A dealer who sold nothing still owes the rent, so net goes negative and the card has to say
    // "owes $60.00" rather than showing a payout. Naming it here keeps that decision out of the
    // template, where it would be a minus sign nobody notices.
    owes: net_cents < 0,
  };
}

// Only these transitions. draft -> issued -> paid, and anything not yet paid can be voided.
// Nothing returns from paid or void: a paid statement is corrected by voiding and re-issuing,
// which leaves both rows behind, which is the point.
const NEXT = { draft: ["issued", "void"], issued: ["paid", "void"], paid: [], void: [] };
export function canTransition(from, to) {
  return (NEXT[String(from)] || []).includes(String(to));
}
