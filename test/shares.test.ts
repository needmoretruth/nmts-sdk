// `share()` · `shares.received()` · `shares.get()` · `shares.sent()` · `unshare()` · `put({ shareWith })`
// against the fake drive, through every root.
//
// ⛔ THE PROPERTIES WORTH THE HARNESS: what was sent opens for the recipient and names the sender's
//    code; a received file comes back at the length the SENDER sealed, not the stored one; a
//    delegation token shares only with the `share` bit and the code's proof (the fake drive
//    refuses by the server's own table); and a share that fails after an upload leaves the upload.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { AAD, DERIVED, fromBase64Url, loadCrypto, shareKeysAt, toBase64Url } from "@needmoretruth/nmts-cli/portable";

import { openReceived, sealShare, shareKeysOf } from "../../cli/src/share.ts";

import { testConfigDir } from "../../cli/src/credentials.ts";
import { delegationRefusals } from "../../cli/test/fake-delegation.ts";
import { Nmts, NmtsError, ShareAfterUploadError } from "../src/index.ts";
import { withShares } from "../src/nmts/uploading.ts";
import { bytesSource, putSource, type UploadRail } from "../src/put.ts";
import { openAccount } from "../src/session.ts";
import {
  apiThat,
  entry,
  generateCode,
  KEY,
  partsOf,
  protocolThat,
  publicCodesState as codes,
  sealFile,
  startFakeAggregator,
  startFakeDrive,
  withSandbox,
  type FakeAggregator,
  type FakeDrive,
} from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
let aggregator: FakeAggregator;
before(async () => {
  drive = await startFakeDrive();
  aggregator = await startFakeAggregator();
});
after(() => {
  drive.close();
  aggregator.close();
});

const ITEM = "31111111-2222-3333-4444-555555555555";
const REAL = new TextEncoder().encode("a memo for one other account");

/**
 * The account's memo, a recipient whose code is published, and this account's own code 0 published
 * the way its business would publish a Platform user's: a token cannot read the code list, so the
 * library finds the live one at the public lookup.
 */
async function setUp(code: string): Promise<{ recipientCode: string; recipient: string }> {
  const sealed = await sealFile(code, [REAL], REAL.length);
  await drive.serve(code, [
    entry({ id: ITEM, name: "memo.txt", size: REAL.length, dekWrapped: sealed.dekWrapped, contentHashCt: sealed.contentHashCt }),
  ]);
  const crypt = await loadCrypto();
  const recipientCode = await generateCode();
  const r = shareKeysOf(crypt, recipientCode);
  codes.recipients.set(toBase64Url(r.address), toBase64Url(r.identity));
  const mine = shareKeysAt(crypt, code, 0);
  codes.recipients.set(toBase64Url(mine.address), toBase64Url(mine.identity));
  const recipient = r.display;
  r.wipe();
  mine.wipe();
  return { recipientCode, recipient };
}

/** The file key and whole-file hash a sealed file carries, opened with the account's data key. */
async function keysOf(code: string, sealed: { dekWrapped: string; contentHashCt: string }): Promise<{ dek: Uint8Array; digest: Uint8Array }> {
  const crypt = await loadCrypto();
  const derived = crypt.kdf_derive(crypt.account_code_parse(code));
  const dataKey = derived.slice(DERIVED.dataKey[0], DERIVED.dataKey[1]);
  const open = (aad: string, ct: string): Uint8Array => crypt.envelope_open(dataKey, new TextEncoder().encode(aad), fromBase64Url(ct));
  return { dek: open(AAD.dekWrap, sealed.dekWrapped), digest: open(AAD.contentHash, sealed.contentHashCt) };
}

for (const { name, root, opens } of rootsUnderTest()) {
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet", aggregators: [aggregator.base] });

  test(`[${name}] a share opens for the recipient, names the sender's code, and is withdrawn by id`, async () => {
    await withSandbox(drive, `sdk-share-${name}`, async (code) => {
      const { recipientCode, recipient } = await setUp(code);
      delegationRefusals.length = 0;
      const sent = await client(code).share("memo.txt", recipient);
      assert.equal(opens(), 1, "one share took the key out more than once");
      assert.deepEqual([sent.id, sent.name, sent.recipient, sent.fromIndex], ["sh-new", "memo.txt", recipient, 0]);
      const posted = codes.sharesPosted[0];
      assert.ok(posted !== undefined, "nothing was posted");
      const crypt = await loadCrypto();
      const mine = shareKeysAt(crypt, code, 0);
      const opened = openReceived(crypt, shareKeysOf(crypt, recipientCode), {
        id: "sh-new",
        item_id: ITEM,
        size: 1,
        sender_public_key: toBase64Url(mine.identity),
        created_at: "2026-11-10T00:00:00Z",
        dek_share_ct: String(posted["dek_share_ct"]),
        name_share_ct: String(posted["name_share_ct"]),
        content_hash_share_ct: String(posted["content_hash_share_ct"]),
      });
      assert.equal(opened.name, "memo.txt");
      assert.equal(opened.size, REAL.length);
      assert.equal(opened.sender, mine.display);
      mine.wipe();
      opened.dek?.fill(0);
      if (name === "delegation") {
        // ⛔ The token could not read its own code list, and the library found the live code anyway.
        assert.deepEqual(delegationRefusals, ["GET /v1/account/public-codes DELEGATION_SCOPE"]);
      }
      await client(code).unshare("sh-new");
      assert.deepEqual(codes.unshared, ["sh-new"]);
    });
  });

  test(`[${name}] received shares open, and one comes back at the sender's length, in memory and on disk`, async () => {
    await withSandbox(drive, `sdk-receive-${name}`, async (code) => {
      const crypt = await loadCrypto();
      const sender = shareKeysOf(crypt, await generateCode());
      const mine = shareKeysAt(crypt, code, 0);
      // The stored stream is sealed from MORE bytes than the file has, as padding makes it.
      const padded = new Uint8Array(REAL.length + 64);
      padded.set(REAL, 0);
      const stored = await sealFile(code, [padded], REAL.length);
      const { dek, digest } = await keysOf(code, stored);
      const payload = sealShare(crypt, {
        keys: sender,
        recipientIdentity: mine.identity,
        recipientAddress: mine.address,
        dek,
        itemId: ITEM,
        name: "from-them.txt",
        size: REAL.length,
        digest,
      });
      codes.received = [
        { id: "sh-9", item_id: ITEM, size: 999, sender_public_key: toBase64Url(sender.identity), to_index: 0, created_at: "2026-11-10T00:00:00Z", ...payload },
      ];
      codes.shareParts.set("sh-9", partsOf(stored, 999));
      aggregator.blobs.clear();
      for (const p of stored.parts) aggregator.blobs.set(p.blobId, p.sealed);

      const listed = await client(code).shares.received();
      assert.equal(listed.total, 1);
      assert.deepEqual(
        listed.shares.map((s) => [s.id, s.name, s.size, s.sender, s.problem]),
        [["sh-9", "from-them.txt", REAL.length, sender.display, null]],
      );
      const inMemory = await client(code).shares.get("sh-9");
      assert.deepEqual(inMemory.bytes, REAL, "the padding the sender added was written into the file");
      assert.equal(inMemory.sender, sender.display);
      const to = join(testConfigDir(`sdk-receive-${name}`), "got.txt");
      const onDisk = await client(code).shares.get("sh-9", to);
      assert.equal(onDisk.size, REAL.length);
      assert.deepEqual(new Uint8Array(readFileSync(to)), REAL);
      sender.wipe();
      mine.wipe();
    });
  });

  test(`[${name}] who a file was shared with comes back in the code's readable form`, async () => {
    await withSandbox(drive, `sdk-sent-${name}`, async (code) => {
      const { recipient } = await setUp(code);
      const crypt = await loadCrypto();
      const address = toBase64Url(crypt.share_address_parse(recipient));
      drive.sentShares = [{ id: "sh-1", item_id: ITEM, recipient_address: address, created_at: "2026-11-09T12:00:00Z" }];
      assert.deepEqual(await client(code).shares.sent("memo.txt"), [
        { id: "sh-1", recipient, createdAt: "2026-11-09T12:00:00Z", fromIndex: 0, recipientRevoked: false },
      ]);
    });
  });

  test(`[${name}] put with shareWith shares after the upload, and a failed share leaves the upload and says so`, async () => {
    await withSandbox(drive, `sdk-put-share-${name}`, async (code) => {
      const { recipient } = await setUp(code);
      const opened = openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
      const rail = async (): Promise<UploadRail> => ({ api: apiThat().api, protocol: protocolThat(), relayUrl: "https://relay.example", currentEpoch: 40 });
      const put = () => putSource(opened, bytesSource(REAL), "memo.txt", {}, rail);
      const done = await withShares(opened, [recipient], put);
      assert.ok(!done.dryRun);
      assert.deepEqual(done.shares?.map((s) => s.recipient), [recipient]);

      for (const [address] of codes.recipients) codes.recipients.set(address, "revoked");
      const before = codes.sharesPosted.length;
      await assert.rejects(withShares(opened, [recipient], put), (error: unknown) => {
        assert.ok(error instanceof ShareAfterUploadError, String(error));
        assert.match(error.message, /was uploaded, but sharing it with/);
        assert.equal(error.failedFor, recipient);
        assert.deepEqual(error.shared, []);
        return true;
      });
      assert.equal(codes.sharesPosted.length, before, "a share was posted to a revoked code");
      const written = await drive.lastWritten(code);
      assert.ok(written.some((e) => e.name === "memo (2).txt"), "the upload did not stay when its share failed");
    });
  });
}

test("put with a mistyped code in shareWith refuses before anything is read or sent", async () => {
  await withSandbox(drive, "sdk-put-share-typo", async (code) => {
    const before = drive.calls.length;
    await assert.rejects(
      new Nmts(rootsUnderTest()[0]?.root({ accountCode: code, apiKey: KEY }) ?? assert.fail(), { server: drive.base, network: "testnet" }).put(
        { name: "memo.txt", bytes: REAL },
        { shareWith: ["NOT-A-CODE"] },
      ),
      (error: unknown) => error instanceof NmtsError,
    );
    assert.equal(drive.calls.length, before, "a request left before the code was checked");
  });
});

test("a Heavy put with a mistyped code in shareWith refuses before anything is read or sent", async () => {
  // ⛔ HEAVY TOOK THE OPTION AND DROPPED IT. `shareWith` was read on the Standard road only, so a
  //    Heavy upload stored the file and shared it with nobody, and said nothing.
  await withSandbox(drive, "sdk-put-share-heavy-typo", async (code) => {
    const before = drive.calls.length;
    await assert.rejects(
      new Nmts(rootsUnderTest()[0]?.root({ accountCode: code, apiKey: KEY }) ?? assert.fail(), { server: drive.base, network: "testnet" }).put(
        { name: "memo.txt", bytes: REAL },
        { tier: "heavy", shareWith: ["NOT-A-CODE"] },
      ),
      (error: unknown) => error instanceof NmtsError,
    );
    assert.equal(drive.calls.length, before, "a request left before the code was checked");
  });
});
