// Storage control: what the account's wallet holds, buying a file more time, and cutting, joining
// and handing over a resource.
//
// ⛔ WHY IT IS HERE. What the storage network sells is a Sui object with a size and a period, bought
//    from the account's own wallet. The command-line tool could already list, extend, split, merge
//    and transfer one and a program built on this package could not, so a business whose storage
//    was running out had to send somebody to a terminal — a reason to build on something else.
//
// ⛔ EVERY ONE OF THESE SPENDS, AND NOTHING COMES BACK. Extending moves WAL for the storage and SUI
//    for the fee; the other three move SUI for the fee alone. There is no agreement step — a library
//    has nobody to ask — so calling one IS the agreement, exactly as `put()` says, and `dryRun`
//    says what it would cost and signs nothing.
//
// ⛔ THE ACTS THEMSELVES ARE THE COMMAND-LINE PACKAGE'S `storage-control`, NOT A COPY. The order
//    that protects a wallet — read the chain, judge against the contract's rules, dry-run the exact
//    transaction for its fee, and only then sign — is written once, over there, and the commands and
//    these five verbs are the same functions with a different caller.
//
// ⛔ AND THE DELEGATED ROOT IS ASKED BEFORE THE SIGNATURE, NOT AFTER. Only one of these reaches the
//    server: an extension has to be recorded there, and that door needs `storage_spend`. A token
//    without it would be refused AFTER the WAL had left the wallet, so the token's own scope is read
//    here first — it is in the token, which this process holds.

import {
  DELEGATION_PREFIX,
  fromBase64Url,
  fromUtf8,
  NmtsError,
  SCOPE_BITS,
  walletAddress,
} from "@needmoretruth/nmts-cli/portable";
import {
  applyExtension,
  listStorage,
  planExtension,
  reshapeStorage,
  type ExtendPlan,
  type ExtendReads,
  type ReadWalletStorage,
  type ReshapeOutcome,
  type ReshapeSeams,
  type SignExtension,
  type SignStorageOp,
  type StorageOpAsk,
  type StorageOpReview,
  type StorageShape,
} from "@needmoretruth/nmts-cli/storage-control";

import { readList } from "./list.ts";
import { withAccount, type Opened } from "./session.ts";

/** One storage resource the account's wallet holds free — bought, and not bound inside a file. */
export interface StorageResourceInfo {
  /** The Sui object id. */
  id: string;
  /** What it can hold AFTER the network's encoding. ⚠ Not a plaintext size. */
  sizeBytes: number;
  startEpoch: number;
  endEpoch: number;
  /**
   * Where it stands against the network's current epoch. ⛔ NULL IS "THE EPOCH COULD NOT BE READ",
   * never "lapsed" — guessing would report a resource somebody paid for as over.
   */
  status: "usable" | "notYet" | "lapsed" | null;
}

/** The paying wallet, and what it holds. */
export interface StorageWallet {
  address: string;
  /**
   * What it holds now, in base units, as decimal strings. ⛔ NULL IS NOT ZERO: for an extension it
   * means the chain would not say, and for a reshaping nothing asks — the fee is the only cost.
   */
  wal: string | null;
  sui: string | null;
}

/** What a dry run says a change would cost. The same field names, and units, as `put()`'s review. */
interface Reviewed {
  /** Nothing was signed, sent or spent: this is what it would have cost. */
  dryRun: true;
  /** WAL it would spend, in FROST, as a decimal string. "0" for anything but an extension. */
  wal: string;
  /**
   * SUI it would spend, in MIST — the chain fee, measured by dry-running the exact transaction.
   * ⛔ NULL WHEN IT COULD NOT BE MEASURED, never 0: it is charged with the signature either way.
   */
  sui: string | null;
  wallet: StorageWallet;
  /** Set when the wallet is known to be short: both numbers. A real call throws instead of signing. */
  shortfall: string | null;
}

/** What a change that ran did. */
interface Signed {
  dryRun: false;
  /** The transaction digest — what the chain and the server both know this payment by. */
  digest: string;
}

/** `epochs` bought, and the epoch the storage runs to afterwards. */
type Extended = { epochs: number; endEpoch: number };
/** A cut: what the named resource is left as, and the resource the cut puts in this wallet. */
type Split = { keeps: StorageShape; creates: StorageShape };
/** A join: what the first resource becomes. The second is consumed. */
type Merged = { becomes: StorageShape };
/** A hand-over: size and remaining time, and where it went. ⛔ No file goes with it. */
type Transferred = { moves: StorageShape; to: string };

export type ExtendReview = Reviewed & Extended;
/**
 * ⚠ `recorded` IS ALWAYS TRUE. A recording that failed throws `EXTEND_RECORDED_LATE` instead:
 *   the storage is bought by then, and a caller that read `false` and retried would pay twice.
 */
export type ExtendResult = Signed & Extended & { recorded: true };
export type SplitReview = Reviewed & Split;
export type SplitResult = Signed & Split;
export type MergeReview = Reviewed & Merged;
export type MergeResult = Signed & Merged;
export type TransferReview = Reviewed & Transferred;
export type TransferResult = Signed & Transferred;

/** What `extend()` takes. */
export interface ExtendOptions {
  /** How many of the storage network's epochs to add. Default 2, the term the tool buys. */
  epochs?: number | undefined;
  /** Say what it would cost and stop. Nothing is signed and no key is derived for signing. */
  dryRun?: boolean | undefined;
  /**
   * Extend a file that is nowhere near its deadline. ⚠ Off by default because it spends now for
   * time the file does not need yet; extending early loses nothing, so this guards against
   * spending by accident rather than refusing on principle.
   */
  force?: boolean | undefined;
}

/** What the three reshaping calls take. */
export interface StorageOpOptions {
  /** Work out the fee and stop. Nothing is signed. */
  dryRun?: boolean | undefined;
}

/** What `splitStorage()` takes on top of that: what the named resource keeps, in bytes. */
export interface SplitOptions extends StorageOpOptions {
  sizeBytes: number;
}

/**
 * The chain and the signatures. ⚠ SEAMS, NOT OPTIONS — no caller of the methods reaches them, and a
 * test hands in fakes exactly as it does for `put()`'s wallet rail.
 */
export interface StorageSeams {
  readStorage?: ReadWalletStorage | undefined;
  readChain?: ((network: string) => Promise<ExtendReads> | ExtendReads) | undefined;
  sign?: SignExtension | undefined;
  reads?: ReshapeSeams["reads"];
  signStorage?: SignStorageOp | undefined;
}

/**
 * Every free storage resource the account's paying wallet holds, usable first. Nothing is spent.
 * What the network sells is size and time, not a file: deleting a file returns its remaining time
 * to this wallet, and that is what is listed.
 */
export async function storageResources(opened: Opened, seams: StorageSeams = {}): Promise<StorageResourceInfo[]> {
  return withAccount(opened, async (held) => {
    const address = await walletAddress(held.code, (await readList(held)).activeWallet);
    const listed = await listStorage({ network: held.network, address }, seams.readStorage);
    return listed.items.map((r) => ({
      id: r.objectId,
      sizeBytes: r.sizeBytes,
      startEpoch: r.startEpoch,
      endEpoch: r.endEpoch,
      status: r.status,
    }));
  });
}

/**
 * Buy one stored file more time on the storage network. **This spends WAL and SUI** out of the
 * wallet the account pays from, and none of it comes back. `dryRun: true` answers the price, the
 * wallet's balances and any shortfall, and signs nothing.
 */
export async function extendFile(
  opened: Opened,
  path: string,
  options: ExtendOptions = {},
  seams: StorageSeams = {},
): Promise<ExtendReview | ExtendResult> {
  if (path === "") {
    throw new NmtsError("Say which file to extend.", {
      exitCode: 2,
      nextStep: "Nothing was signed and nothing was charged. Pass the path as `list()` prints it.",
    });
  }
  return withAccount(opened, async (held): Promise<ExtendReview | ExtendResult> => {
    const input = { server: held.server, apiKey: held.bearer, code: held.code, accountId: held.accountId, network: held.network };
    const plan = await planExtension(input, path, {
      now: Date.now(),
      epochs: options.epochs,
      readChain: seams.readChain,
    });
    const { budget, facts } = plan;
    const bought = { epochs: facts.epochs, endEpoch: facts.newEndEpoch };
    if (options.dryRun === true) {
      const fee = budget.feeMist;
      return {
        dryRun: true,
        wal: budget.priceFrost.toString(),
        sui: fee === null ? null : fee.toString(),
        wallet: walletOf(plan),
        shortfall: budget.shortfall,
        ...bought,
      };
    }
    // ⛔ A FILE THAT IS NOT RUNNING OUT IS NOT EXTENDED BY ACCIDENT, and this is decided before the
    //    money moves rather than after.
    if (plan.stage === "later" && options.force !== true) {
      throw new NmtsError(`EXTEND_NOT_DUE: "${plan.path}" is not near the end of its storage term.`, {
        exitCode: 4,
        nextStep:
          "Nothing was signed and nothing was charged. Extending early loses nothing — the epochs " +
          "are added to what is left — but it spends now for time this file does not need yet. " +
          "Pass `force: true` to buy it anyway.",
      });
    }
    // ⛔ A WALLET KNOWN TO BE SHORT IS REFUSED BEFORE THE FIRST SIGNATURE, with both numbers.
    if (budget.shortfall !== null) {
      throw new NmtsError(budget.shortfall, {
        exitCode: 4,
        nextStep: `Nothing was signed and nothing was charged. Send what is missing to ${budget.address} and call this again.`,
      });
    }
    // ⛔ BEFORE THE SIGNATURE. The recording needs `storage_spend`; a token without it would be
    //    refused after the WAL had gone.
    refuseWithoutSpendScope(opened);

    const outcome = await applyExtension(input, plan, { sign: seams.sign });
    if (!outcome.recorded) {
      // ⛔ THE STORAGE IS EXTENDED AND PAID FOR. What failed is telling the NMTS server, and saying
      //    "the extension failed" would invite a second call — which pays again.
      throw new NmtsError(
        `EXTEND_RECORDED_LATE: the storage IS extended and paid for — transaction ${outcome.digest} — ` +
          `and the NMTS server was not told, so the account will go on showing the old date. ` +
          `Cause: ${outcome.notRecorded}`,
        {
          exitCode: 1,
          nextStep:
            "⛔ Do not call this again for this file: that would buy the same epochs a second time. " +
            "The date catches up when the account is opened in a browser, which reads the chain directly.",
        },
      );
    }
    return { dryRun: false, digest: outcome.digest, recorded: true, ...bought };
  });
}

/**
 * Cut one storage resource in two by size: it keeps `sizeBytes` and the rest becomes a second
 * resource in the same wallet, over the same period. **This spends SUI** for the chain fee.
 */
export async function splitStorageResource(
  opened: Opened,
  id: string,
  options: SplitOptions,
  seams: StorageSeams = {},
): Promise<SplitReview | SplitResult> {
  const outcome = await reshape(opened, { kind: "splitSize", objectId: id, keepBytes: options.sizeBytes }, options, seams);
  const result = outcome.review.plan.result;
  if (result.kind !== "split") throw notTheShape("split");
  const shapes = { keeps: result.keeps, creates: result.creates };
  return outcome.kind === "review" ? { ...reviewed(outcome.review), ...shapes } : { dryRun: false, digest: outcome.digest, ...shapes };
}

/**
 * Join two storage resources the wallet holds into one. The contract joins sizes only over an
 * identical period and periods only at an identical size; anything else is refused before a fee is
 * spent. **This spends SUI** for the chain fee.
 */
export async function mergeStorageResources(
  opened: Opened,
  idA: string,
  idB: string,
  options: StorageOpOptions = {},
  seams: StorageSeams = {},
): Promise<MergeReview | MergeResult> {
  const outcome = await reshape(opened, { kind: "merge", first: idA, second: idB }, options, seams);
  const result = outcome.review.plan.result;
  if (result.kind !== "merge") throw notTheShape("merge");
  const shapes = { becomes: result.becomes };
  return outcome.kind === "review" ? { ...reviewed(outcome.review), ...shapes } : { dryRun: false, digest: outcome.digest, ...shapes };
}

/**
 * Hand one storage resource to another Sui address. **This spends SUI** for the chain fee.
 *
 * ⛔ IT CANNOT BE UNDONE AND NO FILE GOES WITH IT. What goes is size and remaining time; the
 *    account's files stay sealed with keys its NMTS key derives and are unreadable to whoever
 *    receives the resource. Nobody — NMTS included — can recall it.
 */
export async function transferStorageResource(
  opened: Opened,
  id: string,
  toAddress: string,
  options: StorageOpOptions = {},
  seams: StorageSeams = {},
): Promise<TransferReview | TransferResult> {
  const outcome = await reshape(opened, { kind: "transfer", objectId: id, to: toAddress }, options, seams);
  const result = outcome.review.plan.result;
  if (result.kind !== "transfer") throw notTheShape("transfer");
  const shapes = { moves: result.moves, to: result.to };
  return outcome.kind === "review" ? { ...reviewed(outcome.review), ...shapes } : { dryRun: false, digest: outcome.digest, ...shapes };
}

/** The one path the three reshaping verbs take: one borrow of the key, one wallet, one order. */
async function reshape(
  opened: Opened,
  ask: StorageOpAsk,
  options: StorageOpOptions,
  seams: StorageSeams,
): Promise<ReshapeOutcome> {
  return withAccount(opened, async (held) => {
    const wallet = (await readList(held)).activeWallet;
    return reshapeStorage(
      { network: held.network, code: held.code, wallet, address: await walletAddress(held.code, wallet) },
      ask,
      { reads: seams.reads, sign: seams.signStorage, dryRun: options.dryRun === true },
    );
  });
}

/** The review fields every reshaping shares. ⚠ No WAL moves, and no balance was asked for. */
function reviewed({ address, feeMist }: StorageOpReview): Reviewed {
  const fee = feeMist === null ? null : feeMist.toString();
  return { dryRun: true, wal: "0", sui: fee, wallet: { address, wal: null, sui: null }, shortfall: null };
}

/** The paying wallet as an extension measured it. ⛔ An unread balance stays null, never 0. */
function walletOf({ budget }: ExtendPlan): StorageWallet {
  const { walFrost: wal, suiMist: sui } = budget;
  return {
    address: budget.address,
    wal: wal === null ? null : wal.toString(),
    sui: sui === null ? null : sui.toString(),
  };
}

/**
 * The scope bits the delegation token names, read from the token this process is holding — or null
 * when there is nothing to read them from (an API key, or a token this version cannot parse).
 *
 * ⚠ IT IS NOT A CHECK THAT THE TOKEN IS VALID. Whether the signature holds and whether it has run
 *   out are the server's judgement and stay there; what is read here is what the business minted
 *   the token FOR, which is the one thing a caller can act on before spending.
 */
function delegationScope(opened: Opened): number | null {
  const identity = opened.root.identity;
  if (identity.kind !== "delegation" || !identity.token.startsWith(DELEGATION_PREFIX)) return null;
  const payload = identity.token.slice(DELEGATION_PREFIX.length).split(".")[0];
  if (payload === undefined || payload === "") return null;
  try {
    const parsed: unknown = JSON.parse(fromUtf8(fromBase64Url(payload)));
    if (typeof parsed !== "object" || parsed === null) return null;
    const scope: unknown = Reflect.get(parsed, "s");
    return typeof scope === "number" && Number.isSafeInteger(scope) ? scope : null;
  } catch {
    // A token this cannot read is not a token this may refuse on: every request before the
    // signature already went through the server, which is the authority on what a token opens.
    return null;
  }
}

/** Refuse a delegated call that could sign and then fail to be recorded. */
function refuseWithoutSpendScope(opened: Opened): void {
  const scope = delegationScope(opened);
  if (scope === null || (scope & SCOPE_BITS.storage_spend) !== 0) return;
  throw new NmtsError(
    "DELEGATION_SCOPE: this delegation token was minted without `storage_spend`, so the NMTS server " +
      "would refuse to record the extension.",
    {
      exitCode: 3,
      nextStep:
        "Nothing was signed and nothing was charged — the check is made before the signature, " +
        "because the storage would already be paid for by the time the server refused. Ask the " +
        "business this account belongs to for a token that carries `storage_spend`.",
    },
  );
}

/** A plan whose result is not the shape its own verb asked for — a defect, said as one. */
function notTheShape(op: string): NmtsError {
  return new NmtsError(`The ${op} was planned as something else.`, {
    exitCode: 1,
    nextStep: "Nothing was signed. This is a defect in this package.",
  });
}
