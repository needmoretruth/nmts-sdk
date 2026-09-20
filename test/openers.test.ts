// Wallet sign-in through every root — and the one root it refuses by name.
//
// ⛔ EVERY VERB THROUGH EVERY ROOT is the key-holder law, and openers are where it has a boundary
//    written INTO it: a person's own wallet is a road to a key this process holds, and a managed
//    root's key is held by a business whose sealed store is already that road. So the registry's
//    third row runs the round trip and the managed row proves the refusal — which is the law being
//    kept rather than broken, and is the reason that refusal has a name a program can branch on.
//
// ⛔ AND THE PROOF IS READ OFF THE WIRE. The three account doors refuse a credential that arrives
//    without the account code's own proof, whichever root it came from; the fake refuses it the
//    same way, so a verb that forgot it fails here.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { Nmts, NmtsError } from "../src/index.ts";
import { KEY, openerState, startFakeDrive, testWallet, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

/** ⚠ The wallet is the command-line package's fixture: a real keypair, signing real bytes. */
const wallet = testWallet;

for (const { name, root, opens } of rootsUnderTest()) {
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  if (name === "managed") {
    test(`[${name}] every opener verb refuses by name, before the store is opened`, async () => {
      await withSandbox(drive, `sdk-openers-${name}`, async (code) => {
        const nmts = client(code);
        for (const [what, run] of [
          ["list", () => nmts.openers.list()],
          ["addWallet", () => nmts.openers.addWallet(wallet())],
          ["remove", () => nmts.openers.remove("Zm9vYmFyZm9vYmFyZm9vYmFy")],
          ["exportSlot", () => nmts.openers.exportSlot("Zm9vYmFyZm9vYmFyZm9vYmFy")],
        ] as const) {
          await assert.rejects(run(), (error: unknown) => {
            assert.ok(error instanceof NmtsError, `${what} was refused as something else`);
            assert.match(error.message, /NOT_FOR_MANAGED_ROOT/);
            return true;
          });
        }
        // ⛔ NOTHING WAS OPENED AND NOTHING WAS SENT. A business's sealed store opened for a call
        //    that was never going to happen is the cost this package counts.
        assert.equal(opens(), 0, "the managed store was opened for a refused call");
        assert.deepEqual(openerState.calls, [], "a refused call reached the server");
      });
    });
    continue;
  }

  test(`[${name}] a wallet is attached, opens the account again, and is taken off`, async () => {
    await withSandbox(drive, `sdk-openers-${name}`, async (code) => {
      const nmts = client(code);
      const signer = wallet();
      const attached = await nmts.openers.addWallet(signer);
      assert.equal(attached.kind, "wallet");
      assert.equal(opens(), 1, "one call on the account took the key out more than once");
      assert.ok(openerState.calls.at(-1)?.proof, "the attach travelled without the account proof");

      assert.deepEqual((await nmts.openers.list()).map((o) => [o.locator, o.kind]), [[attached.locator, "wallet"]]);

      // ⛔ THE WHOLE POINT, READ BACK THROUGH THE PUBLIC DOOR: the same wallet, and no code typed.
      const opened = await Nmts.fromWallet({ ...signer, apiKey: KEY, server: drive.base, network: "testnet" });
      assert.deepEqual(await opened.account(), await nmts.account());

      // The recovery tool's file: the sealed bytes, by name, with no credential at all.
      assert.equal((await nmts.openers.exportSlot(attached.locator)).length, 62);

      await nmts.openers.remove(attached.locator);
      assert.deepEqual(await nmts.openers.list(), []);
      await assert.rejects(
        Nmts.fromWallet({ ...signer, apiKey: KEY, server: drive.base, network: "testnet" }),
        /NO_OPENER_FOR_WALLET/,
        "a removed wallet still opened the account",
      );
    });
  });
}

test("a client made from a wallet speaks with whichever credential it was given", async () => {
  const delegated = rootsUnderTest().find((r) => r.name === "delegation");
  assert.ok(delegated, "the registry no longer has a delegation root");
  await withSandbox(drive, "sdk-openers-delegated", async (code) => {
    const signer = wallet();
    // Attached through the delegation root, whose token carries `files_write`.
    const nmts = new Nmts(delegated.root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
    const attached = await nmts.openers.addWallet(signer);
    const asked = openerState.calls.at(-1);
    assert.ok(asked?.bearer?.startsWith("nmts_dt1_"), "the attach did not travel under the delegation token");
    assert.ok(asked.proof, "the attach travelled without the account code's proof");

    // ⛔ AND A CLIENT MADE FROM THAT WALLET CARRIES THE TOKEN IT WAS HANDED, not the account's key:
    //    which credential the server answers to is the caller's decision, as it is everywhere else.
    const token = delegated.root({ accountCode: code, apiKey: KEY }).identity;
    assert.equal(token.kind, "delegation");
    const opened = await Nmts.fromWallet({
      ...signer,
      delegation: token.kind === "delegation" ? token.token : "",
      server: drive.base,
      network: "testnet",
    });
    assert.deepEqual(await opened.account(), await nmts.account());

    // ⛔ ON A DEVICE THAT HAS NEVER SEEN THIS ACCOUNT the page cannot name the user a token is for
    //    until the wallet has opened the account — so the token may be a function of that id.
    const askedFor: string[] = [];
    const late = await Nmts.fromWallet({
      ...signer,
      delegation: (user) => {
        askedFor.push(user);
        return token.kind === "delegation" ? token.token : "";
      },
      server: drive.base,
      network: "testnet",
    });
    assert.deepEqual(askedFor, [await Nmts.accountIdOf(code)]);
    assert.deepEqual(await late.account(), await nmts.account());

    await opened.openers.remove(attached.locator);
    assert.ok(openerState.calls.at(-1)?.bearer?.startsWith("nmts_dt1_"), "the removal dropped the token");
  });
});

test("a wallet nothing was attached to is told so, and no account is made up for it", async () => {
  await withSandbox(drive, "sdk-openers-stranger", async () => {
    await assert.rejects(
      Nmts.fromWallet({ ...wallet(), apiKey: KEY, server: drive.base, network: "testnet" }),
      (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.match(error.message, /NO_OPENER_FOR_WALLET/);
        return true;
      },
    );
  });
});
