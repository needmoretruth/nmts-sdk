// What these tests share: the command-line package's own fakes, and a storage-network aggregator.
//
// ⛔ THE FAKE DRIVE IS THE COMMAND-LINE PACKAGE'S, NOT A COPY. It enforces the compare-and-swap on
//    the file list and pages the object listing, and it answers only routes the real server has.
//    A second copy here would drift from it on the day one of them learns a new refusal.
//
// ⛔ THE AGGREGATOR IS SEPARATE BECAUSE IT IS A SEPARATE HOST. Stored bytes are read from the
//    storage network, not from the NMTS server, and a fake that served both from one address would
//    let a reader that asked the wrong host pass.

import { createServer, type Server } from "node:http";

import { fakeReads, recordingSigners } from "../../cli/test/fake-put-wallet.ts";
import { apiThat, protocolThat, type Pushed } from "../../cli/test/upload-fixture.ts";
import type { WalletSeams } from "../src/put-wallet.ts";

export { startFakeDrive, withSandbox, entry, folder, KEY } from "../../cli/test/fake-drive.ts";
export type { FakeDrive } from "../../cli/test/fake-drive.ts";
export { generateCode, sealFile, sealFileList, type SealedFile } from "../../cli/test/helpers.ts";
export { apiThat, protocolThat, isolate } from "../../cli/test/upload-fixture.ts";
export type { Pushed } from "../../cli/test/upload-fixture.ts";
// The wallet rail's fixtures, also the command-line package's: a chain whose quote is arithmetic a
// test can predict, and signers that remember every shape they were handed.
export { fakeReads, recordingSigners, TIP } from "../../cli/test/fake-put-wallet.ts";
export { FEE_MIST, MAINNET } from "../../cli/test/fake-extend.ts";

/**
 * The seams a WALLET-PAID upload is driven through: a chain whose quote is arithmetic a test can
 * predict, signers that remember every shape they were handed, and no real relay.
 *
 * ⛔ HERE BECAUSE TWO FILES USE IT. What the wallet rail DOES and WHICH WALLET it signs with are
 *    separate files, and a second copy of the fixture is how the two start disagreeing about what a
 *    quote looks like — the same reason the command-line package keeps its own in one place.
 */
export function walletSeams(over: Parameters<typeof fakeReads>[0] = {}): {
  seams: WalletSeams;
  sign: ReturnType<typeof recordingSigners>;
  calls: ReturnType<typeof apiThat>["calls"];
  pushed: { last: Pushed | null; relayUrl?: string };
} {
  const sign = recordingSigners();
  const { api, calls } = apiThat();
  const pushed: { last: Pushed | null; relayUrl?: string } = { last: null };
  return {
    sign,
    calls,
    pushed,
    seams: {
      readChain: () => fakeReads(over),
      sign,
      protocol: () => ({ ...protocolThat({}, pushed), relayUrl: "https://relay.example" }),
      api,
    },
  };
}

export interface FakeAggregator {
  readonly base: string;
  /** Sealed bytes by blob id. */
  blobs: Map<string, Uint8Array>;
  /** Every blob asked for, in order — so a test can say "nothing was fetched". */
  readonly asked: string[];
  close(): void;
}

/** A Walrus aggregator: `GET /v1/blobs/{id}` answers the sealed bytes it holds. */
export async function startFakeAggregator(): Promise<FakeAggregator> {
  const blobs = new Map<string, Uint8Array>();
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    asked.push(url);
    const match = url.match(/\/v1\/blobs\/(?:by-quilt-patch-id\/)?(.+)$/);
    const bytes = match ? blobs.get(decodeURIComponent(match[1] ?? "")) : undefined;
    if (bytes === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such blob" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(bytes));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("aggregator did not bind a port");
  return { base: `http://127.0.0.1:${address.port}`, blobs, asked, close: () => server.close() };
}

/** The server's answer for one stored file's parts, in its own spelling. */
export function partsOf(sealed: { parts: { blobId: string; sealed: Uint8Array }[] }, size: number): unknown {
  return {
    size,
    parts: sealed.parts.map((p, i) => ({
      part_index: i,
      storage_kind: 0,
      network: 0,
      blob_id: p.blobId,
      sealed_len: p.sealed.length,
      owner_kind: 0,
      expiry_epoch: 100,
    })),
  };
}
