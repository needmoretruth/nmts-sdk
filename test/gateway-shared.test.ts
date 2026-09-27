// What a gateway keeps apart from the answers `bucket(name)` gives: uploads in pieces, `forget`,
// the limits, and the server it listens on.
//
// ⛔ WHY. The staging of the first client a bucket was answered with used to be carried into every
//    later one, so a finish was stored with that first client's token — refused once it expired —
//    and, after a bucket was handed to another user, in the first user's account.

import { strict as assert } from "node:assert";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";

import { createS3Gateway } from "../src/gateway.ts";
import { gatewayServer } from "../src/gateway/listen.ts";
import { Nmts, NmtsError } from "../src/index.ts";
import { call, drive, mounted, PAIR, recordPuts } from "./gateway-harness.ts";
import { generateCode, KEY, withSandbox } from "./helpers.ts";

const uploadIdIn = (xml: string): string => /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1] ?? "";

async function stage(host: string, key: string, text: string): Promise<{ id: string; list: string }> {
  const id = uploadIdIn(await (await call("POST", host, `/acme/${key}?uploads=`)).text());
  const part = await call("PUT", host, `/acme/${key}?partNumber=1&uploadId=${id}`, Buffer.from(text));
  assert.equal(part.status, 200);
  return { id, list: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${part.headers.get("etag") ?? ""}</ETag></Part></CompleteMultipartUpload>` };
}

test("⛔ a finish is stored through the client the bucket has now, not the one the upload began with", async () => {
  await withSandbox(drive(), "sdk-gateway-renewed", async (code) => {
    await drive().serve(code, []);
    // The same account twice: the second is what a backend hands back once the first one's token ran out.
    const first = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const second = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const byFirst = recordPuts(first, code);
    const bySecond = recordPuts(second, code);
    let clock = Date.now();
    let current = first;
    const gateway = createS3Gateway({ credentials: [PAIR], write: true, now: () => clock, bucket: () => current });
    const { host, stop } = await mounted(gateway);
    try {
      const { id, list } = await stage(host, "big.bin", "all of it");
      clock += 61_000;
      current = second;
      const done = await call("POST", host, `/acme/big.bin?uploadId=${id}`, Buffer.from(list));
      assert.equal(done.status, 200);
      assert.match(await done.text(), /<CompleteMultipartUploadResult/);
      assert.equal(byFirst.length, 0, "the finish went through the client the upload began with");
      assert.deepEqual(bySecond.map((u) => u.bytes), ["all of it"]);
    } finally {
      await stop();
    }
  });
});

test("⛔ a bucket bound to another account neither finishes nor lists the first account's uploads", async () => {
  await withSandbox(drive(), "sdk-gateway-rebound", async (code) => {
    await drive().serve(code, []);
    const bobsCode = await generateCode();
    const alice = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const bob = Nmts.device({ accountCode: bobsCode, apiKey: KEY, server: drive().base, network: "testnet" });
    const byAlice = recordPuts(alice, code);
    const byBob = recordPuts(bob, bobsCode);
    let current = alice;
    const gateway = createS3Gateway({ credentials: [PAIR], write: true, bucket: () => current });
    const { host, stop } = await mounted(gateway);
    try {
      const { id, list } = await stage(host, "hers.bin", "alice's bytes");
      // The fake server now answers with bob's list, as the real one would for his account.
      await drive().serve(bobsCode, []);
      current = bob;
      gateway.forget("acme");
      const listed = await call("GET", host, "/acme?uploads");
      assert.equal(listed.status, 200);
      assert.doesNotMatch(await listed.text(), /<Upload>/, "bob was shown alice's upload in progress");
      const done = await call("POST", host, `/acme/hers.bin?uploadId=${id}`, Buffer.from(list));
      assert.equal(done.status, 404);
      assert.match(await done.text(), /<Code>NoSuchUpload<\/Code>/);
      assert.equal(byAlice.length + byBob.length, 0, "an upload begun by one account was stored");
    } finally {
      await stop();
    }
  });
});

test("forget(name) drops the remembered answer at once, so the next request asks again", async () => {
  const asked: string[] = [];
  const gateway = createS3Gateway({
    credentials: [PAIR],
    bucket: (name) => {
      asked.push(name);
      return null;
    },
  });
  const { host, stop } = await mounted(gateway);
  try {
    await call("GET", host, "/acme?list-type=2");
    await call("GET", host, "/acme?list-type=2");
    assert.deepEqual(asked, ["acme"]);
    gateway.forget("acme");
    await call("GET", host, "/acme?list-type=2");
    assert.deepEqual(asked, ["acme", "acme"], "the answer from before forget() was served");
  } finally {
    await stop();
  }
});

test("⛔ the limits are whole numbers of at least one, and maxObjectBytes is enforced", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => createS3Gateway({ credentials: [PAIR], bucket: () => null, maxObjectBytes: bad }),
      (error: unknown) => error instanceof NmtsError && /GATEWAY_LIMIT/.test(error.message),
    );
  }
  assert.throws(() => createS3Gateway({ credentials: [PAIR], bucket: () => null, maxConcurrentWrites: 0 }), /GATEWAY_LIMIT/);
  assert.throws(() => createS3Gateway({ credentials: [PAIR], bucket: () => null, maxUploadsPerBucket: -3 }), /GATEWAY_LIMIT/);
  await withSandbox(drive(), "sdk-gateway-limit", async (code) => {
    await drive().serve(code, []);
    const client = Nmts.device({ accountCode: code, apiKey: KEY, server: drive().base, network: "testnet" });
    const uploads = recordPuts(client, code);
    const gateway = createS3Gateway({ credentials: [PAIR], write: true, bucket: () => client, maxObjectBytes: 4 });
    const { host, stop } = await mounted(gateway);
    try {
      const res = await call("PUT", host, "/acme/big.txt", Buffer.from("five!"));
      assert.equal(res.status, 400);
      assert.match(await res.text(), /<Code>EntityTooLarge<\/Code>/);
      assert.equal(uploads.length, 0);
    } finally {
      await stop();
    }
  });
});

// ⛔ NODE ENDS ANY REQUEST STILL ARRIVING AFTER 300 SECONDS, which ends every upload a client cannot
//    send in five minutes. The gateway's own server turns that off and keeps the limit on headers;
//    a body that stops arriving is the handler's to drop (tested with the command-line gateway).
// ⛔ AND IT ASKS BEFORE `100 Continue`: an upload that expects it hears nothing until the continue
//    check has run, and one it refuses never sends its body.
test("the gateway's own server has no whole-request limit, keeps the header limit, and checks before 100 Continue", async () => {
  const seen: string[] = [];
  const answer = (name: string) => (req: IncomingMessage, res: ServerResponse): void => {
    seen.push(name);
    req.resume();
    req.once("end", () => res.end("ok"));
  };
  const server = gatewayServer(answer("request"), (req, res) => {
    seen.push("continue");
    res.writeContinue();
    answer("after continue")(req, res);
  });
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.headersTimeout, 60_000);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: address.port, method: "PUT", path: "/", headers: { "content-length": "3", expect: "100-continue" } },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("continue", () => req.end("abc"));
      req.on("error", reject);
    });
    assert.deepEqual(seen, ["continue", "after continue"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
