// `nmts.buyStorage({ sizeBytes, epochs })` — buying a storage resource with no file, beside
// `splitStorage`, `mergeStorage` and `transferStorage`. **It spends WAL and SUI.**
//
// ⛔ WHY (spec 2026-09-20 Deponejo · gap B2). A business that keeps one large resource and cuts a
//    piece off it for each customer had no way to buy that resource through NMTS: storage was only
//    bought inside an upload. This is the CLI's `nmts wallet storage buy`, the same function
//    (`buyStorage` in the CLI's `storage-control/buy.ts`), with the terminal taken off.
//
// ⛔ THE PAYER IS THE RESHAPING VERBS' PAYER: the account's own wallet, or `pay: { signer }`, whose
//    address then receives the resource. A delegation token must carry `storage_spend` — buying is
//    spending — and that is read from the token before anything is priced or signed.

import { walletAddress } from "@needmoretruth/nmts-cli/portable";
import { buyStorage as buy, type BuyReview, type BuySeams } from "@needmoretruth/nmts-cli/storage-control";

import { readList } from "./list.ts";
import { payerOf, reshapeSigner, type PayerOptions } from "./pay.ts";
import { withAccount, type Opened } from "./session.ts";
import { refuseWithoutSpendScope, type StorageWallet } from "./storage.ts";

/** What `buyStorage()` takes. */
export interface BuyStorageOptions extends PayerOptions {
  /**
   * The resource's size in bytes AFTER the network's encoding — the unit `storage()` lists and
   * `splitStorage` cuts by. ⚠ Not a file's size: a file needs more once encoded.
   */
  sizeBytes: number;
  /** Storage-network epochs from the current one. Default 2. */
  epochs?: number | undefined;
  /** Work out the price and the fee and stop. Nothing is signed. */
  dryRun?: boolean | undefined;
}

/** What a purchase would be, or was. Base units as decimal strings, like every review here. */
interface Bought {
  sizeBytes: number;
  epochs: number;
  startEpoch: number;
  endEpoch: number;
}

export type BuyStorageReview = Bought & {
  dryRun: true;
  /** WAL it would spend, in FROST. */
  wal: string;
  /** The chain fee the dry run measured, in MIST. ⛔ NULL WHEN UNMEASURED, never 0. */
  sui: string | null;
  wallet: StorageWallet;
  /** Set when the wallet is known to be short: both numbers. A real call throws instead of signing. */
  shortfall: string | null;
};

export type BuyStorageResult = Bought & {
  dryRun: false;
  digest: string;
  /** The new resource's id — what `put(…, { storage: id })` and `splitStorage(id)` take. Null if the chain did not name it. */
  id: string | null;
  wal: string;
};

/** ⚠ SEAMS, NOT OPTIONS — a test hands in the chain and the signature. */
export interface BuyStorageSeams {
  reads?: BuySeams["reads"];
  signStorage?: BuySeams["sign"];
}

function shapeOf(review: BuyReview): Bought {
  return { sizeBytes: review.sizeBytes, epochs: review.epochs, startEpoch: review.startEpoch, endEpoch: review.endEpoch };
}

/** Buy one storage resource of `sizeBytes` for `epochs`, paid by the account's wallet or `pay`. */
export async function buyStorageResource(
  opened: Opened,
  options: BuyStorageOptions,
  seams: BuyStorageSeams = {},
): Promise<BuyStorageReview | BuyStorageResult> {
  const payer = payerOf(options);
  return withAccount(opened, async (held) => {
    if (options.dryRun !== true) await refuseWithoutSpendScope(opened, "and buying storage spends from the wallet");
    const wallet = (await readList(held)).activeWallet;
    const outcome = await buy(
      {
        network: held.network,
        code: held.code,
        wallet,
        address: payer?.address ?? (await walletAddress(held.code, wallet)),
      },
      { sizeBytes: options.sizeBytes, epochs: options.epochs },
      {
        reads: seams.reads,
        sign: seams.signStorage ?? (payer === null ? undefined : reshapeSigner(payer.signer)),
        dryRun: options.dryRun === true,
      },
    );
    const { review } = outcome;
    if (outcome.kind === "review") {
      return {
        dryRun: true,
        ...shapeOf(review),
        wal: review.priceFrost.toString(),
        sui: review.feeMist === null ? null : review.feeMist.toString(),
        wallet: {
          address: review.address,
          wal: review.walFrost === null ? null : review.walFrost.toString(),
          sui: review.suiMist === null ? null : review.suiMist.toString(),
        },
        shortfall: review.shortfall,
      };
    }
    return { dryRun: false, ...shapeOf(review), digest: outcome.digest, id: outcome.objectId, wal: review.priceFrost.toString() };
  });
}
