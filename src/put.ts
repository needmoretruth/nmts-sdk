// One file in, bought with the account's CREDITS: sealed here, its storage bought, the sealed bytes
// pushed, and the file named in the account's sealed list. The other rail — the account's own
// wallet — is `put-wallet.ts`; everything else about an upload is the same on both, and the answers
// both rails give live here because `put()` returns one of them and a caller reads them as one shape.
//
// ⛔ THE ONLY THING IN THIS PACKAGE THAT SPENDS, WITH ITS OTHER RAIL. Credits are storage a donation
//    pool has already paid the network for. Neither rail's money comes back. There is no agreement
//    step here as there is in the command-line tool — a library has nobody to ask — so calling `put`
//    IS the agreement, and the README says so before it says how.
//
// ⛔ THE PLAINTEXT NEVER LEAVES THIS PROCESS. What goes to the storage network is the sealed
//    stream; what goes to the server is its length and a name that is itself inside the sealed
//    list. The machinery that keeps a half-finished upload from becoming money that bought nothing
//    is the command-line tool's own (`uploadFile`); this file only wires it.
//
// ⛔ THE RAIL IS A PARAMETER. The server and the relay are handed in, so a test drives this exact
//    code against fakes rather than a second copy of the order that decides when money moves.
//
// ⛔ NO SPENDING LEDGER. The command-line tool holds one, because a ledger counts what one machine
//    signed under one agreement. A library that kept one would be deciding for a caller who never
//    asked it to.

import {
  addEntry,
  clearItemRecord,
  clearReservation,
  CREDIT_BYTES,
  folderIdFor,
  NmtsError,
  partKeysOf,
  planAndPrice,
  setTrashed,
  UPLOAD_EPOCHS,
  uploadFile,
  type BlobProtocol,
  type FileUploadStep,
  type PlaintextSource,
  type UploadApi,
} from "@needmoretruth/nmts-cli/portable";

import { readList } from "./list.ts";
import type { PayFrom } from "./pay.ts";
import { withAccount, withDataKey, type Opened } from "./session.ts";

/** 64 MiB — the same part size the command-line tool uses when nobody says otherwise. */
export const DEFAULT_PART_BYTES = 64 * 2 ** 20;

/** The two things a credit-paid upload talks to: the server that sells storage, the relay. */
export interface UploadRail {
  api: UploadApi;
  protocol: BlobProtocol;
  relayUrl: string;
  /** The storage network's current epoch, when it could be read. */
  currentEpoch: number | null;
}

export interface PutOptions {
  /** The name it gets in the account. Defaults to the local file's own name. Required for bytes. */
  name?: string | undefined;
  /** Destination folder as `list()` prints it, `photos/2026`. The top of the account when absent. */
  to?: string | undefined;
  /**
   * How much of the file goes into one part, in bytes. Defaults to 64 MiB.
   *
   * Bigger parts mean fewer reservations against the account's daily allowance; smaller parts
   * mean less memory and a shorter piece of work to lose when something goes wrong.
   */
  partSize?: number | undefined;
  /**
   * Which money buys the storage: the account's credits (the default), the account's own wallet, or
   * a wallet you hold the key to. Either wallet spends WAL for the storage and SUI for the relay's
   * tip and the chain fees.
   *
   * `pay: { signer }` is somebody's OWN wallet, and it costs three things — said here because this
   * is where it is chosen:
   *
   * ⛔ EVERY TRANSACTION ASKS THAT WALLET TO SIGN. Nothing is approved silently or automatically and
   *    nothing can be batched: one part of a file is two signatures, registering and certifying, so
   *    a four-part file asks eight times. The parts are NOT uploaded in parallel either — a wallet
   *    is asked one transaction at a time, in order.
   * ⛔ A FILE PAID FOR THIS WAY IS NOT FOUND FROM THE NMTS KEY ALONE. The storage belongs to that
   *    wallet's address, so recovering the account needs the ADDRESS as well as the key to find what
   *    was stored; storage the account's own wallet paid for comes out of the key itself.
   * ⛔ WHAT THIS WALLET PAID FOR, THIS WALLET EXTENDS AND RESHAPES. `extend()` and the three storage
   *    verbs have to be signed by the address that bought the storage — the chain lets nobody else
   *    touch it — so they take the same `pay`. `erase({ releaseStorage: true })` destroys only what
   *    credits bought; storage a wallet bought stays on the network until its term ends.
   */
  pay?: PayFrom | undefined;
  /**
   * A wallet rail only: which of this key's wallets pays, by index. Absent = the one the account
   * pays from. Naming one here is for this upload alone and writes nothing —
   * `setActiveWallet()` is how an account changes which wallet pays.
   *
   * ⛔ NOT WITH `pay: { signer }`, which names a wallet this key does not derive. Two payers in one
   *    call is a mistake rather than a preference, so it is refused.
   */
  wallet?: number | undefined;
  /** A wallet rail only: how many of the storage network's epochs to buy. Default 2. */
  epochs?: number | undefined;
  /**
   * A wallet rail only: use a storage resource the paying wallet already holds instead of buying new
   * storage. `fit` cuts the smallest one that fits and leaves the rest free, `whole` binds one
   * whole, and an object id names one. A held resource serves a one-part file.
   */
  storage?: string | undefined;
  /** Work out what it would cost and stop. Nothing is sealed, signed, sent or spent. */
  dryRun?: boolean | undefined;
  /** Told about each step as it starts, so a long upload visibly moves. */
  onStep?: ((step: FileUploadStep) => void) | undefined;
  /** Told as sealed bytes leave for the relay — the honest measure of an upload's progress. */
  onProgress?: ((sent: number, total: number) => void) | undefined;
  /**
   * For a video: a small picture (a JPEG frame) sent after it as `<saved name>.thumb.jpg`, linked
   * to it so every app shows it as the video's tile. It is a second upload, priced and paid for
   * on the same rail; its answer is the video's `thumbnail`. Refused for a file that is not a video.
   */
  thumbnail?: Uint8Array | Blob | undefined;
}

/** `PutOptions` as a rail reads them: `thumbOf` links a preview picture to its stored video. */
export type RailOptions = Omit<PutOptions, "thumbnail"> & { thumbOf?: string | undefined };

/** Where a wallet-paid part's storage came from. */
export type PutStorage =
  | { kind: "buy" }
  | {
      kind: "reuse";
      objectId: string;
      /** Bytes the resource was cut down to first, or null when it was bound whole. */
      cutToBytes: number | null;
      /** What the resource holds beyond this file — left free by a cut, bound with it when whole. */
      leftoverBytes: number;
    };

/** What every answer about one upload says, whoever paid and whether or not it ran. */
interface PutFacts {
  /** The name it got — numbered, `report (2).pdf`, if the requested one was taken. */
  name: string;
  /** Full path in the account. */
  path: string;
  /** Plaintext bytes. */
  bytes: number;
  /** Bytes the storage network holds for it, padding and sealing included. */
  sealedBytes: number;
  parts: number;
  /** When `thumbnail` was passed: the picture's own answer, a review when this is one. */
  thumbnail?: PutResult | PutReview;
}

interface Uploaded extends PutFacts {
  dryRun: false;
  /** The server's id for the file. */
  id: string;
  resumed: boolean;
  renamed: boolean;
  /** The file-list version this write produced. */
  fileListVersion: number;
}

export interface CreditsPut extends Uploaded {
  paid: "credits";
  /** Credits this call spent. 0 when it finished an upload an earlier call had already paid for. */
  credits: number;
}

export interface WalletPut extends Uploaded {
  paid: "wallet";
  /** Always 0: a wallet-paid upload takes no credits from the account. */
  credits: 0;
  /**
   * WAL that left the wallet, in FROST — the chain's smallest unit, as a decimal string because
   * a JSON number would round it. "0" when this call resumed one an earlier call paid for.
   */
  wal: string;
  /** SUI that left the wallet, in MIST: the relay's tip plus the measured register fees. */
  sui: string;
  /** The epoch the storage runs to. */
  endEpoch: number;
}

/** What `put()` answers. Narrow on `paid` to read the numbers of one rail. */
export type PutResult = CreditsPut | WalletPut;

interface Reviewed extends PutFacts {
  /** Nothing was sealed, signed, sent or spent: this is what it would have cost. */
  dryRun: true;
}

export interface CreditsReview extends Reviewed {
  paid: "credits";
  credits: number;
}

export interface WalletReview extends Reviewed {
  paid: "wallet";
  credits: 0;
  /** WAL it would spend, in FROST, as a decimal string. */
  wal: string;
  /** SUI it would spend, in MIST: the relay's tip plus the measured register fees. */
  sui: string;
  epochs: number;
  endEpoch: number;
  storage: PutStorage;
  /** The paying wallet: its address, and what it holds — null for a balance the chain would not say. */
  wallet: { address: string; wal: string | null; sui: string | null };
  /**
   * Set when the wallet is short: the sentence naming both numbers. A real `put()` with these
   * numbers would throw rather than sign.
   */
  shortfall: string | null;
}

/** What `put({ dryRun: true })` answers. */
export type PutReview = CreditsReview | WalletReview;

/** Bytes already in memory, read as a source. Copies each piece it yields. */
export function bytesSource(bytes: Uint8Array): PlaintextSource {
  return {
    size: bytes.length,
    async *read(offset: number, length: number): AsyncIterable<Uint8Array> {
      const end = Math.min(offset + length, bytes.length);
      const chunk = 4 * 2 ** 20;
      for (let at = offset; at < end; at += chunk) {
        yield bytes.slice(at, Math.min(at + chunk, end));
      }
    },
  };
}

/** The reservation key names the destination as typed; this is the one spelling of "as typed". */
export function destinationOf(to: string | undefined): string {
  return (to ?? "").replace(/^\.?\//, "").replace(/\/$/, "");
}

export function pathOf(destination: string, name: string): string {
  return destination === "" ? name : `${destination}/${name}`;
}

export function requireName(name: string): void {
  if (name.length === 0) {
    throw new NmtsError("The file has no name.", {
      exitCode: 2,
      nextStep: "Nothing was sent. Pass `name` — bytes in memory have no name of their own.",
    });
  }
}

/**
 * ⛔ AN OPTION THAT WOULD BE IGNORED IS A REFUSAL, not a shrug. `epochs` and `storage` buy a term
 *    and a resource on the chain, and `wallet` says which wallet signs for them; credits buy a
 *    fixed term from the treasury, hold no resource and are signed for by nobody, so a caller who
 *    asked for any of the three and paid with credits did not get what they asked for.
 */
function refuseWalletOnlyOptions(options: PutOptions): void {
  const asked =
    options.wallet !== undefined
      ? "wallet"
      : options.epochs !== undefined
        ? "epochs"
        : options.storage !== undefined
          ? "storage"
          : null;
  if (asked === null) return;
  throw new NmtsError(`\`${asked}\` only applies when a wallet is paying.`, {
    exitCode: 2,
    nextStep: `Nothing was sent and nothing was charged. Add \`pay: "wallet"\` to buy the storage from the account's own wallet — or \`pay: { signer }\` to buy it from a wallet you hold — or drop \`${asked}\` to pay with credits.`,
  });
}

/**
 * Seal, buy with CREDITS, push and record one file.
 *
 * `rail` is asked for after the price is known, because the relay's timeout is sized to the
 * sealed length, and a rail built before the plan would have to guess it.
 */
export async function putSource(
  opened: Opened,
  source: PlaintextSource,
  name: string,
  options: RailOptions,
  rail: (sealedBytes: number) => Promise<UploadRail>,
): Promise<CreditsPut | CreditsReview> {
  requireName(name);
  refuseWalletOnlyOptions(options);
  const destination = destinationOf(options.to);
  const partSize = options.partSize ?? DEFAULT_PART_BYTES;
  // ⛔ THE REFUSALS ABOVE COST NO KEY. Everything from here needs the account's code, and this is
  //    the one place this call borrows it — whoever holds it, and however many requests follow.
  return withAccount(opened, async (held) => {
    // ⛔ THE LIST IS READ BEFORE THE PRICE IS QUOTED. The rounding rule that hides a file's true size
    //    lives in the sealed list, it changes how many bytes are stored, and so it changes the price.
    //    And it is read before anything is sealed or paid for, so a destination that does not exist
    //    stops the upload while there is still nothing to lose.
    const { entries, padding: rule } = await readList(held);
    const parentId = folderIdFor(options.to, entries, "Nothing was sent and nothing was charged.");
    const { plan, sealedBytes, credits } = planAndPrice(source.size, partSize, rule);
    if (options.dryRun === true) {
      // ⛔ Nothing above this line spent anything and nothing below it runs. The price is arithmetic
      //    on the file's size and the account's rounding rule — the same arithmetic the server does.
      return { dryRun: true, paid: "credits", name, path: pathOf(destination, name), bytes: source.size, sealedBytes, parts: plan.length, credits };
    }
    const built = await rail(sealedBytes);

    const result = await withDataKey(held.code, (crypt, dataKey) =>
      uploadFile({
        api: built.api,
        protocol: built.protocol,
        crypt,
        dataKey,
        source,
        name,
        parentId,
        destination,
        relayUrl: built.relayUrl,
        epochs: UPLOAD_EPOCHS,
        currentEpoch: built.currentEpoch,
        partSize,
        padding: { rule, unitBytes: CREDIT_BYTES },
        ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
      }),
    );

    const now = Date.now();
    // ⛔ FROM `result.entry`, NOT FROM THIS CALL. The key that opens the stored bytes is the key they
    //    were sealed with, which on a resume belongs to the call that sealed them.
    const added = await addEntry({
      server: held.server,
      apiKey: held.bearer,
      code: held.code,
      accountId: held.accountId,
      entry: {
        id: result.itemId,
        parentId,
        kind: 1,
        name: result.entry.name,
        size: result.entry.plaintextLen,
        createdAt: now,
        updatedAt: now,
        dekWrapped: result.entry.dekWrapped,
        contentHashCt: result.entry.contentHashCt,
        ...(options.thumbOf === undefined ? {} : { thumbOf: options.thumbOf }),
      },
    });
    // ⛔ ONLY NOW, AND EVERY PART. Until the entry is in the list the file is paid for and invisible,
    //    and the records are what let a second call finish the job without spending again.
    clearItemRecord(result.fileKey);
    for (const record of partKeysOf(result.fileKey, result.parts)) clearReservation(record);
    // The displaced file, when this machine is set to overwrite, goes to the trash on the server
    // only after the new one is in the list — until then the caller still had the file they started with.
    if (added.replaced) await setTrashed(held.server, held.bearer, added.replaced.id, true);

    return {
      dryRun: false,
      paid: "credits",
      id: result.itemId,
      name: added.name,
      path: pathOf(destination, added.name),
      bytes: source.size,
      sealedBytes,
      parts: plan.length,
      credits: result.resumed ? 0 : credits,
      resumed: result.resumed,
      renamed: added.name !== name,
      fileListVersion: added.seq,
    };
  });
}

/**
 * A file path's own name, for `put("/tmp/x/report.pdf")`.
 *
 * ⚠ BOTH SEPARATORS, because a path typed on Windows uses one this package would otherwise carry
 *   into the account as part of the name. `node:path` is not imported for it: this module is one
 *   of the ones a browser loads, and a path is the one input a browser never has.
 */
export function nameOf(localPath: string): string {
  const cut = Math.max(localPath.lastIndexOf("/"), localPath.lastIndexOf("\\"));
  return cut < 0 ? localPath : localPath.slice(cut + 1);
}

/**
 * What `put()` takes.
 *
 * ⛔ THE PATH IS NODE'S AND THE `Blob` IS EVERYBODY'S. A page has no file paths, so the browser
 *    entry's `PutInput` has no `string` in it and a path there is refused rather than read as a
 *    name. Bytes and a `Blob` work in both — Node has had `Blob` since 18 — so a program that
 *    already holds either hands it over the same way whichever side it is running on.
 */
export type PutInput = string | { name: string; bytes: Uint8Array } | { name: string; blob: Blob };

/** What the browser entry's `put()` takes: the same, without the path. */
export type BrowserPutInput = Exclude<PutInput, string>;
