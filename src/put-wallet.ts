// One file in, bought with A WALLET: the same seal-push-record path as the credit rail, with the
// storage bought on the Sui chain instead of out of the treasury. The shared types, the shared
// spellings and the credit rail itself are `put.ts`.
//
// ⛔ THIS IS THE FILE THAT SIGNS. `pay: "wallet"` spends WAL for the storage and SUI for the
//    relay's tip and the chain fees, out of the wallet this account pays from — `wallet` when the
//    caller named one, and otherwise the account's own number. None of it comes back and there is
//    no agreement step — a library has nobody to ask — so calling `put` IS the agreement, exactly
//    as the credit rail says.
//
// ⛔ AND `pay: { signer }` SPENDS SOMEBODY ELSE'S WALLET, which this package holds no key to. What
//    changes is only WHO IS ASKED: the payer's address goes in before anything is priced, so the
//    quote, both balances, the measured fee, the review and the sentence saying where to send coins
//    all name that wallet, and the signatures come from it instead of from this key. The order, the
//    refusals and the records are the same code either way — the command-line package's `walletPut`.
//
// ⛔ THE ORDER IS THE SAFETY, AND IT IS NOT THIS FILE'S. The price, both balances and a shortfall
//    all come before the first signature, and that order is the command-line tool's `walletPut`,
//    whose chain, signers and wire are handed in as seams. A second copy of it here would be a
//    second thing to keep right about money that cannot be got back.
//
// ⛔ NO STANDING GIFT AND NO SPENDING LEDGER. Both are a person's act on one machine under one
//    agreement; a library that kept either would be deciding for a caller who never asked it to.

import {
  folderIdFor,
  loadCrypto,
  NmtsError,
  walletPut,
  type PlaintextSource,
  type WalletPutReview,
  type WalletPutSeams,
} from "@needmoretruth/nmts-cli/portable";

import { readList } from "./list.ts";
import { blobSigners, requirePayerAddress, signerOf } from "./pay.ts";
import {
  DEFAULT_PART_BYTES,
  destinationOf,
  pathOf,
  requireName,
  type PutStorage,
  type RailOptions,
  type WalletPut,
  type WalletReview,
} from "./put.ts";
import { withAccount, type Opened } from "./session.ts";
import { requireWalletIndex } from "./wallets.ts";

/**
 * The chain, the signatures and the wire of this rail. ⚠ Seams, not options: no caller of `put()`
 * reaches them, and a test hands in fakes exactly as it does for the credit rail.
 */
export type WalletSeams = Pick<WalletPutSeams, "readChain" | "sign" | "protocol" | "api">;

/**
 * Seal, buy with the account's OWN WALLET, push and record one file.
 *
 * ⛔ NOBODY IS ASKED, BECAUSE THERE IS NOBODY TO ASK. The command-line tool prints the review and
 *    holds it against a standing wallet agreement; in a library the code that can spend is already
 *    in this process and the caller wrote the call, so calling this IS the agreement — exactly as
 *    the credit rail already says. What does not change is the order: the price, the balances and
 *    a shortfall all come before the first signature.
 */
export async function putSourceWithWallet(
  opened: Opened,
  source: PlaintextSource,
  name: string,
  options: RailOptions,
  seams: WalletSeams = {},
): Promise<WalletPut | WalletReview> {
  requireName(name);
  const destination = destinationOf(options.to);
  const signer = signerOf(options.pay);
  // ⛔ TWO PAYERS IN ONE CALL IS A MISTAKE, NOT A PREFERENCE. `wallet` names one of the wallets this
  //    NMTS key derives and `pay: { signer }` names a wallet it does not; whichever this package
  //    then picked, the other would be the one somebody had funded.
  if (signer !== null && options.wallet !== undefined) {
    throw new NmtsError("TWO_PAYERS: `wallet` names one of this key's wallets, and `pay: { signer }` names another wallet.", {
      exitCode: 2,
      nextStep:
        "Nothing was sent and nothing was signed. Drop `wallet` to pay from the signer you passed, " +
        "or drop the signer and pay from `wallet` — one call, one payer.",
    });
  }
  // ⛔ A NAMED WALLET AND A PAYER'S ADDRESS ARE JUDGED BEFORE ANYTHING IS OPENED: a number that is
  //    not one, or an address that is not one, is a call to fix, and refusing it here costs nobody
  //    the opening of a business's sealed store.
  const payer = signer === null ? null : { address: requirePayerAddress(signer.address) };
  const named = options.wallet === undefined ? null : requireWalletIndex(options.wallet);
  // ⛔ ONE BORROW FOR THE WHOLE RAIL. The code seals the file AND derives the wallet that signs,
  //    so `WalletPutContext.code` is the same borrowed copy the list was opened with rather than a
  //    second opening of a business's store partway through a call that is about to spend.
  return withAccount(opened, async (held) => {
    const { entries, padding: rule, activeWallet } = await readList(held);
    const parentId = folderIdFor(options.to, entries, "Nothing was sent and nothing was signed.");
    const outcome = await walletPut(
      {
        code: held.code,
        apiKey: held.bearer,
        server: held.server,
        network: held.network,
        accountId: held.accountId,
        crypt: await loadCrypto(),
        partSize: options.partSize ?? DEFAULT_PART_BYTES,
        rule,
        // ⛔ RESOLVED BEFORE ANYTHING IS PRICED, out of the list this call just read — the address
        //    the review names has to be the address that signs, and asking for the number later
        //    would let those two differ.
        wallet: named ?? activeWallet,
        // ⛔ AND WHEN SOMEBODY ELSE'S WALLET PAYS, IT IS PRICED INSTEAD OF THAT NUMBER. Everything
        //    the review says — the quote's sender, both balances, the measured fee, where to send
        //    coins — then names the wallet that will sign.
        ...(payer === null ? {} : { payer }),
      },
      { source, name, parentId, destination, ...(options.thumbOf === undefined ? {} : { thumbOf: options.thumbOf }) },
      {
        // ⚠ A `sign` the caller handed in wins: that is the seam a test drives this rail through.
        ...(signer === null ? {} : { sign: blobSigners(signer) }),
        ...seams,
        epochs: options.epochs,
        storage: options.storage,
        dryRun: options.dryRun,
        onStep: options.onStep,
        onProgress: options.onProgress,
      },
    );
    const { review } = outcome;
    if (outcome.kind === "review") {
      return {
        dryRun: true,
        paid: "wallet",
        name,
        path: pathOf(destination, name),
        bytes: review.bytes,
        sealedBytes: review.sealedBytes,
        parts: review.parts,
        credits: 0,
        wal: review.budget.walNeededFrost.toString(),
        sui: review.budget.suiNeededMist.toString(),
        epochs: review.epochs,
        endEpoch: review.endEpoch,
        storage: storageOf(review),
        wallet: {
          address: review.budget.address,
          wal: review.budget.walFrost === null ? null : review.budget.walFrost.toString(),
          sui: review.budget.suiMist === null ? null : review.budget.suiMist.toString(),
        },
        shortfall: review.budget.shortfall,
      };
    }
    return {
      dryRun: false,
      paid: "wallet",
      id: outcome.itemId,
      name: outcome.savedAs,
      path: pathOf(destination, outcome.savedAs),
      bytes: review.bytes,
      sealedBytes: review.sealedBytes,
      parts: review.parts,
      credits: 0,
      // ⛔ A RESUMED RUN SIGNED NOTHING NOW, so it spent nothing now — the same answer `credits`
      //    gives on the other rail, and what a caller adding up a month of uploads needs it to say.
      wal: outcome.resumed ? "0" : review.budget.walNeededFrost.toString(),
      sui: outcome.resumed ? "0" : review.budget.suiNeededMist.toString(),
      endEpoch: review.endEpoch,
      resumed: outcome.resumed,
      renamed: outcome.savedAs !== name,
      fileListVersion: outcome.fileListVersion,
    };
  });
}

/** The storage choice without the chain row it was picked from — the numbers a caller can use. */
function storageOf(review: WalletPutReview): PutStorage {
  const { storage } = review;
  return storage.kind === "buy"
    ? { kind: "buy" }
    : { kind: "reuse", objectId: storage.objectId, cutToBytes: storage.cutToBytes, leftoverBytes: storage.leftoverBytes };
}
