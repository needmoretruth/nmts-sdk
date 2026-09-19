// The S3 protocol in front of NMTS accounts, in a business's own process. Node only.
//
// ⛔ WHY IT EXISTS. Django, Rails and Laravel all have a storage adapter that speaks S3, and so do
//    every backup tool and every image pipeline. None of them will learn to speak NMTS. This is the
//    protocol they already speak, standing in front of whichever of a business's users' accounts a
//    request names — one line of configuration in the framework, and the files are end-to-end
//    encrypted on the storage network.
//
// ⛔ THE SERVER IS NOT HERE. It is the command-line package's, the same one `nmts s3` runs, reached
//    through `@needmoretruth/nmts-cli/s3-gateway`. A copy would be a second place for a signature
//    check, a listing and a multipart upload to be got right.
//
// ⛔ AND IT DOES NOT CARE WHICH ROOT A CLIENT WAS OPENED WITH. `bucket(name)` answers an `Nmts`,
//    and whether that client holds the key on this machine, in a business's sealed store or behind
//    a delegation token is a question nothing below this line asks.
//
// ⚠ BETWEEN AN S3 CLIENT AND THIS GATEWAY THE FILES ARE PLAINTEXT. Sealing happens on this side of
//   it. `listen` binds loopback unless told otherwise, and anywhere else belongs behind TLS or on a
//   private network — the caller's own `https.createServer(tls, gateway.handler)` is the other way.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDriveSource,
  fetchObject,
  gatewayHandler,
  type DriveSource,
  type GatewayCredential,
  type Staging,
} from "@needmoretruth/nmts-cli/s3-gateway";
import { NmtsError } from "@needmoretruth/nmts-cli/portable";

import { readList } from "./list.ts";
import { insidesOf, type Nmts } from "./nmts.ts";
import { withAccount } from "./session.ts";

/** How long an answer from `bucket(name)` is reused. */
export const BUCKET_CACHE_MS = 60_000;

/** How many names are remembered at once. The least recently used goes first. */
export const BUCKET_CACHE_MAX = 256;

/** What a write is told while `write` is off. */
const READ_ONLY_BECAUSE =
  "This gateway is read only: it was started without write: true. Nothing was written.";

/** How long "no such bucket" is remembered. Short, so a bucket just added is served soon. */
export const MISSING_BUCKET_CACHE_MS = 5_000;

/** An access key id shorter than this is a guessable one. */
export const MIN_ACCESS_KEY_ID = 16;
/** And longer than this is not a key, it is a payload. */
export const MAX_ACCESS_KEY_ID = 128;
/** A secret shorter than this is worth guessing at. */
export const MIN_SECRET_ACCESS_KEY = 32;
/** More pairs than this is a sign that the pairs are being used as a user table. */
export const MAX_CREDENTIALS = 16;

/** One pair a caller may sign with, and what it is allowed to reach. */
export interface GatewayPair {
  /** 16 to 128 characters. Not a secret: it travels in the clear in every request. */
  accessKeyId: string;
  /** At least 32 characters. Never leaves this process and is never logged. */
  secretAccessKey: string;
  /**
   * The only buckets this pair may touch. Absent means every bucket `bucket()` will answer for.
   *
   * ⛔ THIS IS WHAT KEEPS ONE OF YOUR USERS OUT OF ANOTHER'S ACCOUNT. A pair given to a user's
   *    device, with no list here, opens every account your resolver knows.
   */
  buckets?: readonly string[] | undefined;
}

export interface S3GatewayOptions {
  /** One to sixteen pairs. Checked when the gateway is made, not when a request arrives. */
  credentials: readonly GatewayPair[];
  /**
   * Which account answers to this bucket name — or `null`, which is `NoSuchBucket`.
   *
   * ⛔ A BUCKET IS AN ACCOUNT, and which account is yours to decide: one per user, one per tenant,
   *    one for the whole product. Whichever client you answer with, the gateway treats the same.
   */
  bucket: (name: string) => Promise<Nmts | null> | Nmts | null;
  /**
   * Whether uploads and deletes are answered at all. Off by default.
   *
   * ⚠ UPLOADING SPENDS. Every PutObject through this gateway buys storage out of the account the
   *   bucket names, which is why the safe answer is the default one.
   */
  write?: boolean | undefined;
  /**
   * Where the pieces of a multipart upload wait until they are one file.
   *
   * The default is a folder of this gateway's own under the OS temporary directory, mode 0700,
   * removed by `close()`. A directory you name is yours: this writes under it and leaves it.
   */
  stagingDir?: string | undefined;
  /** Told one line per request answered. See `logLine` below for what a line may carry. */
  log?: ((line: string) => void) | undefined;
  /** Passed in so a test can hold the clock still. */
  now?: (() => number) | undefined;
}

export interface S3Gateway {
  /**
   * A plain Node request handler, for mounting in a server of your own:
   * `https.createServer(tls, gateway.handler)`.
   */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Listen on a server of this gateway's own. Loopback unless `host` says otherwise. */
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  /** Stop listening, drop every connection, and remove the staging folder this gateway made. */
  close(): Promise<void>;
}

function refuseCredentials(rule: string): NmtsError {
  return new NmtsError(`GATEWAY_CREDENTIALS: ${rule}`, {
    exitCode: 2,
    nextStep: "Nothing is listening and nothing was opened. Fix the pair and make the gateway again.",
  });
}

/**
 * Every rule about the pairs, answered before anything listens.
 *
 * ⛔ AT CONSTRUCTION AND NOT AT THE FIRST REQUEST. A gateway that accepted a four-character secret
 *    and refused requests later would be a gateway that came up, passed a smoke test with the one
 *    client that had the right pair, and was brute-forced by the time anybody read a log.
 */
function checkedCredentials(given: readonly GatewayPair[]): readonly GatewayCredential[] {
  if (given.length === 0) {
    throw refuseCredentials("`credentials` is empty, so no request could ever be answered.");
  }
  if (given.length > MAX_CREDENTIALS) {
    throw refuseCredentials(
      `\`credentials\` holds ${given.length} pairs and the most this gateway takes is ${MAX_CREDENTIALS}.`,
    );
  }
  const seen = new Set<string>();
  const checked: GatewayCredential[] = [];
  for (const pair of given) {
    const id = pair.accessKeyId;
    if (id.length < MIN_ACCESS_KEY_ID || id.length > MAX_ACCESS_KEY_ID) {
      throw refuseCredentials(
        `an \`accessKeyId\` is ${id.length} characters and it has to be ${MIN_ACCESS_KEY_ID} to ${MAX_ACCESS_KEY_ID}.`,
      );
    }
    if (pair.secretAccessKey.length < MIN_SECRET_ACCESS_KEY) {
      throw refuseCredentials(
        `a \`secretAccessKey\` is ${pair.secretAccessKey.length} characters and it has to be at least ${MIN_SECRET_ACCESS_KEY}.`,
      );
    }
    if (seen.has(id)) {
      throw refuseCredentials("two pairs have the same `accessKeyId`, so which one signs is undecidable.");
    }
    seen.add(id);
    checked.push({
      accessKeyId: id,
      secretAccessKey: pair.secretAccessKey,
      ...(pair.buckets === undefined ? {} : { buckets: pair.buckets }),
    });
  }
  return checked;
}

/**
 * One client as a drive: its list, its reader, and the three verbs a write goes through.
 *
 * ⛔ THE VERBS ARE THE CLIENT'S OWN. An upload is `put`, a delete is `remove` — the trash, where
 *    the file stays recoverable for thirty days — and the folders above a key are `mkdir`. Writing
 *    a second upload path here would be a second place for what an upload costs to be decided.
 */
function driveOf(
  client: Nmts,
  stagingRoot: string,
  writable: boolean,
  multipart: Staging | undefined,
): DriveSource {
  const inside = insidesOf(client);
  return createDriveSource({
    stagingRoot,
    writable,
    multipart,
    account: {
      readList: async () => withAccount(inside.opened(), async (held) => (await readList(held)).entries),
      withCode: (use) => inside.opened().root.withCode(use),
      makeFolder: async (path) => {
        await client.mkdir(path);
      },
      store: async (local, name, folder) => {
        await client.put(local, { name, ...(folder === undefined ? {} : { to: folder }) });
      },
      trash: async (path) => {
        await client.remove(path);
      },
      fetch: (object, sink) => {
        const read = inside.read();
        return withAccount(inside.opened(), (held) =>
          fetchObject(
            {
              server: held.server,
              bearer: held.bearer,
              code: held.code,
              chain: held.network,
              ...(read === undefined ? {} : { read }),
            },
            object,
            sink,
          ),
        );
      },
    },
  });
}

/**
 * What a log line may carry: the verb, the bucket, and what was answered.
 *
 * ⛔ NOT THE OBJECT KEY, AND NOT THE SIGNATURE. A key is a file's path and a path is a file name,
 *    which is exactly the thing this product keeps from the server it stores on; written to a log
 *    on the way past it would be that name in plaintext, on disk, for as long as logs are kept.
 *    The bucket is already the business's own label for an account, so it is the one it can look up.
 */
function logLine(req: IncomingMessage, res: ServerResponse): string {
  const url = req.url ?? "/";
  const at = url.indexOf("?");
  const path = at < 0 ? url : url.slice(0, at);
  const bucket = path.replace(/^\//, "").split("/")[0] ?? "";
  return `${req.method ?? "?"} ${bucket === "" ? "-" : bucket} ${res.statusCode}`;
}

/** What `bucket(name)` answered, and when. */
interface Remembered {
  readonly at: number;
  readonly source: DriveSource | null;
}

/**
 * An S3 endpoint in front of NMTS accounts.
 *
 * ```js
 * const gateway = createS3Gateway({
 *   credentials: [{ accessKeyId, secretAccessKey, buckets: ["acme-user-17"] }],
 *   bucket: async (name) => clientFor(name),
 *   write: true,
 * });
 * await gateway.listen(9000);
 * ```
 */
export function createS3Gateway(options: S3GatewayOptions): S3Gateway {
  const credentials = checkedCredentials(options.credentials);
  const writable = options.write === true;
  const own = options.stagingDir === undefined;
  const stagingRoot = options.stagingDir ?? join(tmpdir(), `nmts-gateway-${process.pid}-${randomUUID()}`);
  // ⛔ MADE NOW, 0700, SO NOTHING LATER HAS TO ASK. Pieces of an upload are somebody's plaintext,
  //    and a directory made under a predictable name later, under whatever mask the process
  //    happens to have, is where another account on the machine reads them.
  if (own) mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });

  /**
   * What `bucket(name)` answered, for a minute.
   *
   * ⛔ A RESOLVER IS SOMEBODY'S DATABASE. A sync tool makes thousands of requests and every one of
   *    them names a bucket; asking per request would put that load on the business's own lookup.
   *    ⚠ The minute is also how long it takes for a change there — a user removed, a bucket added
   *      — to be seen here.
   */
  const remembered = new Map<string, Remembered>();
  const bucketOf = async (name: string): Promise<DriveSource | null> => {
    const now = (options.now ?? Date.now)();
    const held = remembered.get(name);
    // ⚠ "Nobody's" is remembered for seconds, not the minute: a bucket the business has just added
    //   should not answer NoSuchBucket for a minute because somebody asked a moment too early.
    const goodFor = held?.source === null ? MISSING_BUCKET_CACHE_MS : BUCKET_CACHE_MS;
    if (held !== undefined && now - held.at < goodFor) {
      // Re-inserted so the map's own order is least-recently-used order.
      remembered.delete(name);
      remembered.set(name, held);
      return held.source;
    }
    const client = await options.bucket(name);
    // ⛔ THE STAGING IS CARRIED OVER. A large upload arrives in pieces over more than a minute, and
    //    a staging made fresh with every re-ask would answer its next piece "no upload is in
    //    progress with that id". When the business now answers null, nothing is carried: the
    //    upload ends with the access.
    const carried = held?.source?.write?.multipart;
    const source = client === null ? null : driveOf(client, stagingRoot, writable, carried);
    remembered.delete(name);
    remembered.set(name, { at: now, source });
    while (remembered.size > BUCKET_CACHE_MAX) {
      const oldest = remembered.keys().next();
      if (oldest.done === true) break;
      remembered.delete(oldest.value);
    }
    return source;
  };

  const answer = gatewayHandler({ credentials, bucketOf, readOnlyBecause: READ_ONLY_BECAUSE });
  const log = options.log;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // `close` rather than `finish`, so a request whose caller hung up is one line too.
    if (log !== undefined) res.once("close", () => log(logLine(req, res)));
    answer(req, res);
  };

  let server: Server | null = null;
  return {
    handler,
    async listen(port: number, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
      if (server !== null) {
        throw new NmtsError("GATEWAY_ALREADY_LISTENING: this gateway is already on a port.", {
          exitCode: 2,
          nextStep: "Make a second gateway for a second port, or call close() first.",
        });
      }
      const made = createServer(handler);
      server = made;
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server = null;
          reject(error);
        };
        made.once("error", failed);
        made.listen(port, host, () => {
          made.removeListener("error", failed);
          resolve();
        });
      });
      // Port 0 asks the system for a free one, so the answer is read back rather than echoed.
      const bound = made.address();
      return { port: bound !== null && typeof bound === "object" ? bound.port : port, host };
    },
    async close(): Promise<void> {
      const made = server;
      server = null;
      if (made !== null) {
        await new Promise<void>((resolve) => {
          made.close(() => resolve());
          // A client holding a connection open must not keep the process alive after this.
          made.closeAllConnections();
        });
      }
      remembered.clear();
      // Nothing half-uploaded outlives the gateway that was staging it — but a directory the
      // caller named is the caller's, and this only made one when it was not given one.
      if (own) await rm(stagingRoot, { recursive: true, force: true });
    },
  };
}
