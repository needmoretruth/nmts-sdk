// `Nmts.business(...)` against the fake Platform doors, and the embedded registration beside it.
//
// ⛔ THE FAKE VERIFIES WHAT IT WAS SENT. It rebuilds the signed sentence out of the bearer, the
//    method, the path and the bytes that arrived, so every call here is a claim that this package
//    signs the request it actually makes — not a claim that it agrees with itself.
//
// ⚠ WHAT THIS FILE IS NOT. It is not `rootsUnderTest()`, and `surface.test.ts` says why: a
//   business holds no account code, so there is no key holder to vary. The credential axis is
//   walked by every verb, through the registry's third row.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { generateBusinessKeys, NmtsError, registrationProofOf, toBase64Url } from "@needmoretruth/nmts-cli/portable";

import { Nmts } from "../src/index.ts";
import { generateCode, platformState, resetPlatform, startFakeDrive, type FakeDrive } from "./helpers.ts";

let drive: FakeDrive;
const KEYS = generateBusinessKeys();
const BUSINESS_ID = toBase64Url(new Uint8Array(16).fill(11));
const USER_ID = toBase64Url(new Uint8Array(16).fill(12));

before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

/** A registered business, and a client that speaks for it. */
function business(privateKey: string = KEYS.privateKey): ReturnType<typeof Nmts.business> {
  resetPlatform();
  platformState.business = { accountId: BUSINESS_ID, publicKey: KEYS.publicKey, name: "Acme" };
  return Nmts.business({ accountId: BUSINESS_ID, privateKey, server: drive.base });
}

test("⛔ info() is signed over the request it makes, and reads back what the business is", async () => {
  const client = business();
  platformState.usersToday = 7;
  const info = await client.info();
  assert.deepEqual(info, {
    accountId: BUSINESS_ID,
    publicKey: KEYS.publicKey,
    name: "Acme",
    createdAt: "2026-09-17T00:00:00Z",
    keyChangedAt: null,
    usersToday: 7,
    usersDayCap: 1000,
  });
});

test("⛔ a key that is not the registered one is refused, and the refusal is the server's", async () => {
  const client = business(generateBusinessKeys().privateKey);
  await assert.rejects(client.info(), (error: unknown) => {
    assert.ok(error instanceof NmtsError);
    assert.match(error.message, /signature/i);
    return true;
  });
});

test("⛔ registerUser() with no argument makes the code here and hands it back once", async () => {
  const client = business();
  const made = await client.registerUser();
  assert.equal(typeof made.accountCode, "string");
  assert.equal(made.status, "active");
  const code = made.accountCode ?? "";
  const proof = await registrationProofOf(code);
  assert.equal(made.accountId, proof.accountId, "the account made is not the one that code derives");
  const [sent] = platformState.registered;
  assert.ok(sent !== undefined);
  assert.deepEqual([sent.accountId, sent.authSecret], [proof.accountId, proof.authSecret]);
  // ⛔ THE CODE ITSELF NEVER TRAVELS. What the door takes is derived from it and cannot be turned
  //    back into it.
  assert.ok(!sent.bearer.includes(code));
  assert.ok(!JSON.stringify(sent).includes(code), "the account code reached the wire");
});

test("a code the business already holds is registered without being handed back", async () => {
  const client = business();
  const code = await generateCode();
  const made = await client.registerUser({ accountCode: code });
  assert.equal(made.accountCode, undefined, "a code the caller already had was copied into the answer");
  assert.equal(made.accountId, (await registrationProofOf(code)).accountId);
});

test("the server's own ceiling arrives as the refusal it is", async () => {
  const client = business();
  platformState.usersDayCap = 0;
  await assert.rejects(client.registerUser(), /registered/);
});

test("⛔ delegate() mints a token locally, sends nothing, and refuses more than thirty days", async () => {
  const client = business();
  const before = drive.calls.length;
  const token = await client.delegate({ user: USER_ID, scope: ["files_read"], ttlSecs: 60 });
  assert.match(token, /^nmts_dt1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(drive.calls.length, before, "minting a token asked the server something");
  await assert.rejects(client.delegate({ user: USER_ID, scope: ["files_read"], ttlSecs: 2_592_001 }), /30 days/);
  await assert.rejects(client.delegate({ user: USER_ID, scope: [], ttlSecs: 60 }), NmtsError);
});

test("⛔ rotateKey() proves both halves, and the old key stops working the moment it lands", async () => {
  const client = business();
  const next = generateBusinessKeys();
  await client.rotateKey(next.privateKey);
  assert.deepEqual(platformState.rotations, [next.publicKey]);
  // The client that did the rotation still signs with the old key, so its next call is refused —
  // which is the same thing that happens to every token the old key signed.
  await assert.rejects(client.info(), /signature/i);
  const moved = Nmts.business({ accountId: BUSINESS_ID, privateKey: next.privateKey, server: drive.base });
  const after = await moved.info();
  assert.equal(after.publicKey, next.publicKey);
  // ⛔ AND THE DATE COMES BACK. «Is the leak we are worried about older or newer than the fix» is
  //    the question a rotation leaves behind, and it is unanswerable without this instant.
  assert.equal(after.keyChangedAt, "2026-09-20T12:00:00Z");
});

test("a device makes its own key and learns its own id without a request", async () => {
  const before = platformState.registered.length;
  const code = await Nmts.newAccountCode();
  assert.equal(await Nmts.accountIdOf(code), (await registrationProofOf(code)).accountId);
  assert.notEqual(await Nmts.newAccountCode(), code);
  assert.equal(platformState.registered.length, before, "deriving an id registered something");
});

test("⛔ the embedded form sends the pair and not the code, and carries the device's own token", async () => {
  business();
  const code = await generateCode();
  const token = await Nmts.business({
    accountId: BUSINESS_ID,
    privateKey: KEYS.privateKey,
    server: drive.base,
  }).delegate({ user: USER_ID, scope: ["register"], ttlSecs: 600 });
  const made = await Nmts.registerWithDelegation({ accountCode: code, delegation: token, server: drive.base });
  assert.equal(made.accountId, (await registrationProofOf(code)).accountId);
  assert.equal(made.accountCode, undefined, "the device's own code came back from the server's answer");
  const [sent] = platformState.registered;
  assert.ok(sent !== undefined);
  assert.equal(sent.bearer, token, "the request did not carry the delegation token");
  assert.ok(!JSON.stringify(sent).includes(code), "the account code reached the wire");
});
