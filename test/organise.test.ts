// The five verbs that move a file rather than its bytes, against the fake drive.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. Making a folder, moving, renaming and the trash are the
//    same work whether the key is on the caller's own machine, in a business's sealed store, or
//    behind a token the business signed — and a verb that only worked one way would be the
//    key-holder law broken in the half of the package that organises files.
//
// ⛔ EVERY ASSERTION READS THE LIST THE CLIENT ACTUALLY WROTE, or what `list()` answers out of it.
//    What a method returned is a claim about a save; the sealed list is the save.
//
// ⚠ WHAT IS NOT HERE: the refusals' own words and their codes, which are held in the command-line
//   package's `drive-edit.test.ts` where the refusal is made. One of them is walked here, so that a
//   refusal thrown through this surface is known to arrive as itself.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { Nmts, NmtsError } from "../src/index.ts";
import { entry, folder, KEY, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

for (const { name, root, opens } of rootsUnderTest()) {
  /** A client on this sandbox's account, with the key wherever this root keeps it. */
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] mkdir makes every missing folder above it, and a second call makes nothing`, async () => {
    await withSandbox(drive, `sdk-mkdir-${name}`, async (code) => {
      const nmts = client(code);
      assert.deepEqual(await nmts.mkdir("photos/2026"), { path: "photos/2026", created: ["photos", "photos/2026"] });
      assert.equal(opens(), 1, "one call on the account took the key out more than once");
      // ⛔ A folder that is already there IS the folder asked for — never a numbered one.
      assert.deepEqual(await nmts.mkdir("/photos/2026/"), { path: "photos/2026", created: [] });
      assert.deepEqual(
        (await nmts.list()).map((e) => [e.path, e.kind]),
        [["photos", "folder"], ["photos/2026", "folder"]],
      );
    });
  });

  test(`[${name}] move puts things into a folder and answers where each one came from and landed`, async () => {
    await withSandbox(drive, `sdk-move-${name}`, async (code) => {
      await drive.serve(code, [
        folder({ id: "f1", name: "archive" }),
        entry({ id: "a", name: "notes.txt" }),
        entry({ id: "b", name: "todo.txt" }),
      ]);
      const nmts = client(code);
      assert.deepEqual(await nmts.move(["notes.txt", "todo.txt"], "archive"), {
        moved: [
          { from: "notes.txt", to: "archive/notes.txt" },
          { from: "todo.txt", to: "archive/todo.txt" },
        ],
      });
      // ⛔ ONE WRITE FOR THE WHOLE RUN. Two would be two chances to lose the compare-and-swap, and
      //    losing one half way leaves a drive nobody asked for.
      assert.equal(drive.written.length, 1, "it wrote the list once per path");
      assert.deepEqual((await nmts.list()).map((e) => e.path), ["archive", "archive/notes.txt", "archive/todo.txt"]);
      // A single path needs no array — `"/"` is the top of the account.
      assert.deepEqual(await nmts.move("archive/notes.txt", "/"), { moved: [{ from: "archive/notes.txt", to: "notes.txt" }] });
    });
  });

  test(`[${name}] rename answers the whole path before and after, and refuses a taken name as itself`, async () => {
    await withSandbox(drive, `sdk-rename-${name}`, async (code) => {
      await drive.serve(code, [
        folder({ id: "f1", name: "archive" }),
        entry({ id: "a", name: "notes.txt", parentId: "f1" }),
        entry({ id: "b", name: "other.txt", parentId: "f1" }),
      ]);
      const nmts = client(code);
      assert.deepEqual(await nmts.rename("archive/notes.txt", "meeting notes.txt"), {
        from: "archive/notes.txt",
        to: "archive/meeting notes.txt",
      });
      // ⛔ THE REFUSAL ARRIVES AS ITSELF THROUGH THIS SURFACE: an `NmtsError` a caller can read,
      //    with the word a program branches on, and nothing was written for it.
      const before = drive.written.length;
      await assert.rejects(nmts.rename("archive/meeting notes.txt", "other.txt"), (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.equal(Reflect.get(error, "code"), "NAME_TAKEN");
        return true;
      });
      assert.equal(drive.written.length, before, "it wrote the list for a refusal");
    });
  });

  test(`[${name}] remove sends a folder and everything under it to the trash`, async () => {
    await withSandbox(drive, `sdk-remove-${name}`, async (code) => {
      await drive.serve(code, [
        folder({ id: "f1", name: "photos" }),
        entry({ id: "a", name: "cat.jpg", parentId: "f1" }),
        entry({ id: "b", name: "notes.txt" }),
      ]);
      const nmts = client(code);
      assert.deepEqual(await nmts.remove("photos"), { removed: ["photos"] });
      assert.deepEqual((await nmts.list()).map((e) => e.path), ["notes.txt"], "the trash is in the plain list");

      // ⛔ `trash: true` WIDENS THE LIST AND MARKS WHAT IS IN THE TRASH. The file inside carries the
      //    FOLDER's instant, because that is when its thirty days started — it has none of its own.
      const all = await nmts.list({ trash: true });
      assert.deepEqual(all.map((e) => e.path), ["notes.txt", "photos", "photos/cat.jpg"]);
      assert.equal(all[0]?.trashedAt, undefined, "something live was marked as trashed");
      const folderRow = all[1]?.trashedAt;
      assert.ok(folderRow !== undefined && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(folderRow), `trashedAt is ${String(folderRow)}`);
      assert.equal(all[2]?.trashedAt, folderRow, "the file under it carries a clock of its own");
    });
  });

  test(`[${name}] restore brings things back, and refuses what is not in the trash`, async () => {
    await withSandbox(drive, `sdk-restore-${name}`, async (code) => {
      await drive.serve(code, [
        entry({ id: "a", name: "notes.txt", deletedAt: 1_700_000_000_000 }),
        entry({ id: "b", name: "todo.txt" }),
      ]);
      const nmts = client(code);
      assert.deepEqual(await nmts.restore("notes.txt"), { restored: ["notes.txt"] });
      assert.deepEqual((await nmts.list()).map((e) => e.path), ["notes.txt", "todo.txt"]);

      // ⛔ REFUSED RATHER THAN SKIPPED. The command-line tool names it and carries on, because a
      //    person reads the line; a program is told, because it cannot.
      await assert.rejects(nmts.restore("todo.txt"), (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.equal(Reflect.get(error, "code"), "NOT_IN_TRASH");
        return true;
      });
    });
  });
}
