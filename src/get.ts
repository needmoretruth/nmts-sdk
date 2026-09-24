// One file back out: fetched from the storage network, opened here, checked, then handed over.
//
// ⛔ IT REFUSES RATHER THAN RETURNS A HALF-RIGHT FILE. A wrong key, a part that will not open,
//    parts that do not add up, a whole-file hash that does not match — none of them produce
//    bytes. That promise is kept by the sink: the bytes are delivered only on `commit`, after the
//    whole file has been checked, and `abandon` leaves nothing behind. The command-line tool keeps
//    the same promise with a temporary file and a rename; `fileSink` here is that same code.
//
// ⛔ THE IN-MEMORY FORM HAS A CEILING AND SAYS SO. `get()` returns a `Uint8Array`, which means the
//    whole file is in this process at once. A file that would not fit is refused before a byte is
//    fetched, and the refusal names `getTo()`, which streams to disk and has no ceiling.

import {
  buildIndex,
  entryAt,
  fetchFile,
  KIND_FILE,
  NmtsError,
  type FetchedFile,
  type ManifestEntry,
  type PlaintextSink,
  type ReadOptions,
} from "@needmoretruth/nmts-cli/portable";

import { readList } from "./list.ts";
import { withAccount, type Held, type Opened } from "./session.ts";

/** How big a file `get()` will hold in memory unless told otherwise: 256 MiB. */
export const DEFAULT_IN_MEMORY_LIMIT = 256 * 2 ** 20;

export interface GetResult {
  /** The path as it was looked up. */
  path: string;
  /** How many plaintext bytes were delivered — the file's real length. */
  bytes: number;
  /** How many stored objects it came from. */
  parts: number;
  /**
   * Whether the account had sealed a whole-file hash and it matched.
   *
   * ⚠ False is not a failure: it means there was nothing to check against. Every part still
   *   opened under this account's key.
   */
  contentHashChecked: boolean;
}

/**
 * A sink that keeps the file in memory and hands it over once, after it is proved.
 *
 * ⛔ IT COPIES. The caller of `write` zeroes each run of plaintext as soon as the call resolves,
 *    so a sink that kept the reference would hold zeroes.
 */
export function bytesSink(limit: number): { sink: PlaintextSink; take(): Uint8Array } {
  let buffer: Uint8Array | null = null;
  let at = 0;
  let proved = false;
  return {
    sink: {
      expect(size: number): void {
        if (size > limit) {
          throw new NmtsError(`This file is ${size} bytes, over the ${limit}-byte limit for holding it in memory.`, {
            exitCode: 4,
            nextStep: "Nothing was fetched. Use getTo(path, destination) to stream it to a file, or raise `maxBytes`.",
          });
        }
        buffer = new Uint8Array(size);
        at = 0;
      },
      async write(bytes: Uint8Array): Promise<void> {
        if (buffer === null) throw new NmtsError("The sink was written before it was told the size.");
        if (at + bytes.length > buffer.length) {
          throw new NmtsError(`The file produced more bytes (${at + bytes.length}) than its list entry says (${buffer.length}).`);
        }
        buffer.set(bytes, at);
        at += bytes.length;
      },
      async commit(): Promise<boolean> {
        proved = true;
        return true;
      },
      async abandon(): Promise<void> {
        buffer?.fill(0);
        buffer = null;
        at = 0;
      },
    },
    take(): Uint8Array {
      if (!proved || buffer === null) throw new NmtsError("The file was not proved, so there is nothing to hand over.");
      const out = buffer;
      buffer = null;
      return out;
    },
  };
}

/** Find the file the path names and fetch it into the sink. The sink decides what "delivered" means. */
export async function fetchInto(
  held: Held,
  path: string,
  sink: PlaintextSink,
  read: ReadOptions | undefined,
  thumbnail = false,
): Promise<GetResult> {
  const { entries } = await readList(held);
  if (entries.length === 0) {
    throw new NmtsError("This account has no file list, so there is nothing to get.", { exitCode: 4 });
  }
  const named = entryAt(entries, path, { nothingHappened: "Nothing was fetched." });
  // `thumbnail`: the video's preview picture instead of the video (gallery spec §7 · `nmts get --thumbnail`).
  const entry = thumbnail ? pictureOf(entries, named, path) : named;
  if (entry.kind !== KIND_FILE) {
    throw new NmtsError(`"${path}" is a folder.`, {
      exitCode: 4,
      nextStep: "Nothing was fetched. get() takes one file at a time; list() shows what is in the folder.",
    });
  }
  if (entry.dekWrapped === undefined) {
    throw new NmtsError(`The file list holds no key for "${path}".`, {
      exitCode: 4,
      nextStep: "Without it nothing can open the stored bytes. Open the account in a browser.",
    });
  }
  const fetched: FetchedFile = await fetchFile({
    base: held.server,
    apiKey: held.bearer,
    accountCode: held.code,
    itemId: entry.id,
    size: entry.size,
    dekWrapped: entry.dekWrapped,
    contentHashCt: entry.contentHashCt,
    chain: held.network,
    sink,
    ...(read === undefined ? {} : { read }),
  });
  return {
    path,
    bytes: fetched.byteCount,
    parts: fetched.partCount,
    contentHashChecked: fetched.contentHashChecked,
  };
}

/** The preview picture linked to a video, or a refusal naming how one is sent. */
function pictureOf(entries: readonly ManifestEntry[], video: ManifestEntry, path: string): ManifestEntry {
  const index = buildIndex(entries);
  const picture = index.byId.get(index.previews.get(video.id)?.[0] ?? "");
  if (picture !== undefined) return picture;
  throw new NmtsError(`"${path}" has no preview picture.`, {
    exitCode: 4,
    nextStep: "Nothing was fetched. put(video, { thumbnail }) sends one with a video.",
  });
}

/** The whole file, in memory, or a refusal. */
export async function getBytes(
  opened: Opened,
  path: string,
  limit: number,
  read: ReadOptions | undefined,
  thumbnail = false,
): Promise<Uint8Array> {
  return withAccount(opened, async (held) => {
    const memory = bytesSink(limit);
    await fetchInto(held, path, memory.sink, read, thumbnail);
    return memory.take();
  });
}

/**
 * The file delivered to a sink the caller made, rather than held in memory.
 *
 * ⛔ THE SINK IS THE PARAMETER. Writing to a real file is Node's, and what makes the promise —
 *    nothing appears under the name until the whole file is proved — is the sink's, not this
 *    function's. A page's sink keeps the same contract with whatever it delivers to.
 */
export async function getTo(
  opened: Opened,
  path: string,
  sink: PlaintextSink,
  read: ReadOptions | undefined,
  thumbnail = false,
): Promise<GetResult> {
  return withAccount(opened, async (held) => fetchInto(held, path, sink, read, thumbnail));
}
