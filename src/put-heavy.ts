// `put(file, { tier: "heavy" })` — one file on NMTS Heavy: Filecoin PDP, whole copies kept by separate
// storage companies. Sealed here exactly as a Standard upload is; only where the sealed bytes go and
// who pays for them differ.
//
// ⛔ FOUR PAYERS, THE COMMAND-LINE TOOL'S OWN CODE FOR EACH.
//      credits           one order, credits taken when it opens (`heavyOrderPut`).
//      "wallet"          one order paid in WAL by one of this key's Sui wallets, sent only once every
//                        part is stored (`heavyWalletPut` — the price is read and the balances held
//                        against it before anything is sealed).
//      "evm"             this key's own EVM wallet pays Filecoin through the Synapse SDK
//                        (`heavySelfPut`) — no order, no NMTS money.
//      { signer }        the same, from an EVM account the caller holds: a business keeping its own key.
//    Every one works whoever holds the NMTS key — this process or a business's sealed store — because
//    the key is borrowed through `withAccount` exactly as the Standard rails borrow it.
//
// ⛔ AN OPTION THAT WOULD BE IGNORED IS A REFUSAL, as it is on the Standard rails: Standard's options
//    on Heavy, Heavy's options on Standard, and one payer's options on another payer.
//
// ⛔ A DRY RUN OPENS NO ORDER. An unpaid wallet order counts against the day's few, so a wallet dry run
//    names the paying address and the term and cannot name a price.

import {
  addEntry,
  copiesOf,
  DEFAULT_STORAGE_TIER,
  evmAccountFor,
  evmAddressFor,
  evmIndexOf,
  folderIdFor,
  HEAVY_COPY,
  heavyCredits,
  heavyOrderPut,
  heavySelfPut,
  heavyWalletPut,
  NmtsError,
  parseStorageTier,
  planHeavyFile,
  providersOf,
  selfPayChain,
  setTrashed,
  walletAddress,
  type EvmAccount,
  type HeavyCommitted,
  type HeavyFile,
  type HeavyOrderContext,
  type HeavyProgress,
  type HeavyWalletInput,
  type PlaintextSource,
  type SelfPayContext,
  type SelfPayProgress,
  type StorageTier,
} from "@needmoretruth/nmts-cli/portable";

import { readList } from "./list.ts";
import { destinationOf, pathOf, requireName, type PutOptions } from "./put.ts";
import { withAccount, withDataKey, type Held, type Opened } from "./session.ts";
import { requireWalletIndex } from "./wallets.ts";

/** Who pays for a Heavy upload. `{ signer }` here is an EVM account, not a Sui wallet. */
export type HeavyPayFrom = "credits" | "wallet" | "evm" | { signer: EvmAccount };

export interface HeavyPutOptions {
  /** NMTS Heavy: whole copies on Filecoin, kept by separate storage companies. */
  tier: "heavy";
  /** The name it gets in the account. Defaults to the local file's own name. Required for bytes. */
  name?: string | undefined;
  /** Destination folder as `list()` prints it. The top of the account when absent. */
  to?: string | undefined;
  /** Who pays. Credits when absent. */
  pay?: HeavyPayFrom | undefined;
  /** `pay: "wallet"`: which of this key's Sui wallets pays, by index. Absent = the account's paying wallet. */
  wallet?: number | undefined;
  /** `pay: "wallet"`: how many days of storage the order buys, 1 to 365. Default 28. */
  days?: number | undefined;
  /** `pay: "evm"`: which of this key's EVM wallets pays, by index. Default 0. */
  evmWallet?: number | undefined;
  /** `pay: "evm"` or `{ signer }`: how many companies keep a whole copy, 1 to 12. Default 2. */
  copies?: number | undefined;
  /** `pay: "evm"` or `{ signer }`: which companies, by registry id. Absent = the Synapse SDK chooses. */
  providers?: readonly (number | bigint)[] | undefined;
  /** Work out what it would cost and stop. Nothing is sealed, signed, opened or spent. */
  dryRun?: boolean | undefined;
  /** Told about each part as it is sealed, sent and stored. */
  onProgress?: ((event: HeavyProgress | SelfPayProgress) => void) | undefined;
}

type HeavyPayer = "credits" | "wallet" | "evm";

interface HeavyFacts {
  tier: "heavy";
  paid: HeavyPayer;
  name: string;
  path: string;
  bytes: number;
  sealedBytes: number;
  parts: number;
  /** Credits this call spends. 0 unless credits pay. */
  credits: number;
}

export interface HeavyPut extends HeavyFacts {
  dryRun: false;
  /** The server's id for the file. */
  id: string;
  renamed: boolean;
  /** The file-list version this write produced. */
  fileListVersion: number;
  /** WAL that left the wallet, in FROST, as a decimal string. "0" unless `pay: "wallet"`. */
  wal: string;
  /** The order that stored it; null when an EVM wallet paid, which opens none. */
  orderId: string | null;
  /** The WAL payment's Sui transaction digest; null unless `pay: "wallet"`. */
  txDigest: string | null;
  /** The Filecoin epoch the copies are kept until. */
  expiryEpoch: number;
  /** The `0x` address that paid Filecoin; null unless an EVM wallet paid. */
  paidBy: string | null;
  /** How many companies kept a whole copy of each part; null unless an EVM wallet paid. */
  copies: number[] | null;
}

export interface HeavyReview extends HeavyFacts {
  dryRun: true;
  /** The address that would pay: a Sui address for `"wallet"`, a `0x` EVM address otherwise; null for credits. */
  payer: string | null;
  /** Days the order would buy; null unless `pay: "wallet"`. */
  days: number | null;
  /** Copies asked for; null unless an EVM wallet pays. */
  copies: number | null;
}

/** The tier word, read the one way every interface reads it. Absent = Standard. */
export function tierOfPut(raw: unknown): StorageTier {
  if (raw === undefined) return DEFAULT_STORAGE_TIER;
  try {
    return parseStorageTier(String(raw));
  } catch (error) {
    throw new NmtsError(error instanceof Error ? error.message : String(error), { exitCode: 2 });
  }
}

/** True when the options ask for Heavy — by the tier word, however it was spelled. */
export function isHeavy(options: PutOptions | HeavyPutOptions): options is HeavyPutOptions {
  return tierOfPut(options.tier) === "heavy";
}

const HEAVY_ONLY = ["copies", "providers", "evmWallet", "days"];
const STANDARD_ONLY = ["partSize", "epochs", "storage", "onStep", "thumbnail"];

/** The name of the first option in `names` that was given a value. */
function givenOf(options: object, names: readonly string[]): string | undefined {
  return Object.entries(options).find(([key, value]) => names.includes(key) && value !== undefined)?.[0];
}

/** Whether a payer is an EVM account: what signs typed data and has a 20-byte address. */
function isEvmAccount(signer: unknown): boolean {
  return (
    typeof signer === "object" &&
    signer !== null &&
    "signTypedData" in signer &&
    typeof signer.signTypedData === "function" &&
    "address" in signer &&
    typeof signer.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(signer.address)
  );
}

/** Standard's side of the line: nothing that only Heavy reads, and no EVM payer. */
export function refuseHeavyOnStandard(options: PutOptions): void {
  const given = givenOf(options, HEAVY_ONLY);
  if (given !== undefined) throw new NmtsError(HEAVY_COPY.sdkHeavyOnly(given), { exitCode: 2 });
  const pay: unknown = options.pay;
  if (pay === "evm") throw new NmtsError(HEAVY_COPY.sdkHeavyOnly('pay: "evm"'), { exitCode: 2 });
  if (typeof pay === "object" && pay !== null && "signer" in pay && isEvmAccount(pay.signer)) {
    throw new NmtsError(HEAVY_COPY.sdkSuiSigner, { exitCode: 2 });
  }
}

/** Heavy's side: nothing only Standard reads, and each payer's options only on that payer. */
function payerOf(options: HeavyPutOptions): { payer: HeavyPayer; account: EvmAccount | null } {
  const given = givenOf(options, STANDARD_ONLY);
  if (given !== undefined) throw new NmtsError(HEAVY_COPY.sdkNotHeavy(given), { exitCode: 2 });
  const pay = options.pay ?? "credits";
  const account = typeof pay === "object" ? pay.signer : null;
  if (typeof pay === "object" && !isEvmAccount(pay.signer)) throw new NmtsError(HEAVY_COPY.sdkEvmSigner, { exitCode: 2 });
  const payer: HeavyPayer = pay === "credits" || pay === "wallet" ? pay : "evm";
  const refuse = (option: string, on: string): never => {
    throw new NmtsError(HEAVY_COPY.sdkPayerOnly(option, on), { exitCode: 2 });
  };
  if (payer !== "wallet" && options.wallet !== undefined) refuse("wallet", '"wallet"');
  if (payer !== "wallet" && options.days !== undefined) refuse("days", '"wallet"');
  if (pay !== "evm" && options.evmWallet !== undefined) refuse("evmWallet", '"evm"');
  if (payer !== "evm" && options.copies !== undefined) refuse("copies", '"evm" or { signer }');
  if (payer !== "evm" && options.providers !== undefined) refuse("providers", '"evm" or { signer }');
  return { payer, account };
}

/** 1..=365 days, 28 when absent. */
function daysOf(days: number | undefined): number {
  if (days === undefined) return 28;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new NmtsError(HEAVY_COPY.badDays(String(days)), { exitCode: 2 });
  return days;
}

/**
 * ⚠ Seams, not options: the order routes, the storage companies, the Synapse SDK, the chain's reads,
 * the WAL signature and the commit — what a test drives this exact code through.
 */
export interface HeavySeams {
  api?: HeavyOrderContext["api"];
  deps?: HeavyOrderContext["deps"];
  commit?: HeavyOrderContext["commit"];
  synapse?: SelfPayContext["synapse"];
  reads?: HeavyWalletInput["reads"];
  sign?: HeavyWalletInput["sign"];
}

/** Seal one file, store it on Heavy with whichever payer was named, and name it in the list. */
export async function putHeavy(
  opened: Opened,
  source: PlaintextSource,
  name: string,
  options: HeavyPutOptions,
  seams: HeavySeams = {},
): Promise<HeavyPut | HeavyReview> {
  requireName(name);
  const { payer, account } = payerOf(options);
  // Every value is judged before the key is borrowed and before anything opens.
  const days = payer === "wallet" ? daysOf(options.days) : null;
  const named = options.wallet === undefined ? null : requireWalletIndex(options.wallet);
  const evmIndex = evmIndexOf(options.evmWallet === undefined ? undefined : String(options.evmWallet));
  const copies = payer === "evm" ? copiesOf(options.copies) : null;
  const providers = providersOf(options.providers);
  const destination = destinationOf(options.to);
  return withAccount(opened, async (held) => {
    if (payer === "evm") selfPayChain(held.network);
    const { entries, padding: rule, activeWallet } = await readList(held);
    const parentId = folderIdFor(options.to, entries, "Nothing was sent and nothing was charged.");
    const plan = planHeavyFile(source.size, rule);
    const facts = {
      tier: "heavy" as const,
      paid: payer,
      name,
      path: pathOf(destination, name),
      bytes: source.size,
      sealedBytes: plan.reduce((sum, p) => sum + p.sealedLen, 0),
      parts: plan.length,
      credits: payer === "credits" ? heavyCredits(plan) : 0,
    };
    const wallet = named ?? activeWallet;
    if (options.dryRun === true) {
      const address =
        payer === "wallet" ? await walletAddress(held.code, wallet) : payer === "evm" ? (account?.address ?? (await evmAddressFor(held.code, evmIndex))) : null;
      return { ...facts, dryRun: true, payer: address, days, copies };
    }
    const file: HeavyFile = { source, name, parentId, destination };
    const stored = await withDataKey(held.code, async (crypt, dataKey) => {
      const ctx: HeavyOrderContext = { server: held.server, bearer: held.bearer, crypt, dataKey, rule, onProgress: options.onProgress, api: seams.api, deps: seams.deps, commit: seams.commit };
      if (payer === "credits") {
        const { run, files } = await heavyOrderPut(ctx, [file], { pay: "credits" });
        return { done: files, orderId: run.orderId, txDigest: null, wal: "0", expiryEpoch: run.expiryEpoch, paidBy: null, copies: null };
      }
      if (payer === "wallet") {
        const input = { code: held.code, network: held.network, wallet, termDays: days ?? 28, reads: seams.reads, sign: seams.sign };
        const { run, files, quote } = await heavyWalletPut(ctx, [file], input);
        return { done: files, orderId: run.orderId, txDigest: run.txDigest ?? null, wal: quote.walFrost.toString(), expiryEpoch: run.expiryEpoch, paidBy: null, copies: null };
      }
      const signer = account ?? (await evmAccountFor(held.code, evmIndex));
      const self = await heavySelfPut(
        { ...ctx, network: held.network, account: signer, copies: copies ?? 2, providers, onProgress: options.onProgress, synapse: seams.synapse },
        [file],
      );
      return { done: self.files, orderId: null, txDigest: null, wal: "0", expiryEpoch: self.expiryEpoch, paidBy: self.paidBy, copies: self.copies };
    });
    const { done, ...paid } = stored;
    const one = done[0];
    if (one === undefined) throw new NmtsError(HEAVY_COPY.commitNoId, { nextStep: HEAVY_COPY.commitNoIdNext });
    const added = await record(held, one);
    return { ...facts, ...paid, dryRun: false, id: one.itemId, name: added.name, path: pathOf(destination, added.name), renamed: added.name !== name, fileListVersion: added.seq };
  });
}

/** Name a stored Heavy file in the sealed list; a displaced file goes to the trash only after. */
async function record(held: Held, done: HeavyCommitted): Promise<{ name: string; seq: number }> {
  const now = Date.now();
  const added = await addEntry({
    server: held.server,
    apiKey: held.bearer,
    code: held.code,
    accountId: held.accountId,
    entry: {
      id: done.itemId,
      parentId: done.parentId,
      kind: 1,
      name: done.name,
      size: done.plaintextLen,
      createdAt: now,
      updatedAt: now,
      dekWrapped: done.dekWrapped,
      contentHashCt: done.contentHashCt,
    },
  });
  if (added.replaced) await setTrashed(held.server, held.bearer, added.replaced.id, true);
  return { name: added.name, seq: added.seq };
}
