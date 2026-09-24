// `list()` against the fake drive: the sealed list is opened here and comes back as paths.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. Which process holds the account's key changes nothing about
//    what `list()` answers, and the registry in `roots.ts` is what makes that a red test rather than
//    something somebody has to remember.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { Nmts } from "../src/index.ts";
import { openAccount } from "../src/session.ts";
import { entry, folder, KEY, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { reaches, rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

for (const { name, root, opens } of rootsUnderTest()) {
  /** A client on this sandbox's account, with the key wherever this root keeps it. */
  const client = (code: string, apiKey: string = KEY): Nmts =>
    new Nmts(root({ accountCode: code, apiKey }), { server: drive.base, network: "testnet" });

  test(`[${name}] a new account with no list yet lists nothing, and that is not an error`, async () => {
    await withSandbox(drive, `sdk-list-empty-${name}`, async (code) => {
      assert.deepEqual(await client(code).list(), []);
      assert.equal(opens(), 1, "one call on the account took the key out more than once");
    });
  });

  test(`[${name}] files and folders come back as full paths, folders before what is in them, trash left out`, async () => {
    await withSandbox(drive, `sdk-list-paths-${name}`, async (code) => {
      await drive.serve(code, [
        folder({ id: "f1", name: "photos" }),
        entry({ id: "i1", name: "cat.jpg", parentId: "f1", size: 10, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000 }),
        entry({ id: "i2", name: "notes.txt", size: 5 }),
        entry({ id: "i3", name: "old.txt", size: 5, deletedAt: 9 }),
      ]);
      const rows = await client(code).list();
      assert.deepEqual(
        rows.map((r) => [r.path, r.kind, r.size]),
        [
          ["notes.txt", "file", 5],
          ["photos", "folder", 0],
          ["photos/cat.jpg", "file", 10],
        ],
      );
      assert.equal(rows[2]?.createdAt, "2023-11-14T22:13:20.000Z", "times are ISO 8601 in UTC");
      assert.equal(rows[2]?.updatedAt, "2023-11-14T22:13:21.000Z");
    });
  });

  test(`[${name}] ⛔ the account is derived from the code and the code is never sent`, async () => {
    await withSandbox(drive, `sdk-list-code-${name}`, async (code) => {
      const nmts = client(code);
      const info = await nmts.account();
      assert.match(info.accountId, /^[A-Za-z0-9_-]{16,}$/);
      await nmts.list();
      // Every request went to the file-list route with the key, and none carried the code anywhere.
      assert.ok(drive.calls.every((c) => !c.includes(code)), "a request carried the account code");
      assert.ok(drive.calls.some((c) => c.startsWith("GET /v1/manifest")));
    });
  });

  test(`[${name}] a code that is not one refuses on the first call, naming the constructor and not the value`, async () => {
    await withSandbox(drive, `sdk-list-badcode-${name}`, async () => {
      await assert.rejects(client("not-a-code").list(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("not-a-code"), "the refusal echoed the code");
        return true;
      });
    });
  });

  test(`[${name}] a video's preview picture is part of the video; \`media\` keeps one kind`, async () => {
    await withSandbox(drive, `sdk-list-media-${name}`, async (code) => {
      await drive.serve(code, [
        entry({ id: "clip", name: "trip.mp4", size: 10 }),
        entry({ id: "pic", name: "trip.mp4.thumb.jpg", size: 3, thumbOf: "clip" }),
        entry({ id: "stray", name: "old.mp4.thumb.jpg", size: 3, thumbOf: "gone" }),
        entry({ id: "song", name: "tune.mp3", size: 4 }),
      ]);
      const nmts = client(code);
      // ⛔ One whose video is gone is listed — a picture somebody paid for must stay reachable.
      assert.deepEqual((await nmts.list()).map((r) => r.path), ["old.mp4.thumb.jpg", "trip.mp4", "tune.mp3"]);
      assert.deepEqual((await nmts.list({ media: "video" })).map((r) => r.path), ["trip.mp4"]);
      assert.deepEqual((await nmts.list({ media: "image" })).map((r) => r.path), ["old.mp4.thumb.jpg"]);
    });
  });

  // ⚠ EITHER CREDENTIAL, EACH NAMED AS ITSELF: the refusal says which one was asked for, so a
  //   caller who filled in the wrong field is told which field. This row walks both.
  test(`[${name}] an empty credential refuses before any request is made`, async () => {
    await withSandbox(drive, `sdk-list-nokey-${name}`, async (code) => {
      await assert.rejects(client(code, " ").list(), /No (API key|delegation token) was given/);
      assert.deepEqual(drive.calls, []);
      // ⛔ AND WITHOUT TAKING THE KEY OUT. A call that could not have worked is not a reason to open
      //    a business's sealed store.
      assert.equal(opens(), 0, "the key was taken out for a call refused for its credential");
    });
  });
}

// ⛔ THE PROOF THAT NOTHING IS KEPT. The count is the part that cannot be faked: a second call that
//    had to open the store again cannot have been served out of something the first one held on to.
//    The walk covers the plain objects the verbs are handed; what it cannot see is written down in
//    `roots.ts`, and that is why the count is here as well.
test("⛔ the managed root is opened once a call, and nothing above it keeps what it opened", async () => {
  const managed = rootsUnderTest().find((r) => r.name === "managed");
  assert.ok(managed !== undefined, "the registry has no managed root");
  await withSandbox(drive, "sdk-list-managed-keeps-nothing", async (code) => {
    const where = { server: drive.base, network: "testnet" };
    const root = managed.root({ accountCode: code, apiKey: KEY });
    const nmts = new Nmts(root, where);
    await nmts.list();
    await nmts.list();
    assert.equal(managed.opens(), 2, "the second call was served out of a code the first one kept");
    assert.equal(reaches(nmts, code), false, "the client holds the account code");
    assert.equal(reaches(root, code), false, "the root holds the code it was asked to open");
    assert.equal(reaches(openAccount(root, where), code), false, "the opened account holds the account code");
  });
});
