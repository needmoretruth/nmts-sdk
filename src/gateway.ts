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
// ⛔ WHAT OUTLIVES AN ANSWER FROM `bucket(name)` IS MADE ONCE, HERE, AND NEVER CARRIED IN ONE. The
//    answer is remembered for a minute and then asked again; an upload in pieces takes longer than
//    that, and two uploads to one key can straddle it. So the staging of pieces and the per-key
//    locks belong to the gateway, and every drive built from an answer is handed them. A finish is
//    stored through the drive the bucket has when the finish arrives — with the token and the
//    account that has now, never the ones it had when the upload began.
//
// ⚠ BETWEEN AN S3 CLIENT AND THIS GATEWAY THE FILES ARE PLAINTEXT. Sealing happens on this side of
//   it. `listen` binds loopback unless told otherwise, and anywhere else belongs behind TLS or on a
//   private network — the caller's own `https.createServer(tls, gateway.handler)` is the other way.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkContinueHandler,
  createKeyLocks,
  createStagingStore,
  gatewayHandler,
  refusalBeforeBody,
  SWEEP_EVERY_MS,
  type DriveSource,
  type EarlyRefusal,
  type GatewayOptions,
  type WriteMeta,
} from "@needmoretruth/nmts-cli/s3-gateway";
import { NmtsError } from "@needmoretruth/nmts-cli/portable";

import { driveOf, type DriveSetup, type GatewayPutOptions } from "./gateway/drive.ts";
import { gatewayServer } from "./gateway/listen.ts";
import { logEach } from "./gateway/log.ts";
import { checkedCredentials, type GatewayPair } from "./gateway/pairs.ts";
import type { Nmts } from "./nmts.ts";

/** What the client sent about one upload: its `x-amz-storage-class` and its `Content-Type`. */
export type { WriteMeta } from "@needmoretruth/nmts-cli/s3-gateway";

export type { GatewayPutOptions } from "./gateway/drive.ts";

/** What a key that already holds a different file does with an upload. */
export type GatewayOverwrite = "replace" | "refuse";

/** How long an answer from `bucket(name)` is reused, unless `forget(name)` drops it first. */
export const BUCKET_CACHE_MS = 60_000;

/** How many names are remembered at once. The least recently used goes first. */
export const BUCKET_CACHE_MAX = 256;

/** What a write is told while `write` is off. */
const READ_ONLY_BECAUSE =
  "This gateway is read only: it was started without write: true. Nothing was written.";

/** How long "no such bucket" is remembered. Short, so a bucket just added is served soon. */
export const MISSING_BUCKET_CACHE_MS = 5_000;

export { MAX_CONCURRENT_WRITES, MAX_UPLOADS_PER_BUCKET } from "@needmoretruth/nmts-cli/s3-gateway";
export { RECEIVE_IDLE_MS } from "./gateway/listen.ts";
export { GATEWAY_SERVER_OPTIONS } from "@needmoretruth/nmts-cli/s3-gateway";
export type { EarlyRefusal } from "@needmoretruth/nmts-cli/s3-gateway";
export { MAX_ACCESS_KEY_ID, MAX_CREDENTIALS, MIN_ACCESS_KEY_ID, MIN_SECRET_ACCESS_KEY } from "./gateway/pairs.ts";
export type { GatewayPair } from "./gateway/pairs.ts";

export interface S3GatewayOptions {
  /** One to sixteen pairs. Checked when the gateway is made, not when a request arrives. */
  credentials: readonly GatewayPair[];
  /**
   * Which account answers to this bucket name — or `null`, which is `NoSuchBucket`.
   *
   * ⛔ A BUCKET IS AN ACCOUNT, and which account is yours to decide: one per user, one per tenant,
   *    one for the whole product. Whichever client you answer with, the gateway treats the same.
   *
   * ⚠ AN ANSWER IS REMEMBERED FOR `BUCKET_CACHE_MS` (a "no" for `MISSING_BUCKET_CACHE_MS`). When
   *   you bind a bucket to a user, move it to another, or remove it, call `forget(name)` so the next
   *   request asks again instead of reaching the account it used to name.
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
   * What an upload to a key that already holds a DIFFERENT file does. `"refuse"` unless you say.
   *
   * `"refuse"` answers 409 and the file at the key stays as it was. `"replace"` stores the new
   * bytes and sends the old file to the trash, where it can be restored for 30 days — what an S3
   * client expects a PUT to do. The same bytes at the same key are neither: nothing is sent, nothing
   * is spent, and the upload is answered as done.
   */
  overwrite?: GatewayOverwrite | undefined;
  /**
   * Which money pays for one upload, and for how long, decided per bucket and per request.
   *
   * Absent, every upload spends the account's credits, which is `put()`'s own default. `meta` is
   * what the client sent, so a storage class can choose a rail and a term:
   * `STANDARD_IA` → `{ pay: "wallet", epochs: 26 }`. ⚠ `epochs` is the wallet's to choose — on
   * credits the term is fixed, and `put()` refuses `epochs` there. Only `pay`, `epochs` and
   * `storage` are read from the answer; they mean what they mean to `put()`.
   */
  putOptions?: ((bucket: string, meta: WriteMeta) => GatewayPutOptions | Promise<GatewayPutOptions>) | undefined;
  /**
   * The bucket names `ListBuckets` answers with, before each pair's own `buckets` narrows them.
   *
   * Absent, a pair held to `buckets` is told those names and an unrestricted pair is told none:
   * the gateway cannot list your users by itself.
   */
  bucketNames?: (() => readonly string[] | Promise<readonly string[]>) | undefined;
  /**
   * The host name buckets live under, for virtual-hosted-style requests. With `"s3.example.com"`,
   * a request to `acme.s3.example.com` is bucket `acme` and its whole path is the key. A request to
   * any other host is path style, `/acme/key`, as it is without this.
   */
  virtualHostBase?: string | undefined;
  /**
   * Where each upload's bytes, and the pieces of a multipart upload, wait until they are stored.
   *
   * The default is a folder of this gateway's own under the OS temporary directory, mode 0700,
   * removed by `close()`. A directory you name is yours: this writes under it and leaves it — and,
   * when the gateway starts and every hour after, removes from it what this gateway's own names
   * made and nothing has touched for a day (a crash's leftovers). Several processes may share one.
   */
  stagingDir?: string | undefined;
  /**
   * The most bytes one object may have — an upload, one part of one, a finished upload in parts, or
   * a copy's source. Counted on the bytes that arrive, not on what a header says. One past it is
   * `EntityTooLarge`. Absent: no limit but the upload path's own.
   */
  maxObjectBytes?: number | undefined;
  /**
   * How many writes — uploads, parts, finishes, copies, deletes — run at once across every bucket.
   * One past it is answered 503 `SlowDown` with `Retry-After`. `MAX_CONCURRENT_WRITES` (16) unless
   * you say.
   */
  maxConcurrentWrites?: number | undefined;
  /**
   * How many uploads in parts one bucket may have begun and not finished. One past it is 503
   * `SlowDown`. `MAX_UPLOADS_PER_BUCKET` (1,000) unless you say.
   */
  maxUploadsPerBucket?: number | undefined;
  /** Told one line per request answered: the verb, the bucket and the status, never a key. */
  log?: ((line: string) => void) | undefined;
  /**
   * The clock, in milliseconds, for how long a bucket is remembered and how old a signature may be.
   * Passed in so a test can hold it still.
   */
  now?: (() => number) | undefined;
}

/**
 * An S3 endpoint in front of NMTS accounts.
 *
 * ⚠ AN UPLOAD IN PARTS IS TAGGED `"<32 hex>-1"`, like every object here, and never the MD5 of its
 *   parts' MD5s: the tag is the file list's, and the file list keeps no MD5. A client that checks a
 *   multipart tag against the parts it sent reports a mismatch on a file that stored correctly —
 *   rclone with `provider = AWS` does ("Etag differ"); set `use_multipart_etag = false`
 *   (`--s3-use-multipart-etag=false`) there, or use `provider = Other`.
 */
export interface S3Gateway {
  /**
   * A plain Node request handler, for mounting in a server of your own:
   * `https.createServer(tls, gateway.handler)`.
   *
   * ⚠ A SERVER OF YOUR OWN KEEPS NODE'S `requestTimeout` (300 s) unless you set it, and that ends
   *   any upload that takes longer to arrive. Make it with `GATEWAY_SERVER_OPTIONS`, as `listen`
   *   does; the handler itself drops a request whose body stops arriving for `RECEIVE_IDLE_MS`.
   *   Answer `Expect: 100-continue` with `refusalBeforeBody` (Node's `checkContinue` event), or
   *   Node sends `100 Continue` before the signature is checked.
   */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * What the request's line and headers alone will be refused with — a signature that does not
   * hold, a bucket the pair may not use — or null. For a server of your own that answers
   * `Expect: 100-continue` itself: answer the refusal with `Connection: close` and skip the body,
   * or send `100 Continue` and pass the request to `handler`.
   */
  refusalBeforeBody(req: IncomingMessage): EarlyRefusal | null;
  /** Listen on a server of this gateway's own. Loopback unless `host` says otherwise. */
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  /**
   * Drop what `bucket(name)` answered for this name, at once, so the next request asks again.
   *
   * Call it whenever you bind a bucket to a user, move it to another user, unbind it or delete the
   * user: until then the gateway may serve the account the name used to belong to, for up to
   * `BUCKET_CACHE_MS`. Uploads in parts are not dropped by this — they belong to the account they
   * began under, and are refused and removed the first time the bucket names another.
   */
  forget(bucket: string): void;
  /**
   * Stop listening, drop every connection, wait for every upload still being stored, and remove the
   * staging folder this gateway made.
   */
  close(): Promise<void>;
}

/** What `bucket(name)` answered, and when. */
interface Remembered {
  readonly at: number;
  readonly source: DriveSource | null;
}

/** A limit as given, refused when it is not a whole number of at least one. */
function limitOf(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new NmtsError(`GATEWAY_LIMIT: \`${name}\` is a whole number of at least 1, not ${JSON.stringify(value)}.`, {
      exitCode: 2,
      nextStep: "Nothing is listening. Leave it out for the default.",
    });
  }
  return value;
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
  const overwrite = options.overwrite ?? "refuse";
  // ⛔ A WORD THAT IS NEITHER IS REFUSED, NOT READ AS ONE OF THEM. `overwrite: true` read as
  //    "refuse" would look like it worked until the first sync failed; read as "replace" it would
  //    send files to the trash nobody agreed to.
  if (overwrite !== "replace" && overwrite !== "refuse") {
    throw new NmtsError(`GATEWAY_OVERWRITE: \`overwrite\` is "replace" or "refuse", not ${JSON.stringify(overwrite)}.`, {
      exitCode: 2,
      nextStep: "Nothing is listening. Leave it out to refuse a different file at a taken key, which is the default.",
    });
  }
  const maxObjectBytes = limitOf("maxObjectBytes", options.maxObjectBytes);
  const maxConcurrentWrites = limitOf("maxConcurrentWrites", options.maxConcurrentWrites);
  const maxUploadsPerBucket = limitOf("maxUploadsPerBucket", options.maxUploadsPerBucket);
  const own = options.stagingDir === undefined;
  const stagingRoot = options.stagingDir ?? join(tmpdir(), `nmts-gateway-${process.pid}-${randomUUID()}`);
  // ⛔ MADE NOW, 0700, SO NOTHING LATER HAS TO ASK. Pieces of an upload are somebody's plaintext,
  //    and a directory made under a predictable name later, under whatever mask the process
  //    happens to have, is where another account on the machine reads them.
  if (own) mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const staging = createStagingStore(stagingRoot, {
    sweepEveryMs: SWEEP_EVERY_MS,
    ...(maxUploadsPerBucket === undefined ? {} : { maxUploadsPerBucket }),
  });
  const setup: DriveSetup = {
    stagingRoot,
    staging,
    locks: createKeyLocks(),
    writable,
    overwrite,
    maxObjectBytes,
    putOptions: options.putOptions,
  };

  /**
   * What `bucket(name)` answered, for a minute.
   *
   * ⛔ A RESOLVER IS SOMEBODY'S DATABASE. A sync tool makes thousands of requests and every one of
   *    them names a bucket; asking per request would put that load on the business's own lookup.
   *    ⚠ The minute is also how long a change there — a user removed, a bucket moved — takes to be
   *      seen here, unless the business says so with `forget(name)`.
   *
   * ⛔ NOTHING BUT THE ANSWER IS KEPT HERE, so forgetting it, or evicting it, loses nothing else:
   *    uploads in parts live in `staging`, which no entry of this map owns.
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
    const source = client === null ? null : driveOf(client, name, setup);
    remembered.delete(name);
    remembered.set(name, { at: now, source });
    while (remembered.size > BUCKET_CACHE_MAX) {
      const oldest = remembered.keys().next();
      if (oldest.done === true) break;
      remembered.delete(oldest.value);
    }
    return source;
  };

  const { bucketNames, virtualHostBase } = options;
  const gatewayOptions: GatewayOptions = {
    credentials,
    bucketOf,
    readOnlyBecause: READ_ONLY_BECAUSE,
    ...(maxConcurrentWrites === undefined ? {} : { maxConcurrentWrites }),
    ...(bucketNames === undefined ? {} : { bucketNames }),
    // ⚠ THE SAME CLOCK FOR A SIGNATURE'S AGE AS FOR THE BUCKET CACHE, so a test that holds one
    //   still is not signing against the other.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(virtualHostBase === undefined ? {} : { virtualHostBase }),
  };
  const answer = gatewayHandler(gatewayOptions);
  const logged = logEach(options.log, virtualHostBase);
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    logged(req, res);
    answer(req, res);
  };
  const continueCheck = checkContinueHandler(gatewayOptions, answer);
  const onContinue = (req: IncomingMessage, res: ServerResponse): void => {
    logged(req, res);
    continueCheck(req, res);
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
      const made = gatewayServer(handler, onContinue);
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
    refusalBeforeBody(req: IncomingMessage): EarlyRefusal | null {
      return refusalBeforeBody(req, gatewayOptions);
    },
    forget(bucket: string): void {
      remembered.delete(bucket);
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
      // ⛔ A FINISH STILL STORING IS WAITED FOR before anything is removed: its store is reading the
      //    joined file out of the staging folder, and removing it underneath would fail an upload
      //    the client was told had been accepted.
      await staging.close();
      // Nothing half-uploaded outlives the gateway that was staging it — but a directory the
      // caller named is the caller's, and this only made one when it was not given one.
      if (own) await rm(stagingRoot, { recursive: true, force: true });
    },
  };
}
