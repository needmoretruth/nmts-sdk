// One client as a drive: its list, its reader, and the verbs a write goes through.
//
// ⚠ MOVED OUT OF `gateway.ts`, which had reached the length limit. `gateway.ts` builds one of these
//   every time it asks whose a bucket is; what the drives share — the staging of uploads in pieces,
//   the per-key locks — is made there once and handed to each.

import {
  createDriveSource,
  fetchObject,
  freeTrashedName,
  type DriveSource,
  type KeyLocks,
  type StagingStore,
  type WriteMeta,
} from "@needmoretruth/nmts-cli/s3-gateway";

import { readList } from "../list.ts";
import { insidesOf, type Nmts } from "../nmts.ts";
import type { PutOptions } from "../put.ts";
import { withAccount } from "../session.ts";

/** What `putOptions` may decide about one upload: which money pays, and for how long. */
export type GatewayPutOptions = Pick<PutOptions, "pay" | "epochs" | "storage">;

/** What every bucket's drive is built with: the same for all of them, fixed when the gateway is made. */
export interface DriveSetup {
  readonly stagingRoot: string;
  readonly staging: StagingStore;
  readonly locks: KeyLocks;
  readonly writable: boolean;
  readonly overwrite: "replace" | "refuse";
  readonly maxObjectBytes: number | undefined;
  readonly putOptions: ((bucket: string, meta: WriteMeta) => GatewayPutOptions | Promise<GatewayPutOptions>) | undefined;
}

/**
 * The three answers `putOptions` may give, and nothing else it returned.
 *
 * ⛔ PICKED, NOT SPREAD. The name, the folder and what a taken key does are the gateway's to say;
 *    an answer that carried a `name` of its own would otherwise store the file somewhere the key
 *    did not name.
 */
function paymentOf(chosen: GatewayPutOptions): GatewayPutOptions {
  return {
    ...(chosen.pay === undefined ? {} : { pay: chosen.pay }),
    ...(chosen.epochs === undefined ? {} : { epochs: chosen.epochs }),
    ...(chosen.storage === undefined ? {} : { storage: chosen.storage }),
  };
}

/**
 * One client as a drive.
 *
 * ⛔ THE VERBS ARE THE CLIENT'S OWN. An upload is `put`, a delete is `remove` — the trash, where
 *    the file stays recoverable for thirty days — and the folders above a key are `mkdir`. Writing
 *    a second upload path here would be a second place for what an upload costs to be decided.
 *
 * ⛔ AND WHAT A TAKEN NAME DOES IS SAID ON EVERY UPLOAD. `put` without it would follow whatever
 *    `nmts on-collision` says on the machine this runs on — a setting somebody chose for their own
 *    command line — so the gateway's own answer, "replace" or not, goes with each call.
 *
 * ⛔ THE ACCOUNT'S ID IS WHO OWNS AN UPLOAD IN PIECES. It is read once per drive, and an upload
 *    begun under another id — the bucket handed to somebody else since — is not this one's.
 */
export function driveOf(client: Nmts, bucket: string, setup: DriveSetup): DriveSource {
  const inside = insidesOf(client);
  const { putOptions } = setup;
  return createDriveSource({
    stagingRoot: setup.stagingRoot,
    staging: setup.staging,
    locks: setup.locks,
    bucket,
    writable: setup.writable,
    overwrite: setup.overwrite,
    maxObjectBytes: setup.maxObjectBytes,
    owner: () => withAccount(inside.opened(), async (held) => held.accountId),
    account: {
      readList: async () => withAccount(inside.opened(), async (held) => (await readList(held)).entries),
      withCode: (use) => inside.opened().root.withCode(use),
      makeFolder: async (path) => {
        await client.mkdir(path);
      },
      store: async (local, name, folder, how) => {
        const chosen = putOptions === undefined ? {} : paymentOf(await putOptions(bucket, how.meta));
        const stored = await client.put(local, {
          name,
          ...(folder === undefined ? {} : { to: folder }),
          onCollision: how.replace ? "overwrite" : "rename",
          ...chosen,
        });
        return { id: stored.id };
      },
      trash: async (path) => {
        await client.remove(path);
      },
      trashMany: async (paths) => {
        await client.remove(paths);
      },
      freeTrashedName: (folder, name) =>
        withAccount(inside.opened(), (held) =>
          freeTrashedName(
            { server: held.server, apiKey: held.bearer, code: held.code, accountId: held.accountId },
            folder,
            name,
          ),
        ),
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
