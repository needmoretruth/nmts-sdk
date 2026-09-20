// Erasing for good, against the fake drive — the one verb here that nothing undoes.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. "Erase my data" is the request a business cannot answer
//    with a trash, and a verb that worked only where the person holds their own key would be the
//    key-holder law broken on the one act that cannot be put right afterwards.
//
// ⛔ AND THE PROOF IS READ OFF THE WIRE, not off what the method returned. The server refuses both
//    doors to a credential that arrives without the account code's own proof, whichever root that
//    credential came from; the fake refuses it the same way, so a verb that forgot it fails here.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { CONFIRM_SENTENCE } from "../../cli/src/commands/delete-account.ts";
import { ERASE_CONFIRM, Nmts, NmtsError } from "../src/index.ts";
import { entry, eraseState, folder, KEY, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
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

  test(`[${name}] the sentence erases the rows, with the proof beside the credential, and the entries leave the list`, async () => {
    await withSandbox(drive, `sdk-erase-${name}`, async (code) => {
      await drive.serve(code, [entry({ id: "a", name: "notes.txt" }), entry({ id: "b", name: "keep.txt" })]);
      drive.objects = ["a", "b"];
      const nmts = client(code);
      assert.deepEqual(await nmts.erase("notes.txt", { confirm: ERASE_CONFIRM }), {
        erased: ["notes.txt"],
        storage: [],
      });
      assert.equal(opens(), 1, "one call on the account took the key out more than once");
      assert.deepEqual(eraseState.erasures.map((e) => e.ids), [["a"]]);
      // ⛔ THE SERVER ASKS FOR IT ON THIS DOOR AND REFUSES WITHOUT IT, whichever credential asked.
      assert.ok(eraseState.erasures[0]?.proof, "the account code's proof did not travel with the erase");
      // ⛔ THE SEALED LIST IS THE SAVE, and what it must no longer hold is the erased entry.
      assert.deepEqual((await nmts.list()).map((e) => e.path), ["keep.txt"]);
    });
  });

  test(`[${name}] anything but the sentence erases nothing and sends nothing at all`, async () => {
    await withSandbox(drive, `sdk-erase-no-${name}`, async (code) => {
      await drive.serve(code, [entry({ id: "a", name: "notes.txt" })]);
      drive.objects = ["a"];
      const nmts = client(code);
      // ⚠ Near-misses, not nonsense: lower case and a trailing full stop are what a caller writes
      //   from memory, and each of them must be as refused as an empty string.
      for (const confirm of ["", "yes", ERASE_CONFIRM.toLowerCase(), `${ERASE_CONFIRM}.`]) {
        await assert.rejects(nmts.erase("notes.txt", { confirm }), (error: unknown) => {
          assert.ok(error instanceof NmtsError, `"${confirm}" was refused as something else`);
          assert.match(error.message, /ERASE_NOT_CONFIRMED/);
          return true;
        });
      }
      assert.deepEqual(eraseState.erasures, [], "a refused erase reached the server");
      assert.deepEqual(drive.written, [], "a refused erase wrote the file list");
    });
  });

  test(`[${name}] a folder erases every file under it, and its own entry goes with them`, async () => {
    await withSandbox(drive, `sdk-erase-folder-${name}`, async (code) => {
      await drive.serve(code, [
        folder({ id: "d", name: "docs" }),
        folder({ id: "d2", name: "old", parentId: "d" }),
        entry({ id: "a", name: "a.txt", parentId: "d" }),
        entry({ id: "b", name: "b.txt", parentId: "d2" }),
        entry({ id: "c", name: "outside.txt" }),
      ]);
      drive.objects = ["a", "b", "c"];
      const nmts = client(code);
      const result = await nmts.erase("docs", { confirm: ERASE_CONFIRM });
      assert.deepEqual(result.erased.sort(), ["docs/a.txt", "docs/old/b.txt"]);
      assert.deepEqual(eraseState.erasures.map((e) => e.ids.sort()), [["a", "b"]]);
      // ⚠ THE FILES ARE WHAT THIS JUDGES, and only they: a folder holds no bytes and has no server
      //   row, so what a folder contributes to an erase is its files. The named folder's own entry
      //   leaves the list with them; an EMPTY folder that was under it stays behind as an entry
      //   whose parent is gone, which is the command-line tool's own behaviour today and not this
      //   verb's decision to make.
      const left = await nmts.list();
      assert.deepEqual(left.filter((e) => e.kind === "file").map((e) => e.path), ["outside.txt"]);
      assert.ok(!left.some((e) => e.path === "docs"), "the folder that was named stayed in the list");
    });
  });

  test(`[${name}] a release that fails leaves every file whole, and one the server refuses is reported on that file`, async () => {
    await withSandbox(drive, `sdk-erase-release-${name}`, async (code) => {
      await drive.serve(code, [entry({ id: "a", name: "credits.txt" }), entry({ id: "w", name: "wallet.txt" })]);
      drive.objects = ["a", "w"];
      const nmts = client(code);

      // ⛔ A FAILURE STOPS THE RUN BEFORE A ROW IS TOUCHED. Erasing behind a release that did not
      //    happen would destroy the key to bytes that are still served and still paid for.
      eraseState.feeShort = ["a"];
      await assert.rejects(
        nmts.erase(["credits.txt", "wallet.txt"], { confirm: ERASE_CONFIRM, releaseStorage: true }),
        (error: unknown) => {
          assert.ok(error instanceof NmtsError);
          assert.match(error.message, /credits\.txt/, "the refusal did not name the file it was about");
          return true;
        },
      );
      assert.deepEqual(eraseState.erasures, [], "a file was erased behind a release that failed");
      assert.deepEqual((await nmts.list()).map((e) => e.path).sort(), ["credits.txt", "wallet.txt"]);

      // ⚠ A REFUSAL IS AN ANSWER RATHER THAN A FAILURE: that storage was bought by the account's
      //   own wallet, which nothing here can sign for, so the file is erased and told about.
      eraseState.feeShort = [];
      eraseState.walletPaid = ["w"];
      const done = await nmts.erase(["credits.txt", "wallet.txt"], { confirm: ERASE_CONFIRM, releaseStorage: true });
      assert.deepEqual(done.erased, ["credits.txt", "wallet.txt"]);
      assert.deepEqual(done.storage.map((s) => [s.path, s.released]), [
        ["credits.txt", true],
        ["wallet.txt", false],
      ]);
      assert.match(String(done.storage[1]?.reason), /wallet/);
      assert.equal(done.storage[0]?.reason, undefined, "a release that happened carried a reason");
    });
  });
}

/**
 * ⛔ ONE SENTENCE FOR BOTH SURFACES. A program's `confirm` and the line a person types at
 * `nmts erase` are the same words on purpose: a business's support page can quote one of them and
 * be right about the other. Two copies of a constant is how that stops being true, so they are
 * compared rather than trusted.
 */
test("the sentence this package takes is the one the command line asks a person to type", () => {
  assert.equal(ERASE_CONFIRM, CONFIRM_SENTENCE);
});

/**
 * ⛔ THE ROOT A BUSINESS'S USER SPEAKS FROM CARRIES BOTH HALVES, and the server needs both: the
 * token is the business's permission (the `files_erase` scope it was minted with), the proof is an
 * act only whoever holds the account code can perform. A verb written for an API key would send
 * one of them and be refused for the other.
 */
test("the delegation root erases with the token and the account proof on the same request", async () => {
  const delegation = rootsUnderTest().find((r) => r.name === "delegation");
  assert.ok(delegation, "the registry no longer has a delegation root");
  await withSandbox(drive, "sdk-erase-delegated", async (code) => {
    await drive.serve(code, [entry({ id: "a", name: "notes.txt" })]);
    drive.objects = ["a"];
    const nmts = new Nmts(delegation.root({ accountCode: code, apiKey: KEY }), {
      server: drive.base,
      network: "testnet",
    });
    await nmts.erase("notes.txt", { confirm: ERASE_CONFIRM });
    const asked = eraseState.erasures[0];
    assert.ok(asked?.bearer?.startsWith("nmts_dt1_"), "the erase did not travel under the delegation token");
    assert.ok(asked?.proof, "the erase travelled without the account code's proof");
  });
});
