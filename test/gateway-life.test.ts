// The resolver, and what this gateway leaves behind.

import { strict as assert } from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createS3Gateway } from "../src/gateway.ts";
import { Nmts } from "../src/index.ts";
import { call, drive, mounted, PAIR } from "./gateway-harness.ts";
import { entry, KEY, withSandbox } from "./helpers.ts";

test("the resolver is asked once for a name, however many requests carry it", async () => {
  await withSandbox(drive(), "sdk-gateway-cache", async (code) => {
    await drive().serve(code, [entry({ id: "a", name: "notes.txt", size: 5 })]);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const asked: string[] = [];
    const gateway = createS3Gateway({
      credentials: [PAIR],
      bucket: async (name) => {
        asked.push(name);
        return name === "acme" ? client : null;
      },
    });
    const { host, stop } = await mounted(gateway);
    try {
      assert.equal((await call("GET", host, "/acme?list-type=2")).status, 200);
      assert.equal((await call("GET", host, "/acme?list-type=2")).status, 200);
      assert.deepEqual(asked, ["acme"], "a business's own lookup was asked twice inside the window");
      // A second name is a second answer, and `null` is `NoSuchBucket`.
      assert.equal((await call("GET", host, "/nobody?list-type=2")).status, 404);
      assert.deepEqual(asked, ["acme", "nobody"]);
    } finally {
      await stop();
    }
  });
});

// ⛔ A LARGE UPLOAD TAKES LONGER THAN THE MINUTE A BUCKET IS REMEMBERED FOR. Re-asking whose bucket
//    this is must not hand the next piece to a staging that has never heard of the upload.
test("an upload in pieces goes on after the bucket is asked about again, and ends when the answer is null", async () => {
  await withSandbox(drive(), "sdk-gateway-pieces", async (code) => {
    await drive().serve(code, []);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    let clock = 1_000_000;
    let served = true;
    const asked: string[] = [];
    const gateway = createS3Gateway({
      credentials: [PAIR],
      write: true,
      now: () => clock,
      bucket: (name) => {
        asked.push(name);
        return served ? client : null;
      },
    });
    const { host, stop } = await mounted(gateway);
    try {
      const begun = await call("POST", host, "/acme/big.bin?uploads=");
      assert.equal(begun.status, 200);
      const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await begun.text())?.[1];
      assert.ok(id !== undefined, "no upload id came back");
      const piece = (n: number) =>
        call("PUT", host, `/acme/big.bin?partNumber=${n}&uploadId=${encodeURIComponent(id)}`, Buffer.from("x"));
      assert.equal((await piece(1)).status, 200);

      clock += 61_000;
      assert.equal((await piece(2)).status, 200, "the second piece met a staging that had forgotten the upload");
      assert.deepEqual(asked, ["acme", "acme"], "the bucket was not asked about again after its minute");

      served = false;
      clock += 61_000;
      assert.equal((await piece(3)).status, 404, "access was taken away and the upload went on");
    } finally {
      await stop();
    }
  });
});

// ⛔ PIECES OF AN UPLOAD ARE SOMEBODY'S PLAINTEXT. A staging folder left behind is that plaintext
//    left in a shared temporary directory, and a gateway that is started and stopped by a test
//    suite or a deploy leaves one every time.
test("close() takes the staging folder it made with it", async () => {
  // ⚠ Found by what appeared rather than by a field on the gateway: where it stages is nothing a
  //   caller needs, so it is not on the interface.
  const before = new Set(readdirSync(tmpdir()));
  const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => null });
  const made = readdirSync(tmpdir()).filter((name) => !before.has(name) && name.startsWith("nmts-gateway-"));
  assert.equal(made.length, 1, `making a gateway made ${made.length} folders under the temporary directory`);
  const staging = join(tmpdir(), made[0] ?? "");
  assert.ok(existsSync(staging), "the staging folder was not made");
  await gateway.close();
  assert.equal(existsSync(staging), false, "the staging folder outlived the gateway");
});

test("listen() binds the port it is given, and close() gives it back", async () => {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("the probe bound no port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const gateway = createS3Gateway({ credentials: [PAIR], bucket: () => null });
  assert.deepEqual(await gateway.listen(port), { port, host: "127.0.0.1" });
  try {
    // Unsigned, so what this proves is that something is listening and refusing — not what it holds.
    const res = await fetch(`http://127.0.0.1:${port}/acme?list-type=2`);
    assert.equal(res.status, 403);
    await assert.rejects(gateway.listen(port), /GATEWAY_ALREADY_LISTENING/);
  } finally {
    await gateway.close();
  }
});
