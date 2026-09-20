// Storage control, against the fake drive and the command-line package's own chain fakes: what the
// wallet holds, buying a file more time, and cutting, joining and handing over a resource.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. These five verbs derive the wallet from the account's key
//    and sign with it, so they are where a key held somewhere else would show up first — and the
//    one of them that reaches the server needs a scope an API key does not have, which is exactly
//    the axis the registry's third row varies.
//
// ⛔ THE CHAIN AND THE SIGNATURES ARE SEAMS, AND THE SIGNERS COUNT. "Nothing was signed" is a
//    number here rather than an absence of noise: a dry run that reached a signer fails, and so
//    does a refusal that reached one.
//
// ⚠ WHAT THEY DO NOT PROVE. No transaction is built, signed or executed. The order, the arithmetic
//   and the shapes handed to the signer are what is held; whether the chain accepts them cannot be
//   known without spending real WAL.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import {
  generateBusinessKeys,
  mintDelegation,
  NmtsError,
  toBase64Url,
} from "@needmoretruth/nmts-cli/portable";
import type { StorageOpShape, StorageOpsReads } from "@needmoretruth/nmts-cli/storage-control";

import { deviceRoot } from "../src/root.ts";
import { openAccount, type Opened } from "../src/session.ts";
import {
  extendFile,
  mergeStorageResources,
  splitStorageResource,
  storageResources,
  transferStorageResource,
  type StorageSeams,
} from "../src/storage.ts";
import {
  fakeChain,
  KEY,
  recordingSigner,
  refuseToSign,
  servePhoto,
  startFakeDrive,
  withSandbox,
  type FakeDrive,
} from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

/** Four resources one wallet holds, the shapes the contract's rules turn on. */
const A = { objectId: "0xa", sizeBytes: 4 * 1024 ** 3, startEpoch: 10, endEpoch: 20 };
const B = { objectId: "0xb", sizeBytes: 1024 ** 3, startEpoch: 10, endEpoch: 20 };
const C = { objectId: "0xc", sizeBytes: 4 * 1024 ** 3, startEpoch: 20, endEpoch: 30 };
const D = { objectId: "0xd", sizeBytes: 2 * 1024 ** 3, startEpoch: 25, endEpoch: 30 };
const TO = `0x${"cd".repeat(32)}`;

/** A chain that answers the four above, prices every shape the same, and remembers what it priced. */
function opsReads(over: { refusal?: string } = {}): {
  reads: () => StorageOpsReads;
  dryRuns: StorageOpShape[];
} {
  const dryRuns: StorageOpShape[] = [];
  return {
    dryRuns,
    reads: () => ({
      async readStorage() {
        return { items: [A, B, C, D], currentEpoch: 12 };
      },
      async walrusPackageId() {
        return "0xpkg";
      },
      async dryRun(shape: StorageOpShape) {
        dryRuns.push(shape);
        return over.refusal === undefined
          ? { feeMist: 1_500_000n, refusal: null }
          : { feeMist: null, refusal: over.refusal };
      },
    }),
  };
}

/** A signer that answers a digest and remembers every shape it was handed. */
function opSigner(): { sign: StorageSeams["signStorage"]; shapes: StorageOpShape[] } {
  const shapes: StorageOpShape[] = [];
  return {
    shapes,
    sign: async (input: { shape: StorageOpShape }): Promise<string> => {
      shapes.push(input.shape);
      return OP_DIGEST;
    },
  };
}

const OP_DIGEST = "7qWmRt3zKx9LbN2vYd5FgHj8ApZc4Se6UvXn1WqMh2B";

/** A signer for a storage change that fails the test by being called. */
function refuseOpSign(what: string): { sign: StorageSeams["signStorage"]; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    sign: async (): Promise<string> => {
      calls += 1;
      throw new Error(what);
    },
  };
}

for (const { name, root, opens } of rootsUnderTest()) {
  /** This sandbox's account, opened with the key wherever this root keeps it. */
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] storage() lists the paying wallet's free resources, usable first, each with where it stands`, async () => {
    await withSandbox(drive, `sdk-storage-list-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const held = await storageResources(
        opened,
        {},
        { readStorage: async () => ({ items: [A, B, C, D], currentEpoch: 12 }) },
      );
      assert.deepEqual(
        held.map((r) => [r.id, r.status]),
        [
          ["0xa", "usable"],
          ["0xb", "usable"],
          ["0xc", "notYet"],
          ["0xd", "notYet"],
        ],
        "not usable-first, largest-first, or a status was invented",
      );
      assert.deepEqual(held[0], { id: "0xa", sizeBytes: A.sizeBytes, startEpoch: 10, endEpoch: 20, status: "usable" });
      assert.equal(opens(), 1, "one question about the wallet took the key out more than once");
    });
  });

  test(`[${name}] ⛔ extend({ dryRun }) prices it and reaches neither a signer nor the server`, async () => {
    await withSandbox(drive, `sdk-extend-dry-${name}`, async (code) => {
      await servePhoto(drive, code);
      const sign = refuseToSign("a dry run reached the signer");
      const review = await extendFile(
        account(code),
        "photos/a.jpg",
        { epochs: 4, dryRun: true },
        { readChain: () => fakeChain(), sign },
      );
      assert.equal(review.dryRun, true, "a dry run bought storage");
      if (!review.dryRun) return;
      // The fake quotes `size × epochs` base units over both blobs: (1,000,000 + 500,000) × 4.
      assert.deepEqual(
        { wal: review.wal, sui: review.sui, epochs: review.epochs, endEpoch: review.endEpoch },
        { wal: "6000000", sui: "3000000", epochs: 4, endEpoch: 1206 },
      );
      assert.match(review.wallet.address, /^0x[0-9a-f]{64}$/);
      assert.equal(review.shortfall, null, "a wallet the fake filled reported a shortfall");
      assert.equal(sign.calls, 0, "a dry run reached the signer");
      assert.equal(drive.extendRecorded.length, 0, "a dry run told the server about an extension");
    });
  });

  test(`[${name}] extend() signs for the blobs the server named and the server records the digest`, async () => {
    await withSandbox(drive, `sdk-extend-${name}`, async (code) => {
      await servePhoto(drive, code);
      const opened = account(code);
      const sign = recordingSigner();
      const result = await extendFile(opened, "photos/a.jpg", { epochs: 3 }, { readChain: () => fakeChain(), sign });
      assert.equal(result.dryRun, false, "a run that was not asked to stop reported a review");
      if (result.dryRun) return;
      assert.deepEqual(sign.asked, [{ objectIds: ["0xblob-a", "0xblob-b"], epochs: 3 }]);
      assert.deepEqual(
        { epochs: result.epochs, endEpoch: result.endEpoch, recorded: result.recorded },
        { epochs: 3, endEpoch: 1205, recorded: true },
      );
      assert.deepEqual(drive.extendRecorded, [{ epochs: 3, tx_digest: result.digest }]);
      assert.equal(opens(), 1, "one extension took the key out more than once");
    });
  });

  test(`[${name}] ⛔ a file that is nowhere near its deadline is refused until force says otherwise`, async () => {
    await withSandbox(drive, `sdk-extend-early-${name}`, async (code) => {
      await servePhoto(drive, code);
      const opened = account(code);
      const far = [{ objectId: "0xblob-far", size: 1_000_000, endEpoch: 1240 }];
      drive.extendPreview = {
        item_id: "a",
        targets: far.map((l) => ({ sui_object_id: l.objectId, storage_kind: 0, expiry_epoch: l.endEpoch, shared_items: 1 })),
        treasury_parts: 0,
        untracked_parts: 0,
      };
      const chain = (): ReturnType<typeof fakeChain> => fakeChain({ leases: far });
      const no = refuseToSign("it extended a file that was not running out");
      await assert.rejects(
        extendFile(opened, "photos/a.jpg", { epochs: 2 }, { readChain: chain, sign: no }),
        (error: unknown) => {
          assert.ok(error instanceof NmtsError);
          assert.match(error.message, /EXTEND_NOT_DUE/);
          return true;
        },
      );
      assert.equal(no.calls, 0, "it signed for a file nobody said to extend early");
      // ⭐ AND `force` STILL BUYS IT. Extending early loses nothing, so this is a guard against
      //    spending by accident rather than a refusal on principle.
      const willing = recordingSigner();
      const done = await extendFile(opened, "photos/a.jpg", { epochs: 2, force: true }, { readChain: chain, sign: willing });
      assert.equal(done.dryRun, false);
      assert.equal(willing.asked.length, 1, "force did not go through with it");
    });
  });

  test(`[${name}] splitStorage says what each side would be, and signs the exact shape it priced`, async () => {
    await withSandbox(drive, `sdk-split-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const chain = opsReads();
      const refused = refuseOpSign("a dry run reached the signer");
      const review = await splitStorageResource(
        opened,
        "0xa",
        { sizeBytes: 1024 ** 3, dryRun: true },
        { reads: chain.reads, signStorage: refused.sign },
      );
      assert.equal(review.dryRun, true);
      if (!review.dryRun) return;
      assert.deepEqual(review.keeps, { sizeBytes: 1024 ** 3, startEpoch: 10, endEpoch: 20 });
      assert.deepEqual(review.creates, { sizeBytes: 3 * 1024 ** 3, startEpoch: 10, endEpoch: 20 });
      assert.deepEqual({ wal: review.wal, sui: review.sui }, { wal: "0", sui: "1500000" });
      assert.equal(refused.calls(), 0, "a dry run reached the signer");

      const signer = opSigner();
      const done = await splitStorageResource(
        opened,
        "0xa",
        { sizeBytes: 1024 ** 3 },
        { reads: chain.reads, signStorage: signer.sign },
      );
      assert.equal(done.dryRun, false);
      if (done.dryRun) return;
      // ⛔ WHAT WAS PRICED IS WHAT WAS SIGNED. One builder answers the dry run and the signature.
      assert.deepEqual(signer.shapes, [{ kind: "splitSize", objectId: "0xa", keepBytes: 1024 ** 3 }]);
      assert.deepEqual(chain.dryRuns, signer.shapes.concat(signer.shapes));
      assert.equal(done.digest, OP_DIGEST);
    });
  });

  test(`[${name}] ⛔ a pair the contract will not join is refused with the reason, before the chain is asked`, async () => {
    await withSandbox(drive, `sdk-merge-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const chain = opsReads();
      const signer = opSigner();
      // Same period, so the sizes add — the one join this pair is allowed.
      const done = await mergeStorageResources(opened, "0xa", "0xb", {}, { reads: chain.reads, signStorage: signer.sign });
      assert.equal(done.dryRun, false);
      if (done.dryRun) return;
      assert.deepEqual(done.becomes, { sizeBytes: 5 * 1024 ** 3, startEpoch: 10, endEpoch: 20 });
      assert.deepEqual(signer.shapes, [{ kind: "fuse", first: "0xa", second: "0xb", how: "amount" }]);

      await assert.rejects(
        mergeStorageResources(opened, "0xb", "0xd", {}, { reads: chain.reads, signStorage: signer.sign }),
        (error: unknown) => {
          assert.ok(error instanceof NmtsError);
          assert.match(error.message, /cannot be joined/);
          return true;
        },
      );
      assert.equal(signer.shapes.length, 1, "a refused pair was signed");
      assert.equal(chain.dryRuns.length, 1, "a refused pair was priced by the chain");
    });
  });

  test(`[${name}] transferStorage hands over size and time, and a bad address never reaches the chain`, async () => {
    await withSandbox(drive, `sdk-transfer-${name}`, async (code) => {
      await drive.serve(code, []);
      const opened = account(code);
      const chain = opsReads();
      const signer = opSigner();
      const done = await transferStorageResource(opened, "0xc", TO, {}, { reads: chain.reads, signStorage: signer.sign });
      assert.equal(done.dryRun, false);
      if (done.dryRun) return;
      assert.deepEqual(done.moves, { sizeBytes: 4 * 1024 ** 3, startEpoch: 20, endEpoch: 30 });
      assert.equal(done.to, TO);
      assert.deepEqual(signer.shapes, [{ kind: "transfer", objectId: "0xc", to: TO }]);

      await assert.rejects(
        transferStorageResource(opened, "0xc", "nope", {}, { reads: chain.reads, signStorage: signer.sign }),
        (error: unknown) => {
          assert.ok(error instanceof NmtsError);
          assert.equal(error.exitCode, 2);
          return true;
        },
      );
      assert.equal(signer.shapes.length, 1, "a resource went to an address that is not one");
      assert.equal(chain.dryRuns.length, 1, "an address that is not one was priced by the chain");
    });
  });
}

/**
 * ⛔ THE ONE VERB HERE THAT REACHES THE SERVER, AND THE SCOPE IT NEEDS. Recording an extension
 * asks for `storage_spend`; a token minted without it would be refused AFTER the WAL had left the
 * wallet, so the token's own scope is read before the signature. The token is in this process, so
 * there is nothing to ask anybody for.
 */
test("a delegation token without storage_spend is refused before anything is signed", async () => {
  const business = generateBusinessKeys();
  const delegation = mintDelegation({
    business: toBase64Url(new Uint8Array(16).fill(1)),
    user: toBase64Url(new Uint8Array(16).fill(2)),
    privateKey: business.privateKey,
    // Everything an extension reads, and nothing it would spend with.
    scope: ["files_read", "files_write"],
    ttlSecs: 3_600,
  });
  await withSandbox(drive, "sdk-extend-scope", async (code) => {
    await servePhoto(drive, code);
    const opened = openAccount(deviceRoot({ accountCode: code, delegation }), {
      server: drive.base,
      network: "testnet",
    });
    const sign = refuseToSign("a token that cannot record an extension signed one");
    await assert.rejects(
      extendFile(opened, "photos/a.jpg", { epochs: 2 }, { readChain: () => fakeChain(), sign }),
      (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.match(error.message, /DELEGATION_SCOPE/);
        assert.match(String(error.nextStep), /storage_spend/);
        return true;
      },
    );
    assert.equal(sign.calls, 0, "the WAL left the wallet for a record the server would refuse");
    assert.deepEqual(drive.extendRecorded, [], "an extension nothing signed was recorded");
  });
});
