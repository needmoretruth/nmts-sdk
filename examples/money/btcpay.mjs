// A BTCPay Server payment — Bitcoin on chain or over Lightning — turned into a ledger credit.
// Node built-ins only.
//
// BTCPay signs each webhook with the secret it showed when the webhook was made: the header
// `BTCPay-Sig` is `sha256=` and the hex HMAC-SHA256 of the raw request body
// (https://docs.btcpayserver.org/Development/GreenFieldExample-NodeJS/).
//
// Monero and Zcash reach the same webhook through BTCPay's own plugins, which add them as payment
// methods of an ordinary invoice — so an `InvoiceSettled` for an invoice paid in XMR or ZEC is
// handled here unchanged. Both plugins exist and are MIT licensed; their confirmation counts are set
// in BTCPay, not here:
//   Monero  https://github.com/btcpay-monero/btcpayserver-monero-plugin
//   Zcash   https://github.com/btcpay-zcash/btcpayserver-zcash-plugin
// Each warns that one wallet serves every store on the instance, so run your own instance.
//
// Environment: BTCPAY_WEBHOOK_SECRET, BTCPAY_URL, BTCPAY_API_KEY (a Greenfield key with
// `btcpay.store.canviewinvoices`), BTCPAY_STORE_ID. Put your customer id in the invoice's
// `metadata.buyerId` when you create it.
import { createHmac, timingSafeEqual } from "node:crypto";

/** True when `header` is BTCPay's signature of `rawBody` under `secret`. */
export function verifyBtcpaySignature(rawBody, header, secret) {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  return timingSafeEqual(Buffer.from(hex, "hex"), createHmac("sha256", secret).update(body).digest());
}

/**
 * The payment in a verified `InvoiceSettled` event, or null. The webhook carries the invoice id but
 * not its amount, so the invoice is read back with the Greenfield API.
 */
export async function btcpayPayment(event, { url, apiKey, storeId, fetch: get = fetch }) {
  if (event?.type !== "InvoiceSettled" || typeof event.invoiceId !== "string") return null;
  const res = await get(`${url}/api/v1/stores/${encodeURIComponent(storeId)}/invoices/${encodeURIComponent(event.invoiceId)}`, {
    headers: { authorization: `token ${apiKey}` },
  });
  if (!res.ok) throw new Error(`BTCPay answered ${res.status} for invoice ${event.invoiceId}`);
  const invoice = await res.json();
  const customer = invoice.metadata?.buyerId;
  if (typeof customer !== "string") return null;
  // Greenfield gives the amount as a decimal string in the invoice currency; the ledger counts the
  // smallest unit, cents for a fiat-priced invoice.
  const [whole, frac = ""] = String(invoice.amount).split(".");
  const cents = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return { eventId: `btcpay:${event.invoiceId}`, customer, amount: cents, currency: invoice.currency };
}
