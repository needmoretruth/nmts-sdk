// What `put` does before it can start: where the bytes come from, and which rail pays.
//
// ⚠ `putVia` MOVED OFF THE CLASS ON 2026-09-20, unchanged. `nmts.ts` is at the length gate and the
//   method there is one line calling this; what it decides — which money, before anything is read
//   — is written here, in the file that already holds both rails.

import {
  createBlobProtocol,
  createUploadApi,
  readCurrentEpoch,
  type PlaintextSource,
} from "@needmoretruth/nmts-cli/portable";

import { nodeSeams } from "../node-seams.ts";
import {
  bytesSource,
  nameOf,
  putSource,
  type PutInput,
  type PutOptions,
  type PutResult,
  type PutReview,
  type UploadRail,
} from "../put.ts";
import { paysFromWallet } from "../pay.ts";
import { putSourceWithWallet } from "../put-wallet.ts";
import type { Opened } from "../session.ts";
import { blobSource } from "../source-blob.ts";

/**
 * One upload, on whichever rail pays for it.
 *
 * ⛔ WHICH MONEY IS DECIDED BEFORE ANYTHING IS READ, as the command-line tool decides it. The
 *    credit rail cannot price in WAL or sign a transaction, and it must not learn.
 */
export async function putVia(
  opened: Opened,
  file: PutInput | Uint8Array,
  options: PutOptions,
): Promise<PutResult | PutReview> {
  const { source, name: own } = sourceOf(file);
  const name = options.name ?? own;
  // Both wallets take the same rail: which wallet signs is decided inside it, and the credit rail
  // cannot price in WAL whichever wallet it is.
  if (paysFromWallet(options.pay)) return putSourceWithWallet(opened, source, name, options);
  return putSource(opened, source, name, options, (sealedBytes) => creditRail(opened, sealedBytes, options));
}

/**
 * The bytes an upload will read, and the name they came with.
 *
 * ⛔ A PATH IS READ ONLY WHERE THERE IS A DISK. The modules that open one live behind the Node
 *    entry point, so this reaches for them when it is handed a path and refuses when the runtime
 *    that registered the host has no files — which is the honest answer in a page, and a sentence
 *    rather than a crash three calls further in.
 */
export function sourceOf(file: PutInput | Uint8Array): { source: PlaintextSource; name: string } {
  if (typeof file === "string") {
    const seams = nodeSeams(
      "PUT_PATH_UNAVAILABLE",
      "Nothing was sent. Hand `put` the bytes — `{ name, bytes }` — or a `Blob` — " +
        "`{ name, blob }` — which is what a file picker, a drag or a `fetch` already gives you.",
    );
    return { source: seams.source(file), name: nameOf(file) };
  }
  if (file instanceof Uint8Array) return { source: bytesSource(file), name: "" };
  if ("blob" in file) return { source: blobSource(file.blob, file.name), name: file.name };
  return { source: bytesSource(file.bytes), name: file.name };
}

/** The credit-paid rail: the server sells the storage, the network's relay takes the bytes. */
export async function creditRail(
  opened: Opened,
  sealedBytes: number,
  options: PutOptions,
): Promise<UploadRail> {
  const protocol = createBlobProtocol(opened.network, sealedBytes, options.onProgress);
  return {
    api: createUploadApi(opened.server, opened.bearer),
    protocol,
    relayUrl: protocol.relayUrl,
    currentEpoch: await readCurrentEpoch(opened.network),
  };
}
