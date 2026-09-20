// WHO PAYS: the account's credits, the wallet the NMTS key derives, or a wallet the caller holds the
// key to — and, for that last one, the seams the signatures travel through.
//
// ⛔ WHY IT IS ONE FILE. Four verbs spend — an upload, an extension, and cutting, joining or handing
//    over a storage resource — and until now every one of them could only spend the wallet this
//    account's key derives. A dapp built on this package could not let its user's own wallet pay for
//    the storage it was uploading, which is a reason to build on something else. What each verb
//    needed was the same three things: the payer's address judged before anything opens, that address
//    carried in before the price is measured, and the caller's wallet turned into the signature the
//    command-line package's seam expects. They are here once rather than in each of the four.
//
// ⛔ THE MODULE THAT CAN SPEND IS LOADED ON FIRST USE, NEVER ON IMPORT. Each factory below hands back
//    a function that imports the signer the first time it is called, so a dry run, a refused option
//    and a wallet that is short never bring the code that signs into memory — the rule the
//    command-line package keeps for its own signer — and a page that pays with credits never fetches
//    that chunk at all.
//
// ⛔ NO KEY IS EVER HELD HERE, and no signature is kept. The caller's function is asked once per
//    transaction and what it answers goes straight to the chain.

import { NmtsError, type WalletPutSeams } from "@needmoretruth/nmts-cli/portable";
import type { SignExtension, SignStorageOp } from "@needmoretruth/nmts-cli/storage-control";

/**
 * A wallet this package holds no key to, asked to sign one transaction at a time: a browser
 * extension, a hardware wallet, a remote signer.
 *
 * ⚠ THE SHAPE IS THE WALLET STANDARD'S, which is what a page already has. `signTransaction` is
 *   handed the bytes and answers `{ bytes, signature }` — exactly what dapp-kit's
 *   `useSignTransaction()` gives back, and what a `@mysten/sui` keypair answers too — and
 *   `Nmts.fromWallet`'s `sign` is the same bargain for logging in, so one wallet object serves both.
 */
export interface ExternalSigner {
  /**
   * The Sui address that pays: the sender of every transaction, and the address whose balances the
   * price is measured against.
   */
  address: string;
  /**
   * Asked once per transaction. `chain` is `sui:mainnet` or `sui:testnet`, so a wallet on the other
   * network refuses instead of signing.
   *
   * What comes back is the bytes that were signed — base64 or raw, as the standard allows — and the
   * signature over them. This package submits those bytes and reads the chain's effects itself: a
   * digest alone is not a success.
   */
  signTransaction(input: { bytes: Uint8Array; chain: string }): Promise<{
    bytes: Uint8Array | string;
    signature: string;
  }>;
}

/**
 * Which money buys the storage: the account's credits, the account's own wallet, or a wallet the
 * caller holds — `{ signer }`.
 */
export type PayFrom = "credits" | "wallet" | { signer: ExternalSigner };

/**
 * Whose wallet signs a change to storage that already exists, when it is not the one this account's
 * NMTS key derives.
 *
 * ⛔ THE THREE COSTS ARE `put()`'s, AND THEY ARE THE SAME HERE. Every transaction asks that wallet to
 *    sign, with no silent or automatic approval; storage it paid for is not found from the NMTS key
 *    alone, so recovering the account needs that address too; and what that wallet bought, only that
 *    wallet can extend or reshape — the chain lets nobody else touch it.
 */
export interface PayerOptions {
  /** A wallet you hold the key to, asked to sign this one change. */
  pay?: { signer: ExternalSigner } | undefined;
}

/** The wallet named in `pay`, or null when this is one of the two rails built on the NMTS key. */
export function signerOf(pay: PayFrom | undefined): ExternalSigner | null {
  return pay === undefined || pay === "credits" || pay === "wallet" ? null : pay.signer;
}

/** True for both wallet rails: the account's own wallet, and a wallet the caller holds. */
export function paysFromWallet(pay: PayFrom | undefined): boolean {
  return pay === "wallet" || signerOf(pay) !== null;
}

/**
 * A payer's address as the caller wrote it.
 *
 * ⛔ REFUSED, NEVER REPAIRED. This address is the sender of every transaction and the address the
 *    balances are read from; a value that is not an address at all would otherwise surface as a
 *    failure from deep inside a transaction builder, after the account had been opened.
 */
export function requirePayerAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
    throw new NmtsError("PAYER_ADDRESS: a paying wallet's address is `0x` and 64 hex characters.", {
      exitCode: 2,
      nextStep:
        "Nothing was sent and nothing was signed. Pass the address exactly as the wallet spells it — " +
        "in a page that is the connected account's own `address`.",
    });
  }
  return address;
}

/** The paying wallet a caller named, with its address already judged. Null = the account's own. */
export function payerOf(options: PayerOptions): { signer: ExternalSigner; address: string } | null {
  const signer = options.pay?.signer;
  return signer === undefined ? null : { signer, address: requirePayerAddress(signer.address) };
}

/** The signing module, fetched once however many signatures one call needs. */
async function signing(): Promise<typeof import("@needmoretruth/nmts-cli/wallet-sign-external")> {
  return import("@needmoretruth/nmts-cli/wallet-sign-external");
}

/** The two signatures one uploaded part needs: registering its blob, then certifying it. */
type BlobSigners = NonNullable<WalletPutSeams["sign"]>;

/** The caller's wallet as an upload's two signatures. Built on first use — see the header. */
export function blobSigners(signer: ExternalSigner): BlobSigners {
  let built: Promise<BlobSigners> | null = null;
  const pair = (): Promise<BlobSigners> => (built ??= signing().then((module) => module.externalBlobSigners(signer)));
  return {
    register: async (input) => (await pair()).register(input),
    certify: async (input) => (await pair()).certify(input),
  };
}

/** The caller's wallet as an extension's signature. Built on first use. */
export function extendSigner(signer: ExternalSigner): SignExtension {
  let built: Promise<SignExtension> | null = null;
  return async (input) => {
    built ??= signing().then((module) => module.externalExtendSigner(signer));
    return (await built)(input);
  };
}

/** The caller's wallet as a storage resource's signature. Built on first use. */
export function reshapeSigner(signer: ExternalSigner): SignStorageOp {
  let built: Promise<SignStorageOp> | null = null;
  return async (input) => {
    built ??= signing().then((module) => module.externalStorageOpSigner(signer));
    return (await built)(input);
  };
}
