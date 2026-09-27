// Writing through the S3 gateway: where a PutObject and a DELETE end up.
//
// ⚠ THE ONE THING THAT IS NOT REAL IS THE UPLOAD ITSELF. An upload spends, and the rail that
//   spends is driven against fakes where it lives (`put.test.ts`); here `put` is replaced on one
//   client so the question can be the gateway's: does a PutObject arrive at that verb, with the
//   bytes, the name, the folder, what a taken key does and who pays — all as the request asked.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createS3Gateway, type GatewayPutOptions, type S3GatewayOptions } from "../src/gateway.ts";
import { Nmts, NmtsError } from "../src/index.ts";
import { call, drive, mounted, PAIR, recordPuts, serveFile } from "./gateway-harness.ts";
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
    const uploads = recordPuts(client, code);

    const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => client, write: true });
    const { host, stop } = await mounted(gateway);
    try {
      const body = Buffer.from("the third quarter, in full\n");
      assert.equal((await call("PUT", host, "/acme/reports/q3.txt", body)).status, 200);
      const [sent] = uploads;
      assert.equal(sent?.bytes, body.toString());
      // ⛔ AND WHAT A TAKEN NAME DOES IS SAID, NOT LEFT TO THIS MACHINE'S `nmts on-collision`.
      assert.deepEqual(sent?.options, { name: "q3.txt", to: "reports", onCollision: "rename" });
      // ⛔ THE FOLDER ABOVE THE KEY IS MADE BY THE CLIENT'S OWN `mkdir`, for real, against the list.
      assert.ok(
        (await client.list()).some((e) => e.path === "reports" && e.kind === "folder"),
        "the folder the key named was not made",
      );

      // ⛔ A DELETE IS THE TRASH, where the file stays recoverable for thirty days.
      assert.equal((await call("DELETE", host, "/acme/notes.txt")).status, 204);
      assert.ok(
        !(await client.list()).some((e) => e.path === "notes.txt"),
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

// ⛔ A KEY THAT ALREADY HOLDS A DIFFERENT FILE IS 409 BY DEFAULT, exactly as the command-line
//    gateway answers it: the request was well formed and the drive declined it, and a 500 would have
//    the client retry it forever. The rule itself lives in the command-line package; what is proved
//    here is that a gateway built out of an SDK client reaches it.
test("⛔ a key that holds a different file is a conflict, and nothing reaches put", async () => {
  await withSandbox(drive(), "sdk-gateway-conflict", async (code) => {
    const plaintext = new TextEncoder().encode("what is already stored\n");
    await serveFile(code, "notes.txt", plaintext);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const uploads = recordPuts(client, code);
    const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => client, write: true });
    const { host, stop } = await mounted(gateway);
    try {
      const res = await call("PUT", host, "/acme/notes.txt", Buffer.from("something else entirely\n"));
      assert.equal(res.status, 409);
      assert.match(await res.text(), /does not replace files/);
      assert.equal(uploads.length, 0, "it uploaded over a file that was already there");

      // ⭐ And the same bytes at the same key cost nothing and are not a failure.
      const same = await call("PUT", host, "/acme/notes.txt", Buffer.from(plaintext));
      assert.equal(same.status, 200);
      assert.equal(uploads.length, 0, "it sent bytes for a file that was already stored");
    } finally {
      await stop();
    }
  });
});

test("⛔ overwrite: \"replace\" stores a different file at a taken key and asks put to trash the old one", async () => {
  await withSandbox(drive(), "sdk-gateway-replace", async (code) => {
    const plaintext = new TextEncoder().encode("what is already stored\n");
    await serveFile(code, "notes.txt", plaintext);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const uploads = recordPuts(client, code);
    const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => client, write: true, overwrite: "replace" });
    const { host, stop } = await mounted(gateway);
    try {
      const res = await call("PUT", host, "/acme/notes.txt", Buffer.from("something else entirely\n"));
      assert.equal(res.status, 200);
      assert.deepEqual(uploads.map((u) => u.options), [{ name: "notes.txt", onCollision: "overwrite" }]);
    } finally {
      await stop();
    }
  });
});

test("putOptions is asked per upload with the bucket and what the client sent, and only who pays is read", async () => {
  await withSandbox(drive(), "sdk-gateway-putoptions", async (code) => {
    await drive().serve(code, []);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const uploads = recordPuts(client, code);
    const asked: unknown[] = [];
    const gateway = createS3Gateway({
      credentials: [PAIR],
      bucket: () => client,
      write: true,
      putOptions: async (bucket, meta) => {
        asked.push({ bucket, meta });
        // ⛔ A `name` in the answer is not the gateway's to take: the key names the file.
        const answer = { pay: "wallet" as const, epochs: 26, name: "elsewhere.txt" };
        const chosen: GatewayPutOptions = answer;
        return chosen;
      },
    });
    const { host, stop } = await mounted(gateway);
    try {
      const res = await call("PUT", host, "/acme/cold.bin", Buffer.from("rarely read"), {
        "x-amz-storage-class": " standard_ia ",
        "content-type": "application/octet-stream",
      });
      assert.equal(res.status, 200);
      assert.deepEqual(asked, [{ bucket: "acme", meta: { storageClass: "STANDARD_IA", contentType: "application/octet-stream" } }]);
      assert.deepEqual(uploads.map((u) => u.options), [{ name: "cold.bin", onCollision: "rename", pay: "wallet", epochs: 26 }]);
    } finally {
      await stop();
    }
  });
});

test("⛔ an overwrite that is neither word is refused when the gateway is made", () => {
  const options: S3GatewayOptions = JSON.parse('{"credentials":[],"overwrite":"yes"}');
  assert.throws(
    () => createS3Gateway({ ...options, credentials: [PAIR], bucket: () => null }),
    (error: unknown) => error instanceof NmtsError && /GATEWAY_OVERWRITE/.test(error.message),
  );
});
