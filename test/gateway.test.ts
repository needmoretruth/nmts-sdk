// The S3 gateway, driven over real HTTP by signed requests, in front of real clients.
//
// ⛔ REAL SOCKETS AND REAL SIGNATURES. What an S3 client sends is a request line, headers and a
//    signature over both, and the protocol half of that is held to it where the server lives
//    (`cli/test/s3-gateway.test.ts`). What THIS file is for is the half that is this package's: the
//    pairs being checked before anything listens, a bucket being an account, and a write arriving
//    at the client's own verbs rather than at some second upload path.
//
// ⛔ THE READ PATH RUNS THROUGH EVERY ROOT. Serving an account over S3 has to work the same whether
//    the key is on this machine, in a business's sealed store, or behind a token the business
//    signed — that is the whole reason a business can put this in front of its users' accounts.
//
// ⚠ THE ONE THING THAT IS NOT REAL IS THE UPLOAD ITSELF. An upload spends, and the rail that
//   spends is driven against fakes where it lives (`put.test.ts`); here `put` is replaced on one
//   client so the question can be the gateway's: does a PutObject arrive at that verb, with the
//   bytes, the name and the folder the key asked for.

import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { sign } from "../../cli/test/s3-sign.ts";
import { createS3Gateway, type S3Gateway } from "../src/gateway.ts";
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

/** A pair that passes every rule, so a test that is not about the rules is not about them. */
const PAIR = {
  accessKeyId: "NMTSGATEWAYTESTKEY01",
  secretAccessKey: "0123456789abcdef0123456789abcdef",
};
const ITEM = "11111111-2222-3333-4444-666666666666";

/** One sealed file in front of a client: named in the list, parts on the network. */
async function serveFile(code: string, name: string, plaintext: Uint8Array): Promise<void> {
  const sealed = await sealFile(code, [plaintext]);
  await drive.serve(code, [
    entry({
      id: ITEM,
      name,
      size: plaintext.length,
      dekWrapped: sealed.dekWrapped,
      contentHashCt: sealed.contentHashCt,
    }),
  ]);
  drive.parts.set(ITEM, partsOf(sealed, plaintext.length));
  aggregator.blobs.clear();
  for (const p of sealed.parts) aggregator.blobs.set(p.blobId, p.sealed);
}

/**
 * The gateway mounted in a server of this test's own, which is the form a business uses:
 * `https.createServer(tls, gateway.handler)`.
 */
async function mounted(gateway: S3Gateway): Promise<{ host: string; stop: () => Promise<void> }> {
  const server: Server = createServer(gateway.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server bound no port");
  return {
    host: `127.0.0.1:${address.port}`,
    stop: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function call(
  method: string,
  host: string,
  target: string,
  body: Buffer = Buffer.alloc(0),
): Promise<Response> {
  const signed = sign(method, target, host, PAIR, new Date(), body);
  return await fetch(signed.url, {
    method,
    headers: { ...signed.headers, "content-length": String(body.length) },
    ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

// ── The pairs are judged before anything listens ───────────────────────────────────────────────
//
// ⛔ EACH RULE ONCE, AND THE REFUSAL NAMES IT. A gateway that came up with a four-character secret
//    and refused requests later would pass a smoke test with the one client that had the right
//    pair, and be brute-forced by the time anybody read a log.

interface WeakCase {
  readonly what: string;
  /** Words the refusal has to carry, so that it names the rule rather than just saying no. */
  readonly names: RegExp;
  readonly credentials: Parameters<typeof createS3Gateway>[0]["credentials"];
}

const WEAK: readonly WeakCase[] = [
  { what: "no pairs at all", names: /is empty/, credentials: [] },
  {
    what: "more pairs than a gateway takes",
    names: /the most this gateway takes is 16/,
    credentials: Array.from({ length: 17 }, (_, i) => ({
      ...PAIR,
      accessKeyId: `NMTSKEYFORTEST${String(i).padStart(6, "0")}`,
    })),
  },
  {
    what: "a short access key id",
    names: /has to be 16 to 128/,
    credentials: [{ ...PAIR, accessKeyId: "TOOSHORT0123456" }],
  },
  {
    what: "a long access key id",
    names: /has to be 16 to 128/,
    credentials: [{ ...PAIR, accessKeyId: "K".repeat(129) }],
  },
  {
    what: "a short secret",
    names: /at least 32/,
    credentials: [{ ...PAIR, secretAccessKey: "0123456789abcdef0123456789abcde" }],
  },
  {
    what: "two pairs with one id",
    names: /same `accessKeyId`/,
    credentials: [PAIR, { ...PAIR, secretAccessKey: "f".repeat(40) }],
  },
];

for (const { what, names, credentials } of WEAK) {
  test(`⛔ ${what} is refused when the gateway is made, and the refusal names the rule`, () => {
    assert.throws(
      () => createS3Gateway({ credentials, bucket: () => null }),
      (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.match(error.message, /GATEWAY_CREDENTIALS/);
        assert.match(error.message, names);
        return true;
      },
    );
  });
}

// ── The read path, through every root ──────────────────────────────────────────────────────────

for (const { name, root } of rootsUnderTest()) {
  test(`[${name}] a bucket is an account: it lists and hands over that account's files`, async () => {
    await withSandbox(drive, `sdk-gateway-read-${name}`, async (code) => {
      const plaintext = new Uint8Array(4000).map((_, i) => (i * 11) % 251);
      await serveFile(code, "notes.bin", plaintext);
      const client = new Nmts(root({ accountCode: code, apiKey: KEY }), {
        server: drive.base,
        network: "testnet",
        aggregators: [aggregator.base],
      });
      const lines: string[] = [];
      const gateway = createS3Gateway({
        credentials: [{ ...PAIR, buckets: ["acme-user-17"] }],
        bucket: (bucket) => (bucket === "acme-user-17" ? client : null),
        log: (line) => lines.push(line),
      });
      const { host, stop } = await mounted(gateway);
      try {
        const listed = await (await call("GET", host, "/acme-user-17?list-type=2&max-keys=1000")).text();
        assert.match(listed, /<Key>notes\.bin<\/Key>/);

        const got = await call("GET", host, "/acme-user-17/notes.bin");
        assert.equal(got.status, 200);
        assert.deepEqual(new Uint8Array(await got.arrayBuffer()), plaintext);

        // ⛔ A LOG LINE CARRIES NO FILE NAME. A key is a path and a path is a name, which is the
        //    thing this product keeps from the server it stores on.
        assert.ok(lines.length >= 2, "nothing was logged");
        for (const line of lines) assert.doesNotMatch(line, /notes\.bin/, "a log line carried a file name");
        assert.match(lines[lines.length - 1] ?? "", /^GET acme-user-17 200$/);
      } finally {
        await stop();
      }
    });
  });

  test(`[${name}] ⛔ the bucket the pair is not held to is refused, existing or not`, async () => {
    await withSandbox(drive, `sdk-gateway-other-${name}`, async (code) => {
      await drive.serve(code, [entry({ id: "a", name: "theirs.txt", size: 3 })]);
      const client = new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
      const gateway = createS3Gateway({
        credentials: [{ ...PAIR, buckets: ["mine"] }],
        bucket: () => client,
      });
      const { host, stop } = await mounted(gateway);
      try {
        const theirs = await call("GET", host, "/theirs?list-type=2");
        assert.equal(theirs.status, 403);
        assert.doesNotMatch(await theirs.text(), /theirs\.txt/, "a refusal leaked what is in the account");
        assert.equal((await call("GET", host, "/mine?list-type=2")).status, 200);
      } finally {
        await stop();
      }
    });
  });
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────

test("⛔ read only is the default, and every write says so rather than answering", async () => {
  await withSandbox(drive, "sdk-gateway-readonly", async (code) => {
    await drive.serve(code, [entry({ id: "a", name: "notes.txt", size: 5 })]);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive.base, network: "testnet" });
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
      assert.deepEqual(drive.written, [], "a refused write still wrote the list");
    } finally {
      await stop();
    }
  });
});

test("with write on, an upload reaches the client's put and a delete reaches its remove", async () => {
  await withSandbox(drive, "sdk-gateway-write", async (code) => {
    await drive.serve(code, [entry({ id: "a", name: "notes.txt", size: 5 })]);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive.base, network: "testnet" });
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
  await withSandbox(drive, "sdk-gateway-conflict", async (code) => {
    const plaintext = new TextEncoder().encode("what is already stored\n");
    await serveFile(code, "notes.txt", plaintext);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive.base, network: "testnet" });
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

// ── The resolver, and what this gateway leaves behind ──────────────────────────────────────────

test("the resolver is asked once for a name, however many requests carry it", async () => {
  await withSandbox(drive, "sdk-gateway-cache", async (code) => {
    await drive.serve(code, [entry({ id: "a", name: "notes.txt", size: 5 })]);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive.base, network: "testnet" });
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
  await withSandbox(drive, "sdk-gateway-pieces", async (code) => {
    await drive.serve(code, []);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive.base, network: "testnet" });
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
