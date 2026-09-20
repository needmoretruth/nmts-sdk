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
// ⚠ WRITING IS IN `gateway-write.test.ts` and what the gateway leaves behind in
//   `gateway-life.test.ts`. What all three share — the fake drive, the pair and the mounting — is
//   `gateway-harness.ts`.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createS3Gateway } from "../src/gateway.ts";
import { Nmts, NmtsError } from "../src/index.ts";
import { aggregator, call, drive, mounted, PAIR, serveFile } from "./gateway-harness.ts";
import { entry, KEY, withSandbox } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

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
    await withSandbox(drive(), `sdk-gateway-read-${name}`, async (code) => {
      const plaintext = new Uint8Array(4000).map((_, i) => (i * 11) % 251);
      await serveFile(code, "notes.bin", plaintext);
      const client = new Nmts(root({ accountCode: code, apiKey: KEY }), {
        server: drive().base,
        network: "testnet",
        aggregators: [aggregator().base],
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
    await withSandbox(drive(), `sdk-gateway-other-${name}`, async (code) => {
      await drive().serve(code, [entry({ id: "a", name: "theirs.txt", size: 3 })]);
      const client = new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive().base, network: "testnet" });
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
