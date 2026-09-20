// Writing through the S3 gateway: where a PutObject and a DELETE end up.
//
// ⚠ THE ONE THING THAT IS NOT REAL IS THE UPLOAD ITSELF. An upload spends, and the rail that
//   spends is driven against fakes where it lives (`put.test.ts`); here `put` is replaced on one
//   client so the question can be the gateway's: does a PutObject arrive at that verb, with the
//   bytes, the name and the folder the key asked for.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createS3Gateway } from "../src/gateway.ts";
import { Nmts } from "../src/index.ts";
import { call, drive, mounted, PAIR, serveFile } from "./gateway-harness.ts";
import { entry, KEY, withSandbox } from "./helpers.ts";

test("⛔ read only is the default, and every write says so rather than answering", async () => {
  await withSandbox(drive(), "sdk-gateway-readonly", async (code) => {
    await drive().serve(code, [entry({ id: "a", name: "notes.txt", size: 5 })]);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => client });
    const { host, stop } = await mounted(gateway);
    try {
      const put = await call("PUT", host, "/acme/new.txt", Buffer.from("x"));
      assert.equal(put.status, 501);
      const said = await put.text();
      assert.match(said, /read only/i);
      // ⛔ `nmts consent` IS A COMMAND ON SOMEBODY'S OWN MACHINE. A business's S3 client told to run
      //    it has been told nothing it can do.
      assert.doesNotMatch(said, /nmts consent/);
      assert.equal((await call("DELETE", host, "/acme/notes.txt")).status, 501);
      assert.equal((await call("POST", host, "/acme/big.bin?uploads=")).status, 501);
      assert.deepEqual(drive().written, [], "a refused write still wrote the list");
    } finally {
      await stop();
    }
  });
});

test("with write on, an upload reaches the client's put and a delete reaches its remove", async () => {
  await withSandbox(drive(), "sdk-gateway-write", async (code) => {
    await drive().serve(code, [entry({ id: "a", name: "notes.txt", size: 5 })]);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const uploads: Array<{ name: unknown; to: unknown; bytes: string }> = [];
    // ⚠ `put` SPENDS, and the rail that spends is judged in `put.test.ts`. Replaced on this one
    //   instance, the question left is the gateway's own: what arrives at the verb.
    Reflect.set(client, "put", async (file: unknown, options: { name?: string; to?: string }) => {
      uploads.push({
        name: options.name,
        to: options.to,
        bytes: readFileSync(typeof file === "string" ? file : "", "utf8"),
      });
      return { id: "item-1", name: options.name ?? "", path: "", bytes: 0, credits: 0, parts: 1, resumed: false };
    });

    const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => client, write: true });
    const { host, stop } = await mounted(gateway);
    try {
      const body = Buffer.from("the third quarter, in full\n");
      assert.equal((await call("PUT", host, "/acme/reports/q3.txt", body)).status, 200);
      assert.deepEqual(uploads.at(-1), { name: "q3.txt", to: "reports", bytes: body.toString() });
      // ⛔ THE FOLDER ABOVE THE KEY IS MADE BY THE CLIENT'S OWN `mkdir`, for real, against the list.
      assert.ok(
        (await client.list()).some((e) => e.path === "reports" && e.kind === "folder"),
        "the folder the key named was not made",
      );

      // ⛔ A DELETE IS THE TRASH, where the file stays recoverable for thirty days.
      assert.equal((await call("DELETE", host, "/acme/notes.txt")).status, 204);
      assert.deepEqual(
        (await client.list()).map((e) => e.path),
        ["reports"],
        "the file the client was told to trash is still live",
      );
      assert.ok(
        (await client.list({ trash: true })).some((e) => e.path === "notes.txt" && e.trashedAt !== undefined),
        "it was removed without going to the trash",
      );
    } finally {
      await stop();
    }
  });
});

// ⛔ A KEY THAT ALREADY HOLDS A DIFFERENT FILE IS 409, exactly as the command-line gateway answers
//    it: the request was well formed and the drive declined it, and a 500 would have the client
//    retry it forever. The rule itself lives in the command-line package; what is proved here is
//    that a gateway built out of an SDK client reaches it.
test("⛔ a key that holds a different file is a conflict, and nothing reaches put", async () => {
  await withSandbox(drive(), "sdk-gateway-conflict", async (code) => {
    const plaintext = new TextEncoder().encode("what is already stored\n");
    await serveFile(code, "notes.txt", plaintext);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    let puts = 0;
    Reflect.set(client, "put", async () => {
      puts += 1;
      return { id: "item-1", name: "", path: "", bytes: 0, credits: 0, parts: 1, resumed: false };
    });
    const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => client, write: true });
    const { host, stop } = await mounted(gateway);
    try {
      const res = await call("PUT", host, "/acme/notes.txt", Buffer.from("something else entirely\n"));
      assert.equal(res.status, 409);
      assert.match(await res.text(), /does not replace files/);
      assert.equal(puts, 0, "it uploaded over a file that was already there");

      // ⭐ And the same bytes at the same key cost nothing and are not a failure.
      const same = await call("PUT", host, "/acme/notes.txt", Buffer.from(plaintext));
      assert.equal(same.status, 200);
      assert.equal(puts, 0, "it sent bytes for a file that was already stored");
    } finally {
      await stop();
    }
  });
});
