// Buying a storage resource with no file, against the fake drive and a chain table.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. The purchase derives the paying wallet from the account's
//    key and signs with it, so a key held by a business must buy exactly what a person's own does.
//
// ⚠ WHAT THEY DO NOT PROVE. No transaction is built or executed here: the shape handed to the
//   signer and the order are what is held. The chain accepted the same shape on testnet
//   (2026-11-10, HYV2R8TngnpBF8omF68a8fXr9G1yTrq7X8Vfk9vzJs9s), and `put(…, { storage: id })`
//   wrote a file into the resource it made.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { generateBusinessKeys, mintDelegation, NmtsError, toBase64Url, walletAddress } from "@needmoretruth/nmts-cli/portable";
import type { BuyReads, StorageOpShape } from "@needmoretruth/nmts-cli/storage-control";

import { deviceRoot } from "../src/root.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { buyStorageResource } from "../src/storage-buy.ts";
import { KEY, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

const MIB = 1024 * 1024;
const DIGEST = "HYV2R8TngnpBF8omF68a8fXr9G1yTrq7X8Vfk9vzJs9s";

/** Testnet's numbers that day: epoch 577, 3735 FROST per MiB per epoch. */
function chain(over: { wal?: bigint } = {}): BuyReads & { dryRuns: StorageOpShape[]; senders: string[] } {
  const dryRuns: StorageOpShape[] = [];
  const senders: string[] = [];
  return {
    dryRuns,
    senders,
    async readWindow() {
      return { clock: { current: 577, durationMs: 86_400_000, startedMs: 0 }, maxAhead: 53 };
    },
    async price(sizeBytes, epochs) {
      return BigInt(Math.ceil(sizeBytes / MIB)) * 3735n * BigInt(epochs);
    },
    async readWallet() {
      return { sui: { read: true, baseUnits: 4_000_000_000n }, wal: { read: true, baseUnits: over.wal ?? 1_000_000_000n } };
    },
    async walrusPackageId() {
      return "0xpkg";
    },
    walType: () => "0xwal::wal::WAL",
    systemObjectId: () => "0xsystem",
    async dryRun(shape, sender) {
      dryRuns.push(shape);
      senders.push(sender);
      return { feeMist: 2_500_877n, refusal: null };
    },
    async createdResource() {
      return "0x587a";
    },
  };
}

/** A signer that answers the digest, and remembers which wallet was asked to sign what. */
function signer(): { sign: (input: { wallet: number; shape: StorageOpShape }) => Promise<string>; asked: { wallet: number; shape: StorageOpShape }[] } {
  const asked: { wallet: number; shape: StorageOpShape }[] = [];
  return { asked, sign: async (input) => (asked.push({ wallet: input.wallet, shape: input.shape }), DIGEST) };
}

for (const { name, root, opens } of rootsUnderTest()) {
  const account = (code: string): Opened => openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] ⛔ buyStorage({ dryRun }) prices the exact shape from the account's wallet and signs nothing`, async () => {
    await withSandbox(drive, `sdk-buy-dry-${name}`, async (code) => {
      await drive.serve(code, []);
      const reads = chain();
      const sign = signer();
      const review = await buyStorageResource(account(code), { sizeBytes: 70_254_592, epochs: 3, dryRun: true }, { reads: () => reads, signStorage: sign.sign });
      assert.equal(review.dryRun, true);
      if (!review.dryRun) return;
      assert.deepEqual(
        { sizeBytes: review.sizeBytes, epochs: review.epochs, startEpoch: review.startEpoch, endEpoch: review.endEpoch, wal: review.wal, sui: review.sui, shortfall: review.shortfall },
        { sizeBytes: 70_254_592, epochs: 3, startEpoch: 577, endEpoch: 580, wal: String(67n * 3735n * 3n), sui: "2500877", shortfall: null },
      );
      assert.equal(review.wallet.address, await walletAddress(code));
      assert.deepEqual(reads.senders, [review.wallet.address], "the dry run was not run as the account's wallet");
      assert.equal(sign.asked.length, 0, "a dry run reached the signer");
      assert.equal(opens(), 1, "one purchase took the key out more than once");
    });
  });

  test(`[${name}] buyStorage() signs the purchase as the account's wallet and names the new resource`, async () => {
    await withSandbox(drive, `sdk-buy-${name}`, async (code) => {
      await drive.serve(code, []);
      const sign = signer();
      const done = await buyStorageResource(account(code), { sizeBytes: 8 * MIB }, { reads: () => chain(), signStorage: sign.sign });
      assert.equal(done.dryRun, false);
      if (done.dryRun) return;
      assert.deepEqual(
        { id: done.id, digest: done.digest, epochs: done.epochs, endEpoch: done.endEpoch, wal: done.wal },
        { id: "0x587a", digest: DIGEST, epochs: 2, endEpoch: 579, wal: String(8n * 3735n * 2n) },
      );
      assert.deepEqual(sign.asked, [{ wallet: 0, shape: { kind: "buy", sizeBytes: 8 * MIB, epochs: 2, priceFrost: 8n * 3735n * 2n, walType: "0xwal::wal::WAL", systemObjectId: "0xsystem" } }]);
    });
  });

  test(`[${name}] ⛔ a wallet short of WAL is refused before anything is signed, and the chain is not asked`, async () => {
    await withSandbox(drive, `sdk-buy-short-${name}`, async (code) => {
      await drive.serve(code, []);
      const reads = chain({ wal: 5n });
      const sign = signer();
      await assert.rejects(buyStorageResource(account(code), { sizeBytes: 8 * MIB }, { reads: () => reads, signStorage: sign.sign }), NmtsError);
      assert.equal(sign.asked.length, 0);
      assert.deepEqual(reads.dryRuns, []);
    });
  });
}

test("a delegation token without storage_spend is refused before anything is signed, and its dry run still prices", async () => {
  const business = generateBusinessKeys();
  const delegation = mintDelegation({
    business: toBase64Url(new Uint8Array(16).fill(1)),
    user: toBase64Url(new Uint8Array(16).fill(2)),
    privateKey: business.privateKey,
    scope: ["files_read", "files_write"],
    ttlSecs: 3_600,
  });
  await withSandbox(drive, "sdk-buy-scope", async (code) => {
    await drive.serve(code, []);
    const opened = openAccount(deviceRoot({ accountCode: code, delegation }), { server: drive.base, network: "testnet" });
    const sign = signer();
    await assert.rejects(buyStorageResource(opened, { sizeBytes: 8 * MIB }, { reads: () => chain(), signStorage: sign.sign }), (error: unknown) => {
      assert.ok(error instanceof NmtsError);
      assert.match(error.message, /DELEGATION_SCOPE/);
      assert.match(String(error.nextStep), /storage_spend/);
      return true;
    });
    assert.equal(sign.asked.length, 0, "WAL left the wallet under a token that may not spend");
    const review = await buyStorageResource(opened, { sizeBytes: 8 * MIB, dryRun: true }, { reads: () => chain(), signStorage: sign.sign });
    assert.equal(review.dryRun, true);
  });
});
