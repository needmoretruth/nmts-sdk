// The operator's server: payments in, a ledger, and a signature for a customer's upload only when
// the transaction is Walrus work within the limits AND the customer has paid for it.
// Node built-ins and the SDK only.
//
//   NMTS_ACCOUNT_CODE_FILE, NMTS_API_KEY_FILE   the OPERATOR's account; its wallet pays
//   NMTS_SERVER, NMTS_NETWORK                    which NMTS server and storage network (testnet to try it)
//   SPONSOR_PORT (8787), LEDGER_FILE (./ledger.json)
//   CUSTOMER_TOKEN_SECRET                        signs the token each customer's app sends (your login issues it)
//   RATES                                        JSON: what a payment buys, see ledger.mjs (default below)
//   STRIPE_WEBHOOK_SECRET                        optional: POST /webhooks/stripe
//   BTCPAY_WEBHOOK_SECRET, BTCPAY_URL, BTCPAY_API_KEY, BTCPAY_STORE_ID   optional: POST /webhooks/btcpay
//   MONERO_RPC_URL, MONERO_RPC_LOGIN, MONERO_CONFIRMATIONS               optional: POST /invoices/monero
//
// ⛔ ORDER: the customer's token → the ledger is not marked unpaid → `nmts.sponsor()` checks the bytes
//    (sender, network, Walrus calls only, size, term, WAL, SUI) and signs → the ledger is charged
//    with what the check measured. Anything refused is logged with its code and nothing is signed.
// ⚠ Turning the money customers pay into the WAL and SUI this wallet spends is the business's own
//   treasury work. NMTS neither converts nor holds anybody's coins.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Nmts } from "@needmoretruth/nmts-sdk";

import { btcpayPayment, verifyBtcpaySignature } from "./btcpay.mjs";
import { allowanceFor, Ledger } from "./ledger.mjs";
import { MoneroWallet } from "./monero.mjs";
import { stripePayment, verifyStripeSignature } from "./stripe.mjs";

const env = process.env;
const nmts = Nmts.fromEnv();
const operator = await nmts.walletAddress();
const network = env.NMTS_NETWORK ?? "mainnet";
const ledger = Ledger.open(env.LEDGER_FILE ?? "./ledger.json");
// One US cent buys 100 MiB-epochs and 0.0002 SUI of fees: a placeholder for your own prices.
const rates = JSON.parse(env.RATES ?? '{"usd":{"mibEpochsPerUnit":[100,1],"suiMistPerUnit":[200000,1]}}');
// What one transaction may spend, whoever asks. The ledger limits each customer on top of this.
const limits = { maxBytes: 512 * 1024 * 1024, maxEpochs: 53, maxWalFrost: 2_000_000_000n, maxSuiMist: 100_000_000n };
const monero = env.MONERO_RPC_URL ? new MoneroWallet({ url: env.MONERO_RPC_URL, login: env.MONERO_RPC_LOGIN ?? null }) : null;
const invoices = new Map(); // monero subaddress index → { customer, amount }; keep these in your database

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

/** The token a customer's app sends: an HMAC of the customer id under the server's secret. */
function customerToken(customer, secret = env.CUSTOMER_TOKEN_SECRET) {
  return createHmac("sha256", secret).update(customer).digest("hex");
}
function tokenIsValid(customer, token) {
  if (typeof customer !== "string" || typeof token !== "string" || token.length !== 64) return false;
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(customerToken(customer), "hex"));
}

function credit(payment) {
  const allowance = allowanceFor(payment.amount, payment.currency, rates);
  const result = ledger.credit({ eventId: payment.eventId, customer: payment.customer, ...allowance });
  log(`credit ${payment.eventId} ${payment.customer} +${allowance.mibEpochs} MiB-epochs +${allowance.suiMist} MIST · ${result.credited ? "credited" : result.why}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const routes = {
  "GET /operator": async () => ({ address: operator, network }),
  "POST /webhooks/stripe": async (req, raw) => {
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], env.STRIPE_WEBHOOK_SECRET ?? "")) return [400, { error: "bad signature" }];
    const payment = stripePayment(JSON.parse(raw.toString("utf8")));
    if (payment !== null) credit(payment);
    return { received: true };
  },
  "POST /webhooks/btcpay": async (req, raw) => {
    if (!verifyBtcpaySignature(raw, req.headers["btcpay-sig"], env.BTCPAY_WEBHOOK_SECRET ?? "")) return [400, { error: "bad signature" }];
    const payment = await btcpayPayment(JSON.parse(raw.toString("utf8")), { url: env.BTCPAY_URL, apiKey: env.BTCPAY_API_KEY, storeId: env.BTCPAY_STORE_ID });
    if (payment !== null) credit(payment);
    return { received: true };
  },
  "POST /invoices/monero": async (req, raw) => {
    const { customer, token, piconero } = JSON.parse(raw.toString("utf8"));
    if (monero === null || !tokenIsValid(customer, token)) return [403, { error: "refused" }];
    const invoice = await monero.newInvoice(`${customer} ${new Date().toISOString()}`);
    invoices.set(invoice.index, { customer, amount: BigInt(piconero) });
    return { address: invoice.address };
  },
  "POST /sign": async (req, raw) => {
    const { customer, token, bytes } = JSON.parse(raw.toString("utf8"));
    if (!tokenIsValid(customer, token)) return [403, { error: "refused" }];
    const before = ledger.status(customer);
    if (before.unpaid) {
      log(`refuse ${customer}: marked unpaid · nothing signed`);
      return [402, { error: `${customer} is marked unpaid` }];
    }
    // The check runs inside nmts.sponsor() before any key is used; here it is run first as well,
    // so the ledger can judge what the transaction would spend before anything is signed.
    const verdict = await Nmts.checkSponsored(bytes, { ...limits, network, operator });
    if (!verdict.ok) {
      log(`refuse ${customer}: ${verdict.code} ${verdict.reason} · nothing signed`);
      return [403, { error: verdict.code, reason: verdict.reason }];
    }
    const fits = ledger.judge(customer, verdict.spends);
    if (!fits.ok) {
      log(`refuse ${customer}: LEDGER ${fits.reason} · nothing signed`);
      return [402, { error: "LEDGER", reason: fits.reason }];
    }
    const signed = await nmts.sponsor(bytes, limits);
    ledger.charge(customer, signed.spends);
    const left = ledger.status(customer);
    log(`sign ${customer}: ${signed.spends.calls.join("+")} · ${signed.spends.bytes} bytes × ${signed.spends.epochs} epochs · WAL ${signed.spends.walFrost} FROST · SUI ≤ ${signed.spends.suiMist} MIST · left ${left.mibEpochsLeft} MiB-epochs`);
    return { bytes: signed.bytes, signature: signed.signature };
  },
};

createServer(async (req, res) => {
  const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  let status = 200;
  let answer;
  try {
    if (route === undefined) [status, answer] = [404, { error: "no such route" }];
    else {
      const out = await route(req, await readBody(req));
      [status, answer] = Array.isArray(out) ? out : [200, out];
    }
  } catch (error) {
    log(`error ${req.method} ${req.url}: ${error.message}`);
    [status, answer] = [500, { error: error.message }];
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
}).listen(Number(env.SPONSOR_PORT ?? 8787), "127.0.0.1", () => log(`operator ${operator} on ${network} · listening on ${env.SPONSOR_PORT ?? 8787}`));

// Monero invoices are paid when their transfers have enough confirmations; checked every minute.
if (monero !== null) {
  setInterval(async () => {
    for (const [index, invoice] of invoices) {
      const got = await monero.received(index, Number(env.MONERO_CONFIRMATIONS ?? 10)).catch(() => 0n);
      if (got >= invoice.amount) {
        credit({ eventId: `monero:${index}`, customer: invoice.customer, amount: got, currency: "xmr" });
        invoices.delete(index);
      }
    }
  }, 60_000).unref();
}
