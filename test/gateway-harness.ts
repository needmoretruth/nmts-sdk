// What the three gateway files share: a fake drive and aggregator for the file, a pair that passes
// every rule, and the two ways a request reaches a mounted gateway.

import { createServer, type Server } from "node:http";
import { after, before } from "node:test";

import { sign } from "../../cli/test/s3-sign.ts";
import type { S3Gateway } from "../src/gateway.ts";
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
): Promise<Response> {
  const signed = sign(method, target, host, PAIR, new Date(), body);
  return await fetch(signed.url, {
    method,
    headers: { ...signed.headers, "content-length": String(body.length) },
    ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}
