// A business keeping its users' files alive from its own wallet, on a schedule, with no user's key
// and no user's device anywhere near it.
//
// ⛔ WHY IT IS HERE. A sponsored upload (`sponsor.ts`) leaves the storage in the business's wallet,
//    and storage runs out. Before this, the only way to buy it more time was `extend(path)`, which
//    opens the user's file list — the user's key, on the user's device. A business that paid for its
//    users' storage could not keep paying without asking each of them to open the app, so every
//    business that wanted that had to build it itself.
//
// ⛔ WHO PAYS CHOSE TO. This spends the OPERATOR's WAL — the account this client was opened with, or
//    the wallet in `pay` — on storage that wallet holds. It is not a person's money leaving on its
//    own. A person's storage is extended only when that person approves it, every time, and a
//    person's wallet is never the payer here.
//
// ⛔ THE USER'S PART IS A DELEGATION TOKEN, AND ONLY THAT. It lists the user's rows, names each
//    file's blobs and records each new date (`files_read` and `storage_spend`). File names are inside
//    the user's sealed list and stay there: files are named by id.
//
// ⛔ THE ACT ITSELF IS THE COMMAND-LINE PACKAGE'S `extendFor`, NOT A COPY. `nmts wallet storage
//    extend` is the same function with a terminal over it.

import { NmtsError, signExtension, walletAddress } from "@needmoretruth/nmts-cli/portable";
import {
  extendFor as extendForCore,
  type ExtendForResult,
  type ExtendReads,
  type SignExtension,
} from "@needmoretruth/nmts-cli/storage-control";

import { readList } from "./list.ts";
import { extendSigner, payerOf, type PayerOptions } from "./pay.ts";
import { withAccount, type Opened } from "./session.ts";
import { refuseWithoutSpendScope } from "./storage.ts";

export type { ExtendForFile, ExtendForResult } from "@needmoretruth/nmts-cli/storage-control";

/** The user's delegation token, or something that hands it over when asked. */
export type UserToken = string | (() => string | Promise<string>);

export interface ExtendForOptions extends PayerOptions {
  /** Item ids to extend. Absent = every file of the user's that is not in the trash. */
  items?: readonly string[] | undefined;
  /** Epochs to add to each file. Default 2 (`DEFAULT_EXTEND_EPOCHS`). */
  epochs?: number | undefined;
  /** Extend files that are not near their end yet too. Without it those are skipped as not due. */
  force?: boolean | undefined;
  /** Price every file and sign nothing. */
  dryRun?: boolean | undefined;
}

/** The chain and the signature. ⚠ Seams for tests, not options. */
export interface ExtendForSeams {
  readChain?: ((network: string) => Promise<ExtendReads> | ExtendReads) | undefined;
  sign?: SignExtension | undefined;
}

/**
 * Extend a user's files from this account's wallet (or `pay`'s). **This spends WAL and SUI** unless
 * `dryRun` is set. Files the paying wallet does not hold are skipped as `EXTEND_NOT_OWNED` before
 * anything is signed.
 */
export async function extendForUser(
  opened: Opened,
  user: UserToken,
  options: ExtendForOptions = {},
  seams: ExtendForSeams = {},
): Promise<ExtendForResult> {
  const token = await tokenOf(user);
  const payer = payerOf(options);
  return withAccount(opened, async (held) => {
    // ⛔ THIS CLIENT'S OWN TOKEN, WHEN IT HAS ONE, must allow spending from its wallet.
    await refuseWithoutSpendScope(opened, "and extending a user's files spends from this wallet");
    const wallet = payer === null ? (await readList(held)).activeWallet : 0;
    const address = payer?.address ?? (await walletAddress(held.code, wallet));
    const sign: SignExtension =
      seams.sign ?? (payer === null ? signExtension : extendSigner(payer.signer));
    return extendForCore(
      { server: held.server, network: held.network, token, payer: address },
      { items: options.items, epochs: options.epochs, force: options.force, dryRun: options.dryRun },
      {
        readChain: seams.readChain,
        now: Date.now(),
        sign: ({ objectIds, epochs }) => sign({ network: held.network, code: held.code, wallet, objectIds, epochs }),
      },
    );
  });
}

/** The token as a string, refusing anything that is not one before anything is read. */
async function tokenOf(user: UserToken): Promise<string> {
  const value: unknown = typeof user === "string" ? user : await user();
  if (typeof value !== "string" || value.trim() === "") {
    throw new NmtsError("Pass the user's delegation token.", {
      exitCode: 2,
      nextStep:
        "Nothing was signed and nothing was charged. Mint one with `business.delegate({ user, scope: " +
        "[\"files_read\", \"storage_spend\"] })` and pass it, or a function that returns it.",
    });
  }
  return value.trim();
}
