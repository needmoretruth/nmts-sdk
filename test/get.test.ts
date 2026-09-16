// `get()` and `getTo()` against the fake drive and a fake aggregator: the wire and the crypto.
//
// ⛔ EVERY FAILURE CASE ALSO ASSERTS THAT NOTHING CAME BACK. A `Uint8Array` is a claim that it is
//    the file; a half-right one makes that claim silently.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. Fetching a file is the same work whether the key is on the
//    reader's own machine or in a business's sealed store, and the registry in `roots.ts` holds it
//    to that — including how often the store is opened for one call.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { modesAreEnforced, testConfigDir } from "../../cli/src/credentials.ts";
import { Nmts, NmtsError } from "../src/index.ts";
import {
  entry,
  folder,
  KEY,
  partsOf,
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

const ITEM = "11111111-2222-3333-4444-555555555555";

/** One sealed file in front of the client: named in the list, parts on the network. */
async function serve(code: string, name: string, plaintext: Uint8Array, parentId: string | null = null): Promise<void> {
  const sealed = await sealFile(code, [plaintext]);
  await drive.serve(code, [
    ...(parentId === null ? [] : [folder({ id: parentId, name: "docs" })]),
    entry({
      id: ITEM,
      name,
      parentId,
      size: plaintext.length,
      dekWrapped: sealed.dekWrapped,
      contentHashCt: sealed.contentHashCt,
    }),
  ]);
  drive.parts.set(ITEM, partsOf(sealed, plaintext.length));
  aggregator.blobs.clear();
  for (const p of sealed.parts) aggregator.blobs.set(p.blobId, p.sealed);
}

for (const { name, root, opens } of rootsUnderTest()) {
  /** A client on this sandbox's account, with the key wherever this root keeps it. */
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), {
      server: drive.base,
      network: "testnet",
      aggregators: [aggregator.base],
    });

  test(`[${name}] get() returns the file byte for byte, and says the hash was checked`, async () => {
    await withSandbox(drive, `sdk-get-one-${name}`, async (code) => {
      const plaintext = new Uint8Array(5000).map((_, i) => (i * 7) % 251);
      await serve(code, "notes.bin", plaintext);
      assert.deepEqual(await client(code).get("notes.bin"), plaintext);
      assert.equal(opens(), 1, "one call on the account took the key out more than once");
    });
  });

  test(`[${name}] a file inside a folder is found by its full path`, async () => {
    await withSandbox(drive, `sdk-get-folder-${name}`, async (code) => {
      const plaintext = new TextEncoder().encode("hello");
      await serve(code, "a.txt", plaintext, "f1");
      assert.deepEqual(await client(code).get("docs/a.txt"), plaintext);
      await assert.rejects(client(code).get("a.txt"), /Nothing in this account is at "a.txt"/);
    });
  });

  test(`[${name}] getTo() writes the file, not world-readable, and refuses to overwrite unless told to`, async () => {
    await withSandbox(drive, `sdk-get-to-${name}`, async (code) => {
      const plaintext = new Uint8Array(3000).map((_, i) => (i * 13) % 251);
      await serve(code, "report.bin", plaintext);
      const dir = testConfigDir(`sdk-get-to-out-${name}`);
      mkdirSync(dir, { recursive: true });
      const out = join(dir, "report.bin");
      const result = await client(code).getTo("report.bin", out);
      assert.equal(result.bytes, 3000);
      assert.equal(result.contentHashChecked, true);
      assert.deepEqual(new Uint8Array(readFileSync(out)), plaintext);
      if (modesAreEnforced()) assert.equal(statSync(out).mode & 0o077, 0, "the file others can read");
      await assert.rejects(client(code).getTo("report.bin", out), /already exists/);
      writeFileSync(out, "stale");
      await client(code).getTo("report.bin", out, { force: true });
      assert.deepEqual(new Uint8Array(readFileSync(out)), plaintext);
    });
  });

  test(`[${name}] ⛔ a part that will not open returns nothing, and getTo() leaves no file`, async () => {
    await withSandbox(drive, `sdk-get-tampered-${name}`, async (code) => {
      const plaintext = new Uint8Array(2000).fill(7);
      await serve(code, "x.bin", plaintext);
      for (const [id, bytes] of aggregator.blobs) {
        const broken = new Uint8Array(bytes);
        broken[broken.length - 1] ^= 0xff;
        aggregator.blobs.set(id, broken);
      }
      await assert.rejects(client(code).get("x.bin"));
      const outDir = testConfigDir(`sdk-get-tampered-out-${name}`);
      mkdirSync(outDir, { recursive: true });
      const out = join(outDir, "x.bin");
      await assert.rejects(client(code).getTo("x.bin", out));
      assert.equal(existsSync(out), false, "a half-right file was left behind");
    });
  });

  test(`[${name}] a file over the in-memory limit is refused before a byte is fetched, and names getTo()`, async () => {
    await withSandbox(drive, `sdk-get-limit-${name}`, async (code) => {
      const plaintext = new Uint8Array(1024).fill(1);
      await serve(code, "big.bin", plaintext);
      aggregator.asked.length = 0;
      await assert.rejects(client(code).get("big.bin", { maxBytes: 100 }), (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.match(error.message, /over the 100-byte limit/);
        assert.match(error.nextStep ?? "", /getTo/, "the next step names the way that has no ceiling");
        return true;
      });
      // The list and the part descriptor are read to learn the size; the refusal lands before any
      // stored bytes are asked for.
      assert.deepEqual(aggregator.asked, [], "stored bytes were fetched for a file that was refused");
    });
  });

  test(`[${name}] a folder is not a file, and the refusal says so`, async () => {
    await withSandbox(drive, `sdk-get-folder-refused-${name}`, async (code) => {
      await drive.serve(code, [folder({ id: "f1", name: "docs" })]);
      await assert.rejects(client(code).get("docs"), /is a folder/);
    });
  });
}
