// `business.setPublicCodes` — a business replacing its users' public codes, with each user's key
// held by whichever root holds it.
//
// ⛔ THE FAKE CHECKS THE BUSINESS SIGNATURE OVER THE BYTES THAT ARRIVED, so a batch signed over a
//    different body is refused here as the server refuses it. What this file adds is the other half:
//    every item carries the identity and the sign-in secret derived from THAT user's root.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { generateBusinessKeys, loadCrypto, registrationProofOf, shareKeysAt, toBase64Url } from "@needmoretruth/nmts-cli/portable";

import { Nmts } from "../src/index.ts";
import { generateCode, KEY, platformState, resetPlatform, startFakeDrive, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
const KEYS = generateBusinessKeys();
const BUSINESS_ID = toBase64Url(new Uint8Array(16).fill(21));

before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

function business(): ReturnType<typeof Nmts.business> {
  resetPlatform();
  platformState.business = { accountId: BUSINESS_ID, publicKey: KEYS.publicKey, name: "Acme" };
  return Nmts.business({ accountId: BUSINESS_ID, privateKey: KEYS.privateKey, server: drive.base });
}

for (const { name, root, opens } of rootsUnderTest()) {
  test(`[${name}] ⛔ each item is signed by the business and built from the user's own root`, async () => {
    const client = business();
    const code = await generateCode();
    const user = root({ accountCode: code, apiKey: KEY });
    const [first] = await client.setPublicCodes([{ root: user }]);
    assert.equal(opens(), 1, "one item borrowed the user's key more than once");
    const crypt = await loadCrypto();
    const zero = shareKeysAt(crypt, code, 0);
    assert.deepEqual(first, { ok: true, index: 0, code: zero.display });
    const proof = await registrationProofOf(code);
    const [item] = platformState.codeBatches[0] ?? [];
    assert.deepEqual(item, {
      user: proof.accountId,
      auth_secret: proof.authSecret,
      index: 0,
      identity: toBase64Url(zero.identity),
      address: toBase64Url(zero.address),
    });
    zero.wipe();
  });

  test(`[${name}] without \`next\` it walks to the user's next number; with one it takes the answer`, async () => {
    const client = business();
    const code = await generateCode();
    const user = root({ accountCode: code, apiKey: KEY });
    await client.setPublicCodes([{ root: user }]);
    const [walked] = await client.setPublicCodes([{ root: user }]);
    assert.equal(walked?.ok === true ? walked.index : null, 1, "it did not walk past the number taken");
    assert.deepEqual(platformState.codeBatches.map((b) => b.map((i) => i["index"])), [[0], [0], [1]]);
    const [named] = await client.setPublicCodes([{ root: user, next: 5 }]);
    assert.deepEqual(named, { ok: false, error: "INDEX_NOT_NEXT" });
  });
}
