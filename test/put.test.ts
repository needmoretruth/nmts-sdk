// `put()`'s wiring, driven through the real seal-buy-push-record path against fakes.
//
// ⛔ THE RAIL IS THE COMMAND-LINE PACKAGE'S OWN FAKE: a server that sells one reservation and a
//    relay that refuses bytes that are not the blob it was told to expect. The file list is the
//    fake drive's, so what this proves is that the file ends up NAMED — a paid-for file the list
//    does not name is invisible, and the whole point of the last step.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. An upload is the one thing here that spends, so a rail
//    that worked for one key holder and not the other would be money lost in whichever one nobody
//    tried. The registry in `roots.ts` is what makes that a red test.

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { testConfigDir } from "../../cli/src/credentials.ts";
import { Nmts, NmtsError } from "../src/index.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { bytesSource, putSource, type UploadRail } from "../src/put.ts";
import { apiThat, entry, folder, KEY, protocolThat, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
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

for (const { name, root, opens } of rootsUnderTest()) {
  /** This sandbox's account, opened with the key wherever this root keeps it. */
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] bytes in: sealed, bought once, pushed once, and named in the list at the top`, async () => {
    await withSandbox(drive, `sdk-put-bytes-${name}`, async (code) => {
      const opened = account(code);
      const { rail, calls } = railThat();
      const bytes = new TextEncoder().encode("hello, storage");
      const result = await putSource(opened, bytesSource(bytes), "hello.txt", {}, rail);
      assert.equal(result.id, "item-1");
      assert.equal(result.name, "hello.txt");
      assert.equal(result.path, "hello.txt");
      assert.equal(result.bytes, bytes.length);
      assert.equal(result.credits, 1, "one credit for one started MiB");
      assert.equal(result.parts, 1);
      assert.equal(result.resumed, false);
      assert.deepEqual([calls.reserve, calls.uploaded, calls.createItem], [1, 1, 1]);
      assert.equal(opens(), 1, "one upload took the key out more than once");
      const written = await drive.lastWritten(code);
      assert.equal(written.length, 1);
      assert.equal(written[0]?.name, "hello.txt");
      assert.equal(written[0]?.size, bytes.length);
      assert.ok(written[0]?.dekWrapped, "the list carries the wrapped file key");
    });
  });

  test(`[${name}] a path in: the local file's own name, into the folder asked for`, async () => {
    await withSandbox(drive, `sdk-put-path-${name}`, async (code) => {
      await drive.serve(code, [folder({ id: "f1", name: "docs" })]);
      const opened = account(code);
      const dir = testConfigDir(`sdk-put-path-src-${name}`);
      mkdirSync(dir, { recursive: true });
      const local = join(dir, "report.txt");
      writeFileSync(local, "a report");
      try {
        const { fileSource, measureLocal } = await import("@needmoretruth/nmts-cli");
        const result = await putSource(opened, fileSource(local, measureLocal(local)), "report.txt", { to: "docs" }, railThat().rail);
        assert.equal(result.path, "docs/report.txt");
        const written = await drive.lastWritten(code);
        assert.equal(written.find((e) => e.name === "report.txt")?.parentId, "f1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test(`[${name}] a name already in use is numbered rather than replacing what is there`, async () => {
    await withSandbox(drive, `sdk-put-collide-${name}`, async (code) => {
      await drive.serve(code, [entry({ id: "i0", name: "hello.txt", size: 3 })]);
      const opened = account(code);
      const result = await putSource(opened, bytesSource(new Uint8Array(3)), "hello.txt", {}, railThat().rail);
      assert.equal(result.name, "hello (2).txt");
      assert.equal(result.renamed, true);
      const written = await drive.lastWritten(code);
      assert.deepEqual(written.map((e) => e.name).sort(), ["hello (2).txt", "hello.txt"]);
    });
  });

  test(`[${name}] ⛔ a destination that does not exist stops before anything is sealed or bought`, async () => {
    await withSandbox(drive, `sdk-put-nofolder-${name}`, async (code) => {
      const opened = account(code);
      const { rail, calls } = railThat();
      await assert.rejects(putSource(opened, bytesSource(new Uint8Array(3)), "x", { to: "nope" }, rail), /Nothing in this account is at "nope"/);
      assert.equal(calls.reserve, 0, "storage was bought for a file with nowhere to go");
      assert.deepEqual(drive.written, []);
    });
  });

  test(`[${name}] ⛔ an option only the wallet rail has is refused, never quietly ignored`, async () => {
    await withSandbox(drive, `sdk-put-walletonly-${name}`, async (code) => {
      const opened = account(code);
      const { rail, calls } = railThat();
      // `wallet` says which wallet signs, and nothing signs for credits — a run that took the
      // credits and ignored the number would have charged for something else than was asked for.
      for (const options of [{ wallet: 1 }, { epochs: 5 }, { storage: "fit" }]) {
        await assert.rejects(
          putSource(opened, bytesSource(new Uint8Array(3)), "x.txt", options, rail),
          /only applies when a wallet is paying/,
        );
      }
      assert.equal(calls.reserve, 0);
      assert.deepEqual(drive.written, []);
    });
  });

  test(`[${name}] a preview picture is recorded with the id of the video it belongs to`, async () => {
    await withSandbox(drive, `sdk-put-thumbof-${name}`, async (code) => {
      await drive.serve(code, [entry({ id: "clip", name: "trip.mp4", size: 10 })]);
      const { rail } = railThat();
      const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      await putSource(account(code), bytesSource(picture), "trip.mp4.thumb.jpg", { thumbOf: "clip" }, rail);
      const written = await drive.lastWritten(code);
      assert.equal(written.find((e) => e.name === "trip.mp4.thumb.jpg")?.thumbOf, "clip");
    });
  });

  test(`[${name}] ⛔ a thumbnail for a file that is not a video is refused before anything is read`, async () => {
    await withSandbox(drive, `sdk-put-thumbnotvideo-${name}`, async (code) => {
      const nmts = new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
      const bytes = new TextEncoder().encode("notes");
      await assert.rejects(nmts.put({ name: "notes.txt", bytes }, { thumbnail: new Uint8Array(4) }), (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.equal(error.exitCode, 2);
        return true;
      });
      assert.deepEqual(drive.calls, [], "the account was read for a call that could not have worked");
    });
  });

  test(`[${name}] bytes with no name are refused before anything is read`, async () => {
    await withSandbox(drive, `sdk-put-noname-${name}`, async (code) => {
      const opened = account(code);
      const { rail, calls } = railThat();
      await assert.rejects(putSource(opened, bytesSource(new Uint8Array(3)), "", {}, rail), /no name/);
      assert.equal(calls.reserve, 0);
      assert.deepEqual(drive.calls, []);
      // ⛔ AND WITHOUT TAKING THE KEY OUT. An upload refused for its own arguments is not a reason
      //    to open a business's sealed store.
      assert.equal(opens(), 0, "the key was taken out for an upload that was refused for its name");
    });
  });
}
