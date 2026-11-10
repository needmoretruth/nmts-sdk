// A Stripe payment, turned into a ledger credit. Node built-ins only: no Stripe package.
//
// The signature check is the manual one in Stripe's documentation
// (https://docs.stripe.com/webhooks?verify=verify-manually):
//   1. split `Stripe-Signature` on "," and each element on "=": `t` is the timestamp, every `v1`
//      is a signature, every other scheme is ignored (a downgrade guard);
//   2. signed_payload = `${t}.${raw request body}`;
//   3. HMAC-SHA256 of signed_payload with the endpoint secret (`whsec_…`);
//   4. compare in constant time with each `v1`, then refuse a timestamp outside the tolerance
//      (Stripe's libraries default to 5 minutes; 0 would turn the check off, so it is refused).
// ⚠ The body must be the raw bytes Stripe sent. Parsing and re-serialising the JSON breaks it.
//
// Environment: STRIPE_WEBHOOK_SECRET (the endpoint's `whsec_…`).
// The customer is the Checkout Session's `client_reference_id`: set it to your own customer id when
// you create the session.
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_TOLERANCE_SECONDS = 300;

/** True when `header` is a valid Stripe signature of `rawBody` under one of `secrets`, made recently. */
export function verifyStripeSignature(rawBody, header, secrets, { toleranceSeconds = STRIPE_TOLERANCE_SECONDS, now = Date.now() } = {}) {
  if (typeof header !== "string" || !(toleranceSeconds > 0)) return false;
  let timestamp = null;
  const signatures = [];
  for (const element of header.split(",")) {
    const at = element.indexOf("=");
    if (at < 0) continue;
    const prefix = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (prefix === "t") timestamp = value;
    else if (prefix === "v1") signatures.push(value);
  }
  if (timestamp === null || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]);
  const matched = [secrets].flat().some((secret) => {
    const expected = createHmac("sha256", secret).update(signedPayload).digest();
    return signatures.some((sig) => {
      const given = /^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, "hex") : null;
      return given !== null && timingSafeEqual(given, expected);
    });
  });
  if (!matched) return false;
  return Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= toleranceSeconds;
}

/**
 * The payment in a verified event, or null for an event that pays for nothing.
 * `checkout.session.completed` with `payment_status: "paid"` is a paid Checkout Session.
 */
export function stripePayment(event) {
  if (event?.type !== "checkout.session.completed") return null;
  const session = event.data?.object;
  if (session?.payment_status !== "paid" || typeof session.client_reference_id !== "string") return null;
  return { eventId: `stripe:${event.id}`, customer: session.client_reference_id, amount: session.amount_total, currency: session.currency };
}
