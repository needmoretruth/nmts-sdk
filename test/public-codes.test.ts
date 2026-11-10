// The account's public codes through every root: list, create, revoke, derive.
//
// ⛔ THE CODES ARE THE KEY'S, WHOEVER HOLDS IT. Each verb is walked through the device root, the
//    managed root and a delegated identity, and each call must borrow the key exactly once — the
//    rule that makes the verb the same for a person's own program and a business holding keys.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { generateBusinessKeys, loadCrypto, mintDelegation, shareKeysAt, toBase64Url } from "@needmoretruth/nmts-cli/portable";

// ⚠ Sealing a share is not a library call; the test seals one the way `nmts share` does.
import { sealShare } from "../../cli/src/share.ts";
import { Nmts, ServerError } from "../src/index.ts";
import { deviceRoot } from "../src/root.ts";
import { generateCode, KEY, publicCodesState, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

// ⛔ A DELEGATION TOKEN REACHES THESE DOORS with its `share` bit and the code's proof, and
//    the fake drive asks for both by the server's own table, so its row passes only when both go.
for (const { name, root, opens } of rootsUnderTest()) {
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] create publishes the next number, list reads them back, identityFor derives one offline`, async () => {
    await withSandbox(drive, `sdk-codes-${name}`, async (code) => {
      const nmts = client(code);
      const first = await nmts.publicCodes.create();
      assert.equal(opens(), 1, "one call borrowed the key more than once");
      const second = await nmts.publicCodes.create();
      assert.deepEqual([first.index, second.index], [0, 1]);
      const crypt = await loadCrypto();
      const zero = shareKeysAt(crypt, code, 0);
      assert.equal(first.code, zero.display, "code 0 is not the code this key has always had");
      assert.equal(publicCodesState.posts[0]?.address, toBase64Url(zero.address));
      zero.wipe();

      const listed = await nmts.publicCodes.list();
      assert.deepEqual(
        listed.codes.map((c) => [c.index, c.default, c.revokedAt]),
        [[0, true, null], [1, false, null]],
      );
      assert.equal(listed.live, 2);
      assert.equal(listed.liveMax, 3);
      const offline = await nmts.publicCodes.identityFor(1);
      assert.deepEqual(offline, { index: 1, code: second.code, address: second.address });
    });
  });

  test(`[${name}] a replacement revokes in the same request, revoke is for good, and the last live code stays`, async () => {
    await withSandbox(drive, `sdk-codes-revoke-${name}`, async (code) => {
      const nmts = client(code);
      await nmts.publicCodes.create();
      const replaced = await nmts.publicCodes.create({ replace: 0 });
      assert.deepEqual([replaced.index, replaced.revoked], [1, 0]);
      assert.deepEqual(publicCodesState.posts[1]?.revoke, [0]);
      await assert.rejects(nmts.publicCodes.revoke(1), (error: unknown) => {
        assert.ok(error instanceof ServerError, `refused as ${String(error)}`);
        assert.equal(error.code, "LAST_LIVE_CODE");
        return true;
      });
      await nmts.publicCodes.create();
      await nmts.publicCodes.revoke(1);
      assert.deepEqual(publicCodesState.revokes, [1]);
      const listed = await nmts.publicCodes.list();
      assert.deepEqual(listed.codes.map((c) => [c.index, c.revokedAt === null]), [[2, true], [0, false], [1, false]]);
    });
  });

  test(`[${name}] list with activity opens each received share with the code it came to`, async () => {
    await withSandbox(drive, `sdk-codes-activity-${name}`, async (code) => {
      const nmts = client(code);
      await nmts.publicCodes.create();
      await nmts.publicCodes.create();
      const crypt = await loadCrypto();
      const sender = shareKeysAt(crypt, await generateCode(), 0);
      const mine = shareKeysAt(crypt, code, 1);
      const payload = sealShare(crypt, {
        keys: sender,
        recipientIdentity: mine.identity,
        recipientAddress: mine.address,
        dek: crypt.generate_dek(),
        itemId: "f1",
        name: "plan.txt",
        size: 4,
        digest: new Uint8Array(32).fill(3),
      });
      publicCodesState.received = [
        { id: "sh-1", item_id: "f1", size: 9, sender_public_key: toBase64Url(sender.identity), to_index: 1, created_at: "2026-09-24T00:00:00Z", ...payload },
      ];
      const before = opens();
      const listed = await nmts.publicCodes.list({ activity: true });
      assert.equal(opens() - before, 1, "listing with activity borrowed the key more than once");
      const one = listed.codes.find((c) => c.index === 1);
      assert.deepEqual(one?.activity?.received.map((r) => [r.name, r.sender]), [["plan.txt", sender.display]]);
      assert.deepEqual(listed.codes.find((c) => c.index === 0)?.activity, { sent: [], received: [] });
      sender.wipe();
      mine.wipe();
    });
  });
}

/**
 * ⛔ THE BIT IS THE BUSINESS'S TO GIVE. A token minted without `share` hears the server's
 * `DELEGATION_SCOPE` on all three doors, and `identityFor` still derives offline.
 */
test("a delegation token without the share bit is refused by the server on list, create and revoke", async () => {
  const delegation = mintDelegation({
    business: toBase64Url(new Uint8Array(16).fill(1)),
    user: toBase64Url(new Uint8Array(16).fill(2)),
    privateKey: generateBusinessKeys().privateKey,
    scope: ["files_read", "files_write"],
    ttlSecs: 3_600,
  });
  await withSandbox(drive, "sdk-codes-unscoped", async (code) => {
    const nmts = new Nmts(deviceRoot({ accountCode: code, delegation }), { server: drive.base, network: "testnet" });
    const refused = (error: unknown): boolean => error instanceof ServerError && error.code === "DELEGATION_SCOPE";
    await assert.rejects(nmts.publicCodes.list(), refused);
    await assert.rejects(nmts.publicCodes.create(), refused);
    await assert.rejects(nmts.publicCodes.revoke(0), refused);
    assert.deepEqual(publicCodesState.posts, [], "a token without the bit published a code");
    const crypt = await loadCrypto();
    const keys = shareKeysAt(crypt, code, 2);
    assert.equal((await nmts.publicCodes.identityFor(2)).code, keys.display);
    keys.wipe();
  });
});
