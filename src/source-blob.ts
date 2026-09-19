// A `Blob` as a plaintext source: how bytes get into an upload when they came from a file picker,
// a drag, a `fetch`, or a canvas.
//
// ⛔ IT SLICES RATHER THAN READS. An upload asks for one range at a time so that a file larger than
//    the page's memory can still be sealed; `blob.slice` is a view and costs nothing until the
//    slice is actually read, which is what makes a multi-gigabyte file work in a tab.
//
// ⛔ BOTH ENTRY POINTS EXPORT IT. Node has had `Blob` since 18, so a program on a server that
//    already holds one does not have to write it to a file first to hand it over.

import type { PlaintextSource } from "@needmoretruth/nmts-cli/portable";
import { NmtsError } from "@needmoretruth/nmts-cli/portable";

/** How much is read from the blob at a time. Matches the format's own chunk size. */
const READ_CHUNK_BYTES = 4 * 2 ** 20;

/**
 * Read a `Blob` a chunk at a time.
 *
 * `name` is what the file is called in the account — a `Blob` has none, and a `File` has one its
 * caller may not want. It is not read from the blob so that the two cases look the same.
 */
export function blobSource(blob: Blob, name: string): PlaintextSource & { name: string } {
  if (blob.size === 0) {
    throw new NmtsError(`${name === "" ? "That blob" : name} is empty.`, {
      exitCode: 4,
      nextStep: "The storage network has nothing to store and would refuse the reservation.",
    });
  }
  return {
    name,
    size: blob.size,
    async *read(offset: number, length: number): AsyncIterable<Uint8Array> {
      let at = 0;
      while (at < length) {
        const want = Math.min(READ_CHUNK_BYTES, length - at);
        const piece = new Uint8Array(await blob.slice(offset + at, offset + at + want).arrayBuffer());
        if (piece.length === 0) {
          // ⛔ SHORT IS NOT DONE. The plan was made from the size the blob reported; a read that
          //    ends early means the file underneath it changed, and sealing what arrived would
          //    declare a length the bytes do not match.
          throw new NmtsError(`${name} ended after ${at} of ${length} bytes.`, {
            nextStep: "Nothing was sent. The file changed while it was being read.",
          });
        }
        at += piece.length;
        yield piece;
      }
    },
  };
}
