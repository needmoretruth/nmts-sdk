// `put({ pay: "wallet" })` — the upload whose storage the account's OWN WALLET buys, driven
// through the real price-refuse-sign-push-record path against the command-line package's fakes.
//
// ⛔ WHAT THESE ARE WRITTEN TO CATCH. Everything this rail can get wrong costs money nobody can
//    get back: a signature made before the wallet was measured, a shortfall found after the first
//    signature, and a dry run that reaches a signer or a relay. The chain and both signatures are
//    seams; the signers record what they were asked, so "nothing was signed" is a number and not
//    an absence of noise.
//
// ⚠ WHAT THEY DO NOT PROVE. No transaction is built, signed or executed here. The order, the
//   arithmetic and the shapes handed to the signer are what is held; whether the chain accepts
//   them cannot be known without spending WAL.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. The code seals the file AND derives the wallet that signs,
//   so this rail is the one where a key held somewhere else would show up first. The registry in
//   `roots.ts` runs it both ways and counts how often the key is taken out for one upload.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { NmtsError, walletAddress } from "@needmoretruth/nmts-cli";

import { sealedLenFor } from "../../cli/src/seal.ts";
import { planAndPrice } from "../../cli/src/upload-price.ts";
import { bytesSource } from "../src/put.ts";
import { putSourceWithWallet } from "../src/put-wallet.ts";
import { openAccount, type Opened } from "../src/session.ts";
import {
  FEE_MIST,
  KEY,
  MAINNET,
  startFakeDrive,
  TIP,
  walletSeams,
  withSandbox,
  type FakeDrive,
} from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

/** Ten bytes — one part by default, three at `partSize: 4`, so a sum is visibly a sum. */
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** What ten bytes seal to, part by part, under the rounding rule a fresh account has. */
function sealedLensAt(partSize: number): number[] {
  const { plan, sealFor } = planAndPrice(BYTES.length, partSize, "padme");
  return plan.map((range) => sealedLenFor(sealFor(range)));
}

for (const { name, root, opens } of rootsUnderTest()) {
  /** This sandbox's account, opened with the key wherever this root keeps it. */
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] a wallet-paid put prices it, signs both signatures for every part, uploads and names the file`, async () => {
    await withSandbox(drive, `sdk-put-wallet-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const { seams, sign, calls, pushed } = walletSeams();
      const result = await putSourceWithWallet(opened, bytesSource(BYTES), "notes.txt", { pay: "wallet", partSize: 4 }, seams);
      assert.equal(result.dryRun, false, "a run that was not asked to stop reported a review");
      if (result.dryRun) return;
      // The fake quotes each part `sealedLen × epochs` of storage plus `sealedLen` of write; the
      // default term is two epochs, so every part costs three times its sealed length in WAL.
      const sealed = sealedLensAt(4);
      assert.deepEqual(
        sign.registered.map((asked) => asked.part.sealedLen),
        sealed,
        "what was signed is not what was planned",
      );
      assert.equal(sign.certified.length, sealed.length, "a registered part was not certified");
      assert.deepEqual(
        { paid: result.paid, credits: result.credits, parts: result.parts, endEpoch: result.endEpoch },
        { paid: "wallet", credits: 0, parts: sealed.length, endEpoch: MAINNET.current + 2 },
      );
      assert.equal(result.wal, sealed.reduce((sum, len) => sum + BigInt(len) * 3n, 0n).toString());
      assert.equal(result.sui, (BigInt(sealed.length) * (TIP + FEE_MIST)).toString());
      // ⛔ NO TREASURY RESERVATION WAS BOUGHT — the storage is the wallet's own — and the bytes went out.
      assert.equal(calls.reserve, 0, "a wallet-paid part asked the server to sell it storage");
      assert.equal(calls.createItem, 1);
      assert.notEqual(pushed.last, null, "nothing reached the relay");
      // ⛔ ONE UPLOAD, ONE OPENING. The same borrowed code sealed the file and derived the wallet
      //    that signed for it — not a second opening partway through something that was spending.
      assert.equal(opens(), 1, "one wallet-paid upload took the key out more than once");
      const written = await drive.lastWritten(code);
      assert.ok(
        written.some((e) => e.name === "notes.txt" && e.id === result.id),
        "the file was paid for and the sealed list does not name it",
      );
    });
  });

  test(`[${name}] ⛔ a wallet short of WAL is refused with both numbers, before any signature`, async () => {
    await withSandbox(drive, `sdk-put-wallet-short-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const { seams, sign, calls, pushed } = walletSeams({ wallet: { wal: 1n } });
      const failure = await putSourceWithWallet(opened, bytesSource(BYTES), "notes.txt", { pay: "wallet" }, seams).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof NmtsError, "a wallet holding one FROST was allowed to sign");
      assert.equal(failure.exitCode, 4);
      assert.match(failure.message, /holds 0\.000000001 WAL and this upload costs [0-9.]+ WAL/);
      assert.match(String(failure.nextStep), /Nothing was signed and nothing was sent/);
      assert.deepEqual([sign.registered.length, sign.certified.length], [0, 0], "a short wallet reached a signer");
      assert.equal(calls.createItem, 0);
      assert.equal(pushed.last, null);
      assert.deepEqual(drive.written, []);
    });
  });

  test(`[${name}] ⛔ dryRun returns the review and reaches neither a signer nor the relay`, async () => {
    await withSandbox(drive, `sdk-put-wallet-dry-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const { seams, sign, calls, pushed } = walletSeams();
      const review = await putSourceWithWallet(opened, bytesSource(BYTES), "notes.txt", { pay: "wallet", dryRun: true }, seams);
      assert.equal(review.dryRun, true, "a dry run uploaded");
      if (!review.dryRun) return;
      const [sealed] = sealedLensAt(64 * 2 ** 20);
      assert.ok(sealed !== undefined);
      assert.deepEqual(
        { paid: review.paid, credits: review.credits, bytes: review.bytes, parts: review.parts, epochs: review.epochs, endEpoch: review.endEpoch },
        { paid: "wallet", credits: 0, bytes: BYTES.length, parts: 1, epochs: 2, endEpoch: MAINNET.current + 2 },
      );
      assert.equal(review.wal, (BigInt(sealed) * 3n).toString());
      assert.equal(review.sui, (TIP + FEE_MIST).toString());
      assert.deepEqual(review.storage, { kind: "buy" });
      assert.match(review.wallet.address, /^0x[0-9a-f]{64}$/);
      assert.equal(review.shortfall, null, "a wallet the fake filled reported a shortfall");
      assert.deepEqual([sign.registered.length, sign.certified.length], [0, 0], "a dry run reached a signer");
      assert.equal(calls.createItem, 0);
      assert.equal(pushed.last, null);
      assert.deepEqual(drive.written, []);
    });
  });

  test(`[${name}] ⛔ \`wallet\` signs with the wallet it names, for this upload only`, async () => {
    await withSandbox(drive, `sdk-put-wallet-named-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const { seams, sign } = walletSeams();
      const review = await putSourceWithWallet(
        opened,
        bytesSource(BYTES),
        "notes.txt",
        { pay: "wallet", wallet: 3, dryRun: true },
        seams,
      );
      assert.equal(review.dryRun, true);
      if (!review.dryRun) return;
      // ⛔ THE ADDRESS IN THE REVIEW IS THE ADDRESS THAT WOULD SIGN. A run that priced one wallet
      //    and signed with another would spend from a balance nobody was shown.
      assert.equal(review.wallet.address, await walletAddress(code, 3));
      assert.notEqual(review.wallet.address, await walletAddress(code, 0), "the named wallet was ignored");
      assert.deepEqual([sign.registered.length, sign.certified.length], [0, 0]);
      // Naming a wallet for one upload is not the account choosing one: nothing was written.
      assert.deepEqual(drive.written, [], "naming a wallet for one upload wrote the account's list");
    });
  });

  test(`[${name}] ⛔ a wallet number that is not one is refused before the key is taken out`, async () => {
    await withSandbox(drive, `sdk-put-wallet-bad-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const { seams } = walletSeams();
      for (const asked of [1.5, -1]) {
        const failure = await putSourceWithWallet(
          opened,
          bytesSource(BYTES),
          "notes.txt",
          { pay: "wallet", wallet: asked },
          seams,
        ).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof NmtsError, `wallet ${asked} was accepted`);
        assert.equal(failure.exitCode, 2);
      }
      // ⛔ REFUSED, NEVER ROUNDED — and refused before anything was opened, so a business's sealed
      //    store was not unsealed for a call that was never going to run.
      assert.equal(opens(), 0, "a number that is not a wallet number took the key out");
    });
  });
}
