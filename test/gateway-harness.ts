// What the three gateway files share: a fake drive and aggregator for the file, a pair that passes
// every rule, and the two ways a request reaches a mounted gateway.

import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { after, before } from "node:test";

import { sign } from "../../cli/test/s3-sign.ts";
import type { S3Gateway } from "../src/gateway.ts";
import { readList } from "../src/list.ts";
import { insidesOf, type Nmts } from "../src/nmts.ts";
import type { PutOptions } from "../src/put.ts";
import { withAccount } from "../src/session.ts";
import {
  entry,
  partsOf,
  sealFile,
  startFakeAggregator,
  startFakeDrive,
  type FakeAggregator,
  type FakeDrive,
} from "./helpers.ts";

let started: FakeDrive;
let aggregating: FakeAggregator;
before(async () => {
  started = await startFakeDrive();
  aggregating = await startFakeAggregator();
});
after(() => {
  started.close();
  aggregating.close();
});

/** The fake drive this file started. Only a test body may ask — it is made in `before`. */
export function drive(): FakeDrive {
  return started;
}

/** The fake aggregator this file started. Only a test body may ask — it is made in `before`. */
export function aggregator(): FakeAggregator {
  return aggregating;
}

/** A pair that passes every rule, so a test that is not about the rules is not about them. */
export const PAIR = {
  accessKeyId: "NMTSGATEWAYTESTKEY01",
  secretAccessKey: "0123456789abcdef0123456789abcdef",
};
export const ITEM = "11111111-2222-3333-4444-666666666666";

/** One sealed file in front of a client: named in the list, parts on the network. */
export async function serveFile(code: string, name: string, plaintext: Uint8Array): Promise<void> {
  const sealed = await sealFile(code, [plaintext]);
  await started.serve(code, [
    entry({
      id: ITEM,
      name,
      size: plaintext.length,
      dekWrapped: sealed.dekWrapped,
      contentHashCt: sealed.contentHashCt,
    }),
  ]);
  started.parts.set(ITEM, partsOf(sealed, plaintext.length));
  aggregating.blobs.clear();
  for (const p of sealed.parts) aggregating.blobs.set(p.blobId, p.sealed);
}

/**
 * The gateway mounted in a server of this test's own, which is the form a business uses:
 * `https.createServer(tls, gateway.handler)`.
 */
export async function mounted(gateway: S3Gateway): Promise<{ host: string; stop: () => Promise<void> }> {
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

export async function call(
  method: string,
  host: string,
  target: string,
  body: Buffer = Buffer.alloc(0),
  /**
   * Headers sent beside the signature, as `Content-Type` often is. An `x-amz-*` one among them is
   * signed all the same, because the gateway refuses any it finds unsigned, as S3 does.
   */
  unsigned: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const amz = Object.fromEntries(Object.entries(unsigned).filter(([name]) => name.toLowerCase().startsWith("x-amz-")));
  const signed = sign(method, target, host, PAIR, new Date(), body, amz);
  return await fetch(signed.url, {
    method,
    headers: { ...unsigned, ...signed.headers, "content-length": String(body.length) },
    ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

/**
 * A signed GET whose `Host` names the bucket — virtual-hosted style — sent to the gateway's own
 * port on loopback, since no name server knows the host.
 */
export async function callAs(hostHeader: string, port: number, target: string): Promise<{ status: number; body: Buffer }> {
  const signed = sign("GET", target, hostHeader, PAIR, new Date());
  return await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: target, headers: signed.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** What one replaced `put` was asked: the file's bytes, and the options exactly as they came. */
export interface PutCall {
  readonly bytes: string;
  readonly options: PutOptions;
}

/**
 * Replace one client's `put` with one that records what it was asked and names the file in the
 * account's list, as a real upload leaves it — the gateway reads the list back for the tag it
 * answers with.
 *
 * ⚠ `put` SPENDS, and the rail that spends is judged in `put.test.ts`. Replaced on this one
 *   instance, the question left is the gateway's own: what arrives at the verb.
 */
export function recordPuts(client: Nmts, code: string): PutCall[] {
  const calls: PutCall[] = [];
  Reflect.set(client, "put", async (file: unknown, options: PutOptions) => {
    calls.push({ bytes: readFileSync(typeof file === "string" ? file : "", "utf8"), options });
    const listed = await withAccount(insidesOf(client).opened(), async (held) => (await readList(held)).entries);
    const parentId = listed.find((e) => e.kind === 0 && e.name === options.to && e.deletedAt === undefined)?.id ?? null;
    const now = Date.now();
    const kept = listed.map((e) =>
      options.onCollision === "overwrite" && e.kind === 1 && e.parentId === parentId && e.name === options.name
        ? { ...e, deletedAt: now }
        : e,
    );
    const id = `item-${calls.length}`;
    // ⚠ ONE VERSION ON FROM WHAT IS SERVED. A different list at a version the client has already
    //   seen is a fork, and the client refuses it — which is right, and not what this is testing.
    const current: unknown = await (await fetch(`${started.base}/v1/manifest`)).json();
    const seq = Reflect.get(typeof current === "object" && current !== null ? current : {}, "seq");
    const next = (typeof seq === "number" ? seq : 0) + 1;
    await started.serve(code, [...kept, entry({ id, name: options.name ?? "", parentId, size: 1, createdAt: now, updatedAt: now })], next);
    return { id, name: options.name ?? "", path: "", bytes: 0, credits: 0, parts: 1, resumed: false };
  });
  return calls;
}
