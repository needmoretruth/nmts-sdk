// `extendFor` — a business's server extending a user's files from its own wallet, with the user's
// delegation token and no key of the user's.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. The OPERATOR's account is the one opened through a root:
//    its key derives the wallet that pays and signs, and a key held somewhere else would show up
//    here first. The USER is only ever a token.
//
// ⛔ THE SIGNERS COUNT. A blob the paying wallet does not hold, a file not due, a file in the trash:
//    each is a row that says so, and none of them reaches a signer.
//
// ⚠ WHAT THEY DO NOT PROVE. No transaction is built or executed — that is the testnet run in
//   `docs/judgments/2026-11-11-operator-extend.md`. What is held here is the order, which files are
//   bought, what is said about the rest, and what the server is told.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { generateBusinessKeys, mintDelegation, NmtsError, toBase64Url, walletAddress, type ScopeName } from "@needmoretruth/nmts-cli/portable";

import { extendForUser } from "../src/extend-for.ts";
import { deviceRoot } from "../src/root.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { fakeChain, KEY, recordingSigner, refuseToSign, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

const BUSINESS = generateBusinessKeys();

/** A user's token, as the business mints it. */
function userToken(scope: ScopeName[] = ["files_read", "storage_spend"]): string {
  return mintDelegation({
    business: toBase64Url(new Uint8Array(16).fill(1)),
    user: toBase64Url(new Uint8Array(16).fill(9)),
    privateKey: BUSINESS.privateKey,
    scope,
    ttlSecs: 3_600,
  });
}

const ELSEWHERE = `0x${"ab".repeat(32)}`;

/** One preview naming one blob, the shape the server sends. */
function previewOf(objectId: string, endEpoch: number): unknown {
  return {
    item_id: "x",
    targets: [{ sui_object_id: objectId, storage_kind: 0, expiry_epoch: endEpoch, shared_items: 1 }],
    treasury_parts: 0,
    untracked_parts: 0,
  };
}

/**
 * The user's account as the server holds it: two files due on blobs the operator holds, one due on a
 * blob another wallet holds, one far from its end, one in the trash.
 */
function serveUser(operator: string): ReturnType<typeof fakeChain> {
  const leases = [
    { objectId: "0xdue-1", size: 1_000_000, endEpoch: 1202, holder: { kind: "address" as const, address: operator } },
    { objectId: "0xdue-2", size: 500_000, endEpoch: 1201, holder: { kind: "address" as const, address: operator } },
    { objectId: "0xtheirs", size: 1_000, endEpoch: 1202, holder: { kind: "address" as const, address: ELSEWHERE } },
    { objectId: "0xfar", size: 1_000, endEpoch: 1240, holder: { kind: "address" as const, address: operator } },
  ];
  drive.objects = ["due-1", "due-2", "theirs", "far", "binned"];
  drive.objectsTrashed.add("binned");
  drive.extendPreviews.set("due-1", previewOf("0xdue-1", 1202));
  drive.extendPreviews.set("due-2", previewOf("0xdue-2", 1201));
  drive.extendPreviews.set("theirs", previewOf("0xtheirs", 1202));
  drive.extendPreviews.set("far", previewOf("0xfar", 1240));
  return fakeChain({ leases });
}

for (const { name, root, opens } of rootsUnderTest()) {
  const operatorAccount = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] ⛔ a dry run prices what a real run would buy, says why the rest are left, and signs nothing`, async () => {
    await withSandbox(drive, `sdk-extend-for-dry-${name}`, async (code) => {
      await drive.serve(code, []);
      const chain = serveUser(await walletAddress(code, 0));
      const sign = refuseToSign("a dry run reached the signer");
      const result = await extendForUser(operatorAccount(code), userToken(), { dryRun: true, epochs: 3 }, { readChain: () => chain, sign });
      assert.equal(result.dryRun, true);
      assert.deepEqual(
        result.files.map((f) => [f.itemId, f.outcome, f.code]),
        [
          ["due-1", "priced", null],
          ["due-2", "priced", null],
          ["theirs", "skipped", "EXTEND_NOT_OWNED"],
          ["far", "skipped", "EXTEND_NOT_DUE"],
          ["binned", "skipped", "EXTEND_TRASHED"],
        ],
      );
      // The fake quotes `size × epochs`: (1,000,000 + 500,000) × 3, and two fees of 0.003 SUI.
      assert.equal(result.wal, "4500000");
      assert.equal(result.sui, "6000000");
      assert.match(String(result.files[2]?.reason), new RegExp(ELSEWHERE));
      assert.equal(result.stopped, null);
      assert.equal(sign.calls, 0, "a dry run reached the signer");
      assert.deepEqual(drive.extendRecorded, [], "a dry run told the server about an extension");
      assert.equal(opens(), 1, "one run took the operator's key out more than once");
    });
  });

  test(`[${name}] it buys each due file in its own transaction and records it on the user's account`, async () => {
    await withSandbox(drive, `sdk-extend-for-${name}`, async (code) => {
      await drive.serve(code, []);
      const chain = serveUser(await walletAddress(code, 0));
      const sign = recordingSigner();
      const result = await extendForUser(operatorAccount(code), userToken(), { epochs: 2 }, { readChain: () => chain, sign });
      assert.equal(result.dryRun, false);
      assert.deepEqual(sign.asked, [
        { objectIds: ["0xdue-1"], epochs: 2 },
        { objectIds: ["0xdue-2"], epochs: 2 },
      ]);
      assert.deepEqual(drive.extendRecordedFor, ["due-1", "due-2"], "one record per file, against that file");
      assert.deepEqual(
        result.files.filter((f) => f.outcome === "extended").map((f) => [f.itemId, f.endEpoch, f.newEndEpoch]),
        [
          ["due-1", 1202, 1204],
          ["due-2", 1201, 1203],
        ],
      );
      assert.equal(result.stopped, null);
      assert.equal(opens(), 1);
    });
  });
}

test("⛔ a user's token without storage_spend is refused before anything is read or signed", async () => {
  await withSandbox(drive, "sdk-extend-for-scope", async (code) => {
    await drive.serve(code, []);
    serveUser(await walletAddress(code, 0));
    const opened = openAccount(deviceRoot({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
    const sign = refuseToSign("a token that cannot record an extension reached the signer");
    await assert.rejects(
      extendForUser(opened, userToken(["files_read"]), {}, { readChain: () => fakeChain(), sign }),
      (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.match(error.message, /^DELEGATION_SCOPE:/);
        assert.match(error.message, /storage_spend/);
        return true;
      },
    );
    assert.equal(sign.calls, 0);
  });
});

test("⛔ a wallet known to be short stops the run before the first signature, and says where to send", async () => {
  await withSandbox(drive, "sdk-extend-for-short", async (code) => {
    await drive.serve(code, []);
    const operator = await walletAddress(code, 0);
    serveUser(operator);
    const leases = [{ objectId: "0xdue-1", size: 1_000_000, endEpoch: 1202, holder: { kind: "address" as const, address: operator } }];
    const opened = openAccount(deviceRoot({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
    const sign = refuseToSign("a wallet known to be short signed");
    const result = await extendForUser(opened, userToken(), { items: ["due-1"] }, {
      readChain: () => fakeChain({ leases, wallet: { wal: 1n } }),
      sign,
    });
    assert.equal(result.stopped?.code, "EXTEND_SHORTFALL");
    assert.match(String(result.stopped?.reason), new RegExp(operator));
    assert.equal(sign.calls, 0);
    assert.deepEqual(drive.extendRecorded, []);
  });
});

test("a recording that fails stops the run with the digest, so nobody pays for the same file twice", async () => {
  await withSandbox(drive, "sdk-extend-for-late", async (code) => {
    await drive.serve(code, []);
    const chain = serveUser(await walletAddress(code, 0));
    drive.extendRecordFails = true;
    const opened = openAccount(deviceRoot({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
    const sign = recordingSigner();
    const result = await extendForUser(opened, userToken(), {}, { readChain: () => chain, sign });
    assert.equal(sign.asked.length, 1, "it went on paying for files the server would not record");
    assert.equal(result.stopped?.code, "EXTEND_RECORDED_LATE");
    assert.match(String(result.stopped?.reason), /Do not extend it again/);
    const paid = result.files[0];
    assert.equal(paid?.outcome, "extended", "a file that was paid for is reported as anything else");
    assert.ok(typeof paid?.digest === "string" && String(result.stopped?.reason).includes(paid.digest), "the digest is not named");
  });
});
