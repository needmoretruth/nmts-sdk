// An operator's server signing a customer's upload: `nmts.sponsor(bytes, limits)` checks the bytes
// and signs as the account's paying wallet; `Nmts.checkSponsored` is the same check with no key.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. The operator's wallet is derived from the account's key
//    wherever that key lives, so a business that keeps its operator account in a key service must
//    sign exactly what a server holding the code itself would.
//
// ⛔ THE BYTES ARE REAL. They are the transactions a customer's device sent to an operator on
//    testnet (`cli/test/fixtures/sponsor/`), with the recording's operator address replaced by this
//    sandbox account's wallet — every other byte as the chain executed it. The chain facts are the
//    table read that day, so nothing here reaches a network.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { generateBusinessKeys, mintDelegation, NmtsError, toBase64Url, walletAddress } from "@needmoretruth/nmts-cli/portable";

import { checkSponsoredBytes } from "../src/money.ts";
import { deviceRoot } from "../src/root.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { sponsorTransaction, type SponsorLimits } from "../src/sponsor.ts";
import { ATTACKER, EXTEND, facts, OPERATOR, REGISTER, readdressed } from "../../cli/test/sponsor-fixtures.ts";
import { KEY, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

const LIMITS: SponsorLimits = { maxBytes: 512 * 1024 * 1024, maxEpochs: 53, maxWalFrost: 2_000_000_000n, maxSuiMist: 100_000_000n };
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

for (const { name, root, opens } of rootsUnderTest()) {
  const account = (code: string): Opened => openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] sponsor() signs a customer's registration as the account's wallet, and says what it spends`, async () => {
    await withSandbox(drive, `sdk-sponsor-${name}`, async (code) => {
      await drive.serve(code, []);
      const me = await walletAddress(code);
      const bytes = await readdressed(REGISTER, me);
      const signed = await sponsorTransaction(account(code), base64(bytes), LIMITS, { facts: facts() });
      assert.equal(signed.bytes, base64(bytes), "the bytes signed are not the bytes that were checked");
      // A Sui Ed25519 signature: flag 0, 64 bytes of signature, 32 of public key.
      const sig = Buffer.from(signed.signature, "base64");
      assert.equal(sig.length, 97);
      assert.equal(sig[0], 0);
      assert.deepEqual(signed.spends.calls, ["reserve_space", "register_blob"]);
      assert.equal(signed.spends.walFrost, "1060669");
      assert.equal(signed.spends.suiMist, "4975382");
      assert.equal(opens(), 1, "one signature took the key out more than once");
    });
  });

  test(`[${name}] ⛔ sponsor() refuses bytes that pay somebody else, or name another sender, before the key signs`, async () => {
    await withSandbox(drive, `sdk-sponsor-refuse-${name}`, async (code) => {
      await drive.serve(code, []);
      const me = await walletAddress(code);
      // The recording as it was: its sender is the recording's operator, not this account's wallet.
      await assert.rejects(sponsorTransaction(account(code), REGISTER, LIMITS, { facts: facts() }), /SPONSOR_REFUSED: SPONSOR_SENDER/);
      // Re-addressed, then the relay tip pointed at somebody else.
      const stolen = Buffer.from(await readdressed(REGISTER, me));
      const tip = Buffer.from(facts().relayTipAddresses[0]?.slice(2) ?? "", "hex");
      const at = stolen.indexOf(tip);
      assert.ok(at > 0, "the recorded registration lost its tip");
      Buffer.from(ATTACKER.slice(2), "hex").copy(stolen, at);
      await assert.rejects(sponsorTransaction(account(code), stolen, LIMITS, { facts: facts() }), /SPONSOR_REFUSED: SPONSOR_TRANSFER/);
      // Over the operator's own limit on the term.
      await assert.rejects(
        sponsorTransaction(account(code), await readdressed(EXTEND, me), { ...LIMITS, maxEpochs: 1 }, { facts: facts() }),
        /SPONSOR_REFUSED: SPONSOR_EPOCHS/,
      );
    });
  });
}

test("a delegation token without storage_spend cannot sponsor: refused before the check or the key", async () => {
  const business = generateBusinessKeys();
  const delegation = mintDelegation({
    business: toBase64Url(new Uint8Array(16).fill(1)),
    user: toBase64Url(new Uint8Array(16).fill(2)),
    privateKey: business.privateKey,
    scope: ["files_read", "files_write"],
    ttlSecs: 3_600,
  });
  await withSandbox(drive, "sdk-sponsor-scope", async (code) => {
    await drive.serve(code, []);
    const opened = openAccount(deviceRoot({ accountCode: code, delegation }), { server: drive.base, network: "testnet" });
    const bytes = await readdressed(REGISTER, await walletAddress(code));
    await assert.rejects(sponsorTransaction(opened, bytes, LIMITS, { facts: facts() }), (error: unknown) => {
      assert.ok(error instanceof NmtsError);
      assert.match(error.message, /DELEGATION_SCOPE/);
      return true;
    });
  });
});

test("Nmts.checkSponsored's check needs no account: the same verdict, nothing signed", async () => {
  const verdict = await checkSponsoredBytes(REGISTER, { ...LIMITS, network: "testnet", operator: OPERATOR }, { facts: facts() });
  assert.equal(verdict.ok, true);
  const refused = await checkSponsoredBytes(REGISTER, { ...LIMITS, network: "testnet", operator: ATTACKER }, { facts: facts() });
  assert.deepEqual(refused.ok ? null : refused.code, "SPONSOR_SENDER");
});
