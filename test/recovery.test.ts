// The recovery list and its storage-network copy, through every root (spec 2026-09-20 unit B).
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. The list is how somebody gets their files back without
//    us; a business that holds the key — or holds only a token — must be able to hand it over and
//    switch its copy on exactly as a person holding the key can.
//
// ⛔ THE FILE IS THE COMMAND LINE'S FILE. With the clock and the engine's randomness held still the
//    SDK's bytes must equal the command-line package's own `makeRecoveryList`, which `nmts
//    recovery-list` writes byte for byte (`cli/test/recovery-library.test.ts`).
//
// ⛔ THE PROOF IS READ OFF THE WIRE. The fake refuses the three recovery doors without the account
//    code's proof, as the server does for an API key and a delegation token alike.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { makeRecoveryList, registrationProofOf } from "@needmoretruth/nmts-cli/portable";

import { authSecretOf, openRecoveryList, startFakeRecovery, type FakeRecovery } from "../../cli/test/fake-recovery.ts";
import { serveThreeFiles, writeHeld } from "../../cli/test/recovery-bytes-fixture.ts";
import { Nmts } from "../src/index.ts";
import { generateCode, KEY } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let fake: FakeRecovery;
before(async () => {
  fake = await startFakeRecovery();
});
after(() => fake.close());

/** A fresh account on the fake, with the three files every run serves. */
async function account(): Promise<string> {
  fake.reset();
  const code = await generateCode();
  await serveThreeFiles(fake, code);
  return code;
}

for (const { name, root, opens } of rootsUnderTest()) {
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: fake.base, network: "testnet" });

  test(`[${name}] the recovery list is the command line's file, and the server is told its number`, async () => {
    const code = await account();
    const nmts = client(code);
    const proof = await authSecretOf(code);
    // The library first: it records nothing, so the SDK after it offers the same number.
    const made = await writeHeld(async () =>
      makeRecoveryList({
        server: fake.base,
        bearer: KEY,
        code,
        accountId: (await registrationProofOf(code)).accountId,
        network: "testnet",
        accountProof: proof,
      }),
    );
    const list = await writeHeld(() => nmts.recoveryList());
    assert.equal(opens(), 1, "one call on the account took the key out more than once");
    assert.equal(list.filename, made.file.filename);
    assert.deepEqual(list.content, made.file.content, "the SDK's file is not the command line's file");
    assert.deepEqual({ seq: list.seq, files: list.files, missing: list.missing }, { seq: 1, files: 3, missing: [] });
    assert.equal(list.bytes, made.built.totalBytes);
    // What a person keeps opens with the key alone.
    const doc: unknown = JSON.parse(new TextDecoder().decode(list.content));
    const sealed = typeof doc === "object" && doc !== null ? Reflect.get(doc, "sealed") : undefined;
    assert.equal(typeof sealed, "string");
    assert.ok(await openRecoveryList(code, String(sealed)));
    assert.equal(fake.recorded.length, 1);
    assert.equal(Reflect.get(Object(fake.recorded[0]), "kind"), "local");
    assert.equal(Reflect.get(Object(fake.recorded[0]), "seq"), 1);
    assert.ok(fake.proofs.length > 0 && fake.proofs.every((p) => p === proof), "a recovery door went without the code's proof");
    // A second list beats the first.
    assert.equal((await nmts.recoveryList()).seq, 2);
  });

  test(`[${name}] the copy's switch reads, turns on with the code's proof, and turns off again`, async () => {
    const code = await account();
    const nmts = client(code);
    assert.deepEqual(await nmts.recoveryCopy(), { on: false, written: false });
    await nmts.setRecoveryCopy(true);
    assert.equal(fake.copyOn, true);
    assert.deepEqual(fake.proofs, [await authSecretOf(code)], "the switch moved without the code's proof");
    assert.deepEqual(await nmts.recoveryCopy(), { on: true, written: false });
    await nmts.setRecoveryCopy(false);
    assert.deepEqual(await nmts.recoveryCopy(), { on: false, written: false });
  });

  test(`[${name}] a server older than the switch read is named, not read as "off"`, async () => {
    const code = await account();
    fake.narrowRead = false;
    await assert.rejects(client(code).recoveryCopy(), /RECOVERY_COPY_UNREADABLE/);
  });
}
