// `pay: { signer }` — paying for storage with a wallet this package holds no key to.
//
// ⛔ WHAT THESE ARE WRITTEN TO CATCH. The one thing that decides whether this rail is safe is WHICH
//    ADDRESS the price is measured against: a run that quoted the wallet this NMTS key derives and
//    then asked somebody's extension to sign would refuse every upload a funded extension could
//    afford, and would tell a short wallet to send coins to an address its owner has never seen. So
//    every test below reads the address out of the review and holds it against both wallets.
//
// ⚠ WHAT THEY DO NOT PROVE. No transaction is built, signed or submitted here. What one wallet is
//   asked for, what is submitted, and what happens when it declines are held in the command-line
//   package's `wallet-sign-external.test.ts`, where the chain is a fake and the wallet is a
//   function; whether a real wallet signs what a real node accepts cannot be known without
//   spending SUI.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { NmtsError, walletAddress } from "@needmoretruth/nmts-cli";

import type { ExternalSigner } from "../src/pay.ts";
import { bytesSource } from "../src/put.ts";
import { putSourceWithWallet } from "../src/put-wallet.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { extendFile, storageResources } from "../src/storage.ts";
import {
  fakeChain,
  fakeReads,
  KEY,
  refuseToSign,
  servePhoto,
  startFakeDrive,
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

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** An address no NMTS key derives: 64 hex characters of one digit. */
const PAYER = `0x${"7".repeat(64)}`;

/** A wallet that would sign, and says whether it was ever asked. */
function signerThat(address = PAYER): ExternalSigner & { asked: number } {
  const wallet = {
    asked: 0,
    address,
    async signTransaction(input: { bytes: Uint8Array; chain: string }) {
      wallet.asked += 1;
      return { bytes: input.bytes, signature: "signed" };
    },
  };
  return wallet;
}

for (const { name, root, opens } of rootsUnderTest()) {
  /** This sandbox's account, opened with the key wherever this root keeps it. */
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] ⛔ a signer's own address is what the price, the balances and the review name`, async () => {
    await withSandbox(drive, `sdk-put-signer-dry-${name}`, async (code) => {
      await drive.serve(code, []);
      const signer = signerThat();
      // ⛔ NO SIGNING SEAM AND NO CHAIN. A dry run on this rail asks nothing of the wallet and does
      //    not even load the module that could: what it needs is the price of the wallet it names.
      const review = await putSourceWithWallet(
        account(code),
        bytesSource(BYTES),
        "notes.txt",
        { pay: { signer }, dryRun: true },
        { readChain: () => fakeReads() },
      );
      assert.equal(review.dryRun, true, "a dry run uploaded");
      if (!review.dryRun) return;
      assert.equal(review.wallet.address, PAYER, "the price was measured against another wallet");
      assert.notEqual(
        review.wallet.address,
        await walletAddress(code, 0),
        "the wallet this key derives was priced while somebody else's wallet was to sign",
      );
      assert.equal(review.paid, "wallet");
      assert.equal(review.credits, 0, "a wallet-paid upload counted credits");
      assert.equal(review.shortfall, null, "a wallet the fake filled reported a shortfall");
      assert.equal(signer.asked, 0, "a dry run asked the wallet to sign");
    });
  });

  test(`[${name}] the derived-wallet rail is untouched: \`pay: "wallet"\` still prices this key's own wallet`, async () => {
    await withSandbox(drive, `sdk-put-signer-derived-${name}`, async (code) => {
      await drive.serve(code, []);
      const review = await putSourceWithWallet(
        account(code),
        bytesSource(BYTES),
        "notes.txt",
        { pay: "wallet", dryRun: true },
        { readChain: () => fakeReads() },
      );
      assert.equal(review.dryRun, true);
      if (!review.dryRun) return;
      assert.equal(review.wallet.address, await walletAddress(code, 0));
      assert.notEqual(review.wallet.address, PAYER);
    });
  });

  test(`[${name}] a signer-paid upload goes up on the wallet rail, taking no credits and buying no reservation`, async () => {
    await withSandbox(drive, `sdk-put-signer-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      // The two signatures are the seam a test drives this rail through — the same seam the
      // derived-wallet tests use — so what is held here is the rail, not the chain.
      const { seams, sign, calls, pushed } = walletSeams();
      const result = await putSourceWithWallet(
        opened,
        bytesSource(BYTES),
        "notes.txt",
        { pay: { signer: signerThat() }, partSize: 4 },
        seams,
      );
      assert.equal(result.dryRun, false, "a run that was not asked to stop reported a review");
      if (result.dryRun) return;
      assert.equal(result.paid, "wallet");
      assert.equal(result.credits, 0);
      assert.equal(sign.registered.length, result.parts, "a part went up without being registered");
      assert.equal(sign.certified.length, result.parts, "a registered part was not certified");
      assert.equal(calls.reserve, 0, "a wallet-paid part asked the server to sell it storage");
      assert.notEqual(pushed.last, null, "nothing reached the relay");
      const written = await drive.lastWritten(code);
      assert.ok(
        written.some((e) => e.name === "notes.txt" && e.id === result.id),
        "the file was paid for and the sealed list does not name it",
      );
      assert.equal(opens(), 1, "one upload took the key out more than once");
    });
  });

  test(`[${name}] ⛔ two payers in one call, and an address that is not one, are refused before the key is taken out`, async () => {
    await withSandbox(drive, `sdk-put-signer-refuse-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const both = await putSourceWithWallet(
        opened,
        bytesSource(BYTES),
        "notes.txt",
        { pay: { signer: signerThat() }, wallet: 2 },
        {},
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(both instanceof NmtsError, "an upload with two payers was allowed to run");
      assert.match(both.message, /^TWO_PAYERS: /);
      assert.equal(both.exitCode, 2);

      for (const address of ["0x123", `0x${"7".repeat(63)}`, "not-an-address", `${"7".repeat(64)}`]) {
        const failure = await putSourceWithWallet(
          opened,
          bytesSource(BYTES),
          "notes.txt",
          { pay: { signer: signerThat(address) } },
          {},
        ).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof NmtsError, `the address ${address} was accepted`);
        assert.match(failure.message, /^PAYER_ADDRESS: /);
        assert.equal(failure.exitCode, 2);
      }
      // ⛔ REFUSED BEFORE ANYTHING WAS OPENED, so a business's sealed store was not unsealed for a
      //    call that was never going to run.
      assert.equal(opens(), 0, "a call with no payer to speak of took the key out");
    });
  });

  test(`[${name}] extend and the storage listing follow the same wallet`, async () => {
    await withSandbox(drive, `sdk-extend-signer-${name}`, async (code) => {
      await servePhoto(drive, code);
      const opened = account(code);
      const signer = signerThat();
      const sign = refuseToSign("a dry run reached the signer");
      const review = await extendFile(
        opened,
        "photos/a.jpg",
        { epochs: 4, dryRun: true, pay: { signer } },
        { readChain: () => fakeChain(), sign },
      );
      assert.equal(review.dryRun, true, "a dry run bought storage");
      if (!review.dryRun) return;
      // ⛔ THE WALLET THAT PAID IS THE WALLET THAT EXTENDS. Pricing the account's own wallet here
      //    would read a balance nobody is going to spend from, and the blobs belong to the payer.
      assert.equal(review.wallet.address, PAYER, "an extension priced a wallet that holds no storage");
      assert.equal(sign.calls, 0, "a dry run reached the signer");

      const held = await storageResources(
        opened,
        { pay: { signer } },
        {
          readStorage: async (_network, address) => {
            assert.equal(address, PAYER, "the resources of another wallet were listed");
            return { items: [], currentEpoch: 12 };
          },
        },
      );
      assert.deepEqual(held, []);
    });
  });
}
