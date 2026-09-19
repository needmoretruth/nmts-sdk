// A `Blob` as the bytes of an upload: what a page has instead of a path.
//
// ⛔ IT GOES THROUGH THE REAL UPLOAD, NOT THROUGH THE SOURCE ALONE. What has to be true is that a
//    file handed over as a `Blob` ends up sealed, paid for and NAMED in the list exactly as the
//    same bytes handed over as an array — so the test is the seal-buy-push-record path with the
//    source swapped, against the same fakes `put.test.ts` uses.
//
// ⛔ AND THROUGH EVERY ROOT, like every verb: who holds the account's key changes nothing about
//    where the bytes came from, and the registry in `roots.ts` is what makes that a red test.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { NmtsError } from "@needmoretruth/nmts-cli/portable";
import { Nmts } from "../src/index.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { putSource, type UploadRail } from "../src/put.ts";
import { blobSource } from "../src/source-blob.ts";
import { apiThat, KEY, protocolThat, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

function railThat(): { rail: (sealedBytes: number) => Promise<UploadRail>; calls: ReturnType<typeof apiThat>["calls"] } {
  const { api, calls } = apiThat();
  return {
    calls,
    rail: async () => ({ api, protocol: protocolThat(), relayUrl: "https://relay.example", currentEpoch: 40 }),
  };
}

/** Read the whole source the way an upload of one part does. */
async function drain(source: { size: number; read(o: number, n: number): AsyncIterable<Uint8Array> }): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const piece of source.read(0, source.size)) pieces.push(piece);
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

test("what comes out is what went in, whole and in order", async () => {
  const bytes = new Uint8Array(9 * 2 ** 20);
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = at & 0xff;
  const source = blobSource(new Blob([bytes]), "big.bin");
  assert.equal(source.size, bytes.length);
  assert.equal(source.name, "big.bin");
  // ⛔ More than one read chunk, on purpose: a source that only ever yielded its first slice would
  //    pass a one-megabyte test and truncate every real file.
  assert.deepEqual(await drain(source), bytes);
});

async function drainRange(
  source: { read(o: number, n: number): AsyncIterable<Uint8Array> },
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let at = 0;
  for await (const piece of source.read(offset, length)) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

test("a range is a range: the middle of the blob, not the start of it", async () => {
  const source = blobSource(new Blob([new TextEncoder().encode("0123456789")]), "ten.txt");
  assert.equal(new TextDecoder().decode(await drainRange(source, 3, 4)), "3456");
});

test("⛔ an empty blob is refused where it costs nothing, not by the storage network", () => {
  assert.throws(() => blobSource(new Blob([]), "empty.bin"), (error: unknown) => {
    assert.ok(error instanceof NmtsError);
    assert.match(error.message, /empty/);
    return true;
  });
});

for (const { name, root, opens } of rootsUnderTest()) {
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] a blob is sealed, bought once, pushed once, and named in the list`, async () => {
    await withSandbox(drive, `sdk-blob-${name}`, async (code) => {
      const opened = account(code);
      const { rail, calls } = railThat();
      const bytes = new TextEncoder().encode("hello from a page");
      const result = await putSource(opened, blobSource(new Blob([bytes]), "page.txt"), "page.txt", {}, rail);
      assert.equal(result.name, "page.txt");
      assert.equal(result.bytes, bytes.length);
      assert.deepEqual([calls.reserve, calls.uploaded, calls.createItem], [1, 1, 1]);
      assert.equal(opens(), 1, "one upload took the key out more than once");
      const written = await drive.lastWritten(code);
      assert.equal(written[0]?.name, "page.txt");
      assert.equal(written[0]?.size, bytes.length);
    });
  });

  test(`[${name}] ⛔ put() takes each shape of input by the name it was given, and prices it the same`, async () => {
    await withSandbox(drive, `sdk-putinput-${name}`, async (code) => {
      // ⛔ `dryRun` ON PURPOSE: what is under test is which bytes and which NAME `put()` took out
      //    of each shape, and a review answers both without a relay, a chain or a credit spent.
      const client = new Nmts(root({ accountCode: code, apiKey: KEY }), {
        server: drive.base,
        network: "testnet",
      });
      const bytes = new TextEncoder().encode("the same nine");
      for (const [what, input] of [
        ["bytes", { name: "same.txt", bytes }],
        ["blob", { name: "same.txt", blob: new Blob([bytes]) }],
      ] as const) {
        const review = await client.put(input, { dryRun: true });
        assert.equal(review.name, "same.txt", `${what} lost its name`);
        assert.equal(review.path, "same.txt", `${what} landed somewhere else`);
        assert.equal(review.bytes, bytes.length, `${what} counted a different number of bytes`);
        assert.equal(review.credits, 1, `${what} was priced differently`);
      }
    });
  });
}
