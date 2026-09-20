// The two things `put` needs before it can start: where the bytes come from, and which rail pays.

import {
  createBlobProtocol,
  createUploadApi,
  readCurrentEpoch,
  type PlaintextSource,
} from "@needmoretruth/nmts-cli/portable";

import { nodeSeams } from "../node-seams.ts";
import { bytesSource, nameOf, type PutInput, type PutOptions, type UploadRail } from "../put.ts";
import type { Opened } from "../session.ts";
import { blobSource } from "../source-blob.ts";

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
