// What a Stripe webhook means for an order, decided without a database or a network so it can
// be tested for what it is: a set of rules about other people's money.
//
// Two things were wrong before this existed. First, checkout.session.completed was treated as
// "paid". It is not: for ACH, Klarna and vouchers the session completes while the payment is
// still processing, and confirmation arrives later as checkout.session.async_payment_succeeded.
// Marking the item sold on completion alone takes it off the shelf for a payment that may never
// land. Second, nothing recorded the case where the item had already sold in the shop before the
// webhook arrived — the buyer's money was taken and the order sat "pending" forever with nobody
// told.

// Online checkout needs BOTH halves of the Stripe configuration, and refuses to open on one.
//
// This is not tidiness. A secret key on its own lets a buyer pay; without the signing secret
// the webhook handler rejects every delivery before it looks at a signature, so the payment
// is never heard about: the item stays listed, the order sits pending forever, and the same
// piece can be sold again over the counter. Half-configured has to fail closed, because the
// failure it otherwise produces costs a real person real money and leaves no record of it.
export function stripeReady(env) {
  return !!(env && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

// A completed session is only money when Stripe says the payment is settled. 'no_payment_required'
// is a zero-value session, which our checkout refuses upstream, but if one ever arrives it is
// settled by definition and must not be left hanging.
const SETTLED = new Set(["paid", "no_payment_required"]);

export function sessionIsPaid(session) {
  return SETTLED.has(String(session && session.payment_status || ""));
}

// The whole decision, as data. `fulfil` means mark the item sold and the order paid. `cancel`
// means the order will never complete. `wait` means a real payment is in flight and the answer
// comes in a later event — the order stays pending and the item stays on the shelf.
export function webhookAction(event) {
  const type = String(event && event.type || "");
  const s = (event && event.data && event.data.object) || {};
  const item_id = (s.metadata && s.metadata.item_id) || null;
  const session_id = s.id || null;
  const email = (s.customer_details && s.customer_details.email) || null;
  // When an order has to be refunded, the owner needs to find the payment in Stripe. The
  // session id is not searchable there; the payment intent is the thing with a page. It comes
  // back as a string id, or expanded into an object, depending on the event.
  const pi = s.payment_intent;
  const payment_intent = typeof pi === "string" ? pi : (pi && pi.id) || null;
  const base = { type, item_id, session_id, email, payment_intent };

  switch (type) {
    case "checkout.session.completed":
      if (sessionIsPaid(s)) return { ...base, do: "fulfil" };
      // Deliberately not a cancel. The buyer has committed and the bank is moving; cancelling
      // here would put the item back on the shelf and then sell it twice.
      return { ...base, do: "wait", reason: "payment is still processing" };
    case "checkout.session.async_payment_succeeded":
      return { ...base, do: "fulfil" };
    case "checkout.session.async_payment_failed":
      return { ...base, do: "cancel", reason: "the payment failed" };
    case "checkout.session.expired":
      return { ...base, do: "cancel", reason: "the checkout expired" };
    default:
      return { ...base, do: "ignore" };
  }
}

// Fulfilment can fail for a reason that is nobody's mistake: the thing sold on the shop floor
// between the buyer opening checkout and the bank confirming. There is exactly one honest
// answer, and it is not silence. The money is real and it is not ours.
export const NEEDS_REFUND_NOTE =
  "Paid, but the item had already sold in the shop. Refund this buyer in Stripe.";

export function fulfilResult(itemWasAvailable) {
  return itemWasAvailable
    ? { status: "paid", note: null, sold: true }
    : { status: "needs_refund", note: NEEDS_REFUND_NOTE, sold: false };
}

// An order the owner has to act on, as opposed to one that is merely finished or dead.
const OPEN = new Set(["paid", "needs_refund"]);
export function needsAttention(order) {
  if (!order || !OPEN.has(String(order.status))) return false;
  return order.status === "needs_refund" || !order.fulfilled_at;
}
