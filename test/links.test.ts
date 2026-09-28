// `makeLink()` · `listLinks()` · `revokeLink()` · `Nmts.openLink()` against the fake drive and a fake
// aggregator: the wire and the crypto, through every root.
//
// ⛔ THE PROPERTIES WORTH THE HARNESS: the secret is in the returned link and in no request; the
//    owner lists the same link again from the sealed copy; opening needs no credential and asks
//    for the token only; a hidden name still brings the file back at its real length; and a cut
//    link is refused.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { Nmts, NmtsError } from "../src/index.ts";
import {
  entry,
  KEY,
  linkState,
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

const ITEM = "21111111-2222-3333-4444-555555555555";
const REAL = new TextEncoder().encode("what the link opens");

/** One file stored sealed from MORE bytes than it has, so only the link's size takes the padding off. */
async function serve(code: string): Promise<void> {
  const padded = new Uint8Array(REAL.length + 64);
  padded.set(REAL, 0);
  const sealed = await sealFile(code, [padded], REAL.length);
  await drive.serve(code, [
    entry({ id: ITEM, name: "memo.txt", size: REAL.length, dekWrapped: sealed.dekWrapped, contentHashCt: sealed.contentHashCt }),
  ]);
  linkState.parts = partsOf(sealed, REAL.length);
  aggregator.blobs.clear();
  for (const p of sealed.parts) aggregator.blobs.set(p.blobId, p.sealed);
}

for (const { name, root, opens } of rootsUnderTest()) {
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet", aggregators: [aggregator.base] });

  test(`[${name}] a hidden-name link opens with no credential at the real length, lists again, and stops once cut`, async () => {
    await withSandbox(drive, `sdk-links-${name}`, async (code) => {
      await serve(code);
      const nmts = client(code);
      const made = await nmts.makeLink("memo.txt", { hideName: true, expiresDays: 7 });
      assert.equal(opens(), 1, "one call on the account took the key out more than once");
      assert.match(made.link, new RegExp(`^${drive.base}/l/${made.id}#[A-Za-z0-9_-]{43}$`));
      const secret = made.link.split("#")[1] ?? "";
      const row = linkState.rows[0];
      assert.ok(row !== undefined);
      assert.equal(row.body["disclosed_name"], false);
      assert.equal(typeof row.body["name"], "string", "a hidden-name link still sends its sealed document");
      assert.ok(!JSON.stringify(row.body).includes(secret), "the link's secret was sent to the server");
      assert.ok(drive.calls.every((c) => !c.includes(secret)), "a request carried the link's secret");

      const listed = await nmts.listLinks("memo.txt");
      assert.deepEqual(
        listed.map((l) => [l.id, l.link, l.showsName]),
        [[made.id, made.link, false]],
      );

      const opened = await Nmts.openLink(made.link, { server: drive.base, network: "testnet", aggregators: [aggregator.base] });
      assert.equal(opened.name, null);
      assert.deepEqual(opened.bytes, REAL);
      assert.deepEqual(linkState.reads, [{ id: made.id, bearer: false }], "opening sent a credential or asked twice");

      await nmts.revokeLink(made.id);
      await assert.rejects(
        Nmts.openLink(made.link, { server: drive.base, network: "testnet", aggregators: [aggregator.base] }),
        (error: unknown) => error instanceof NmtsError && /has been cut/.test(error.message),
      );
      assert.equal((await nmts.listLinks("memo.txt"))[0]?.link, null, "a cut link came back whole");
    });
  });

  test(`[${name}] every live link is listed with its path, and one call cuts them all`, async () => {
    await withSandbox(drive, `sdk-links-all-${name}`, async (code) => {
      await serve(code);
      const nmts = client(code);
      const first = await nmts.makeLink("memo.txt");
      const second = await nmts.makeLink("memo.txt");
      assert.deepEqual(
        (await nmts.allLinks()).map((l) => [l.id, l.link, l.path]),
        [[second.id, second.link, "memo.txt"], [first.id, first.link, "memo.txt"]],
      );
      assert.equal(await nmts.revokeAllLinks(), 2);
      assert.deepEqual(await nmts.allLinks(), []);
      assert.equal(await nmts.revokeAllLinks(), 0, "asking again cut something");
    });
  });
}
