// The pure parts of the payment recipes in `examples/money/`: the webhook signature checks, the
// Monero digest login, and the ledger's arithmetic. The parts that talk to a chain ran on testnet
// (plan 2026-11-10 §1.5); these are the parts a mistake in would be silent.
//
// ⚠ STRIPE AND BTCPAY PUBLISH NO TEST VECTORS. Their headers are made here by the recipe each
//   documents (Stripe: HMAC-SHA256 of `${t}.${body}`; BTCPay: `sha256=` + HMAC-SHA256 of the body),
//   which is what Stripe's own library does in `generateTestHeaderString`. What is held is the
//   refusals: a changed body, a wrong secret, an old timestamp, a downgraded scheme. The digest
//   login is checked against the worked example RFC 2617 §3.5 publishes.

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { btcpayPayment, verifyBtcpaySignature } from "../examples/money/btcpay.mjs";
import { extendCustomers } from "../examples/money/auto-extend.mjs";
import { allowanceFor, Ledger, mibEpochsOf } from "../examples/money/ledger.mjs";
import { confirmedTotal, digestAuthorization } from "../examples/money/monero.mjs";
import { stripePayment, verifyStripeSignature } from "../examples/money/stripe.mjs";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { payment_status: "paid", client_reference_id: "user-1", amount_total: 500, currency: "usd" } },
});
const NOW = 1_762_790_000_000;
const T = Math.floor(NOW / 1000);
const v1 = (body: string, t = T, secret = SECRET): string => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

test("Stripe: a header made by Stripe's recipe passes; a changed body, a wrong secret or an old one does not", () => {
  assert.equal(verifyStripeSignature(BODY, `t=${T},v1=${v1(BODY)}`, SECRET, { now: NOW }), true);
  assert.equal(verifyStripeSignature(Buffer.from(BODY), `t=${T},v1=${v1(BODY)}`, SECRET, { now: NOW }), true, "raw bytes refused");
  assert.equal(verifyStripeSignature(BODY.replace("500", "50000"), `t=${T},v1=${v1(BODY)}`, SECRET, { now: NOW }), false);
  assert.equal(verifyStripeSignature(BODY, `t=${T},v1=${v1(BODY, T, "whsec_other")}`, SECRET, { now: NOW }), false);
  // Six minutes old: outside the five minutes Stripe's libraries allow.
  assert.equal(verifyStripeSignature(BODY, `t=${T - 360},v1=${v1(BODY, T - 360)}`, SECRET, { now: NOW }), false);
  // The timestamp is signed: moving it forward breaks the signature.
  assert.equal(verifyStripeSignature(BODY, `t=${T + 1},v1=${v1(BODY)}`, SECRET, { now: NOW }), false);
});

test("Stripe: only v1 counts, any one of several may match, and rolled secrets are tried in turn", () => {
  const good = v1(BODY);
  assert.equal(verifyStripeSignature(BODY, `t=${T},v0=${good}`, SECRET, { now: NOW }), false, "a v0 signature was accepted");
  assert.equal(verifyStripeSignature(BODY, `t=${T},v1=${"0".repeat(64)},v1=${good}`, SECRET, { now: NOW }), true);
  assert.equal(verifyStripeSignature(BODY, `t=${T},v1=${good}`, ["whsec_old", SECRET], { now: NOW }), true);
  for (const header of [undefined, "", `v1=${good}`, `t=abc,v1=${good}`, `t=${T},v1=zz`]) {
    assert.equal(verifyStripeSignature(BODY, header, SECRET, { now: NOW }), false, `accepted ${String(header)}`);
  }
  assert.equal(verifyStripeSignature(BODY, `t=${T},v1=${good}`, SECRET, { now: NOW, toleranceSeconds: 0 }), false, "a zero tolerance turned the check off");
});

test("Stripe: a paid Checkout Session becomes a payment, anything else pays for nothing", () => {
  assert.deepEqual(stripePayment(JSON.parse(BODY)), { eventId: "stripe:evt_1", customer: "user-1", amount: 500, currency: "usd" });
  assert.equal(stripePayment({ ...JSON.parse(BODY), type: "payment_intent.created" }), null);
  const unpaid = JSON.parse(BODY);
  unpaid.data.object.payment_status = "unpaid";
  assert.equal(stripePayment(unpaid), null);
});

test("BTCPay: sha256= and the body's HMAC passes; anything else does not; the amount is read back from the invoice", async () => {
  const body = JSON.stringify({ type: "InvoiceSettled", invoiceId: "inv1", storeId: "s1" });
  const sig = `sha256=${createHmac("sha256", "btcpay-secret").update(body).digest("hex")}`;
  assert.equal(verifyBtcpaySignature(body, sig, "btcpay-secret"), true);
  assert.equal(verifyBtcpaySignature(body + " ", sig, "btcpay-secret"), false);
  assert.equal(verifyBtcpaySignature(body, sig, "other"), false);
  assert.equal(verifyBtcpaySignature(body, sig.replace("sha256=", "sha1="), "btcpay-secret"), false);
  const asked: string[] = [];
  const fakeFetch = async (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    asked.push(`${url} ${init.headers["authorization"]}`);
    return new Response(JSON.stringify({ amount: "12.5", currency: "USD", metadata: { buyerId: "user-1" } }));
  };
  const payment = await btcpayPayment(JSON.parse(body), { url: "https://pay.example", apiKey: "k", storeId: "s1", fetch: fakeFetch });
  assert.deepEqual(payment, { eventId: "btcpay:inv1", customer: "user-1", amount: 1250n, currency: "USD" });
  assert.deepEqual(asked, ["https://pay.example/api/v1/stores/s1/invoices/inv1 token k"]);
  assert.equal(await btcpayPayment({ type: "InvoiceCreated", invoiceId: "x" }, { url: "", apiKey: "", storeId: "", fetch: fakeFetch }), null);
});

test("Monero: the digest login matches RFC 2617's worked example; only confirmed transfers count", () => {
  const header = digestAuthorization('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"', {
    user: "Mufasa",
    pass: "Circle Of Life",
    method: "GET",
    uri: "/dir/index.html",
    cnonce: "0a4f113b",
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  const transfers = [{ amount: 400, confirmations: 12 }, { amount: "600", confirmations: 10 }, { amount: 1000, confirmations: 3 }];
  assert.equal(confirmedTotal(transfers, 10), 1000n);
  assert.equal(confirmedTotal(transfers, 0), 2000n);
});

test("the ledger: a payment credits once however often it is sent, each signature is charged, and the limit holds", () => {
  const ledger = new Ledger();
  const rates = { usd: { mibEpochsPerUnit: [1, 1], suiMistPerUnit: [100_000_000, 1] } };
  assert.deepEqual(allowanceFor(5, "USD", rates), { mibEpochs: 5, suiMist: 500_000_000n });
  assert.throws(() => allowanceFor(5, "eur", rates), /no rate/);
  assert.deepEqual(ledger.credit({ eventId: "e1", customer: "u", ...allowanceFor(5, "usd", rates) }), { credited: true });
  assert.deepEqual(ledger.credit({ eventId: "e1", customer: "u", mibEpochs: 5, suiMist: 1n }), { credited: false, why: "already credited" });
  // The D5 run: a 1 MiB file seals to 2 MiB; 2 MiB × 2 epochs is 4 of the 5 paid for.
  const register = { bytes: 2 * 1024 * 1024, epochs: 2, suiMist: "4975382" };
  const certify = { bytes: 0, epochs: 0, suiMist: "2030598" };
  assert.equal(mibEpochsOf(register), 4);
  assert.equal(mibEpochsOf({ bytes: 1, epochs: 3, suiMist: "0" }), 3, "a partial MiB was not rounded up");
  assert.equal(mibEpochsOf(certify), 0);
  assert.deepEqual(ledger.charge("u", register), { ok: true, need: 4 });
  assert.deepEqual(ledger.charge("u", certify), { ok: true, need: 0 });
  assert.deepEqual(ledger.status("u"), { customer: "u", mibEpochsLeft: 1, suiMistLeft: String(500_000_000 - 4_975_382 - 2_030_598), unpaid: false });
  // The same upload again is over what is left: refused, and nothing is charged.
  assert.deepEqual(ledger.judge("u", register), { ok: false, reason: "needs 4 MiB-epochs and u has 1 left" });
  assert.equal(ledger.charge("u", register).ok, false);
  assert.equal(ledger.status("u").mibEpochsLeft, 1);
  // SUI is limited on its own.
  assert.match(String(ledger.judge("u", { bytes: 0, epochs: 0, suiMist: "600000000" }).reason), /MIST of SUI/);
  // Unpaid stops everything until a payment or `paid` lifts it.
  ledger.setUnpaid("u", true);
  assert.deepEqual(ledger.judge("u", certify), { ok: false, reason: "u is marked unpaid" });
  ledger.credit({ eventId: "e2", customer: "u", mibEpochs: 10, suiMist: 0n });
  assert.equal(ledger.judge("u", register).ok, true, "a new payment did not lift unpaid");
});

test("auto-extend: an unpaid customer is skipped before anything is minted; a paying one is priced, judged, extended and charged", async () => {
  const ledger = new Ledger();
  const MIB = 1024 * 1024;
  ledger.credit({ eventId: "p1", customer: "paying", mibEpochs: 100, suiMist: 100_000_000n });
  ledger.setAccount("paying", "acct-paying");
  ledger.credit({ eventId: "p2", customer: "stopped", mibEpochs: 100, suiMist: 100_000_000n });
  ledger.setAccount("stopped", "acct-stopped");
  ledger.setUnpaid("stopped", true);
  ledger.credit({ eventId: "p3", customer: "no-account", mibEpochs: 1, suiMist: 1n });

  const minted: string[] = [];
  const business = {
    async delegate(order: { user: string; scope: string[] }): Promise<string> {
      assert.deepEqual(order.scope, ["files_read", "storage_spend"]);
      minted.push(order.user);
      return `token-for-${order.user}`;
    },
  };
  const file = { itemId: "f1", code: null, reason: null, epochs: 2, bytes: 3 * MIB, endEpoch: 10, newEndEpoch: 12, wal: "900", sui: "2000000" };
  const runs: { token: string; dryRun: boolean }[] = [];
  const nmts = {
    async extendFor(token: string, options: { dryRun?: boolean }) {
      runs.push({ token, dryRun: options.dryRun === true });
      const outcome = options.dryRun === true ? "priced" : "extended";
      return { files: [{ ...file, outcome, digest: outcome === "extended" ? "D1" : null }], wal: "900", sui: "2000000", stopped: null };
    },
  };
  const lines: string[] = [];
  await extendCustomers({ nmts, business, ledger, epochs: 2, log: (line: string) => lines.push(line) });

  assert.deepEqual(minted, ["acct-paying"], "a token was minted for a customer marked unpaid");
  assert.deepEqual(runs, [
    { token: "token-for-acct-paying", dryRun: true },
    { token: "token-for-acct-paying", dryRun: false },
  ]);
  assert.equal(ledger.status("paying").mibEpochsLeft, 100 - 3 * 2, "the extension was not charged");
  assert.ok(lines.some((l) => /skip stopped: marked unpaid/.test(l)));
  assert.ok(lines.some((l) => /paying: extended f1 from epoch 10 to 12/.test(l)));
});
