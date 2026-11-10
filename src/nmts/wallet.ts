// `NmtsWallet`: the half of `Nmts` that is about the account's wallet. Which wallets the key has
// and which one pays, the storage resources that wallet holds, buying and reshaping them, signing
// another device's upload so this wallet pays for it, and the prices and balances a program reads
// before it has an account at all.
//
// ⛔ A BASE CLASS, NOT A SECOND OBJECT. `Nmts` extends it, so every method here is a method of the
//    one client a program holds (`nmts.extend(…)`, `Nmts.price(…)`), and the README and AGENTS.md
//    still describe one class. It is its own file because `nmts.ts` passed the 400 lines
//    `check:size` allows once the money paths came in (plan 2026-11-10 §1). The account each method
//    acts for is the one `Nmts` opened and keeps, read through the weak map in `insides.ts` as the
//    gateway reads it, so splitting the file added no public member.

import type { SponsorPolicy, SponsorVerdict } from "@needmoretruth/nmts-cli/portable";

import { balancesOf, checkSponsoredBytes, priceOf, type Balances, type NetworkOption, type Price, type PriceOptions } from "../money.ts";
import type { PayerOptions } from "../pay.ts";
import { sponsorTransaction, type SponsorLimits, type Sponsored } from "../sponsor.ts";
import * as storageControl from "../storage.ts";
import { extendForUser, type ExtendForOptions, type ExtendForResult, type UserToken } from "../extend-for.ts";
import { buyStorageResource, type BuyStorageOptions, type BuyStorageResult, type BuyStorageReview } from "../storage-buy.ts";
import { addressOfWallet, setActiveWallet, wallets, type ActiveWallet, type WalletInfo } from "../wallets.ts";
import { insidesOf } from "./insides.ts";
import { chainOptionsOf, useOptions, type ChainOptions, type WalletAddressOptions } from "./options.ts";

export class NmtsWallet {
  /**
   * The Sui address of one of the wallets the account code derives — where a developer who pays
   * for storage from their own coins sends them. Nothing is signed.
   *
   * With no argument it is the wallet the account PAYS FROM, read out of the sealed file list;
   * when that cannot be read this throws rather than answering the first wallet, because coins
   * sent to an address nobody chose are coins the account cannot spend. `{ index }` names one
   * directly and is offline — numbers come from the key, so every one of them already exists.
   */
  async walletAddress(options: WalletAddressOptions = {}): Promise<string> {
    return addressOfWallet(insidesOf(this).opened(), options.index);
  }

  /** Every wallet this account has, made here or seen used on a chain, the paying one marked. Nothing is spent or written. */
  async wallets(): Promise<WalletInfo[]> {
    return wallets(insidesOf(this).opened());
  }

  /**
   * Say which of this key's wallets pays for storage from now on. It is the ACCOUNT's choice, not this
   * machine's: the number rides inside the sealed file list, so every device and program on this
   * account pays from that address afterwards. Nothing is created — every number already exists.
   */
  async setActiveWallet(index: number): Promise<ActiveWallet> {
    return setActiveWallet(insidesOf(this).opened(), index);
  }

  /**
   * Every free storage resource the paying wallet holds, usable first. Nothing is spent.
   * `pay: { signer }` lists what a wallet you hold holds instead — what that signer can act on.
   */
  async storage(options: PayerOptions = {}): Promise<storageControl.StorageResourceInfo[]> {
    return storageControl.storageResources(insidesOf(this).opened(), options);
  }

  /**
   * Buy one stored file more time. **This spends WAL and SUI** from the paying wallet; `dryRun: true`
   * only prices it. ⛔ What a wallet you hold paid for, that wallet extends: pass the same `pay`.
   */
  async extend(path: string, options: storageControl.ExtendOptions = {}) {
    return storageControl.extendFile(insidesOf(this).opened(), path, options);
  }

  /**
   * A business's server extending a user's files from THIS account's wallet, with the user's
   * delegation token and no key of the user's. **This spends WAL and SUI**; `dryRun: true` only
   * prices it. Files not due are skipped, and so are blobs this wallet does not hold, before signing.
   */
  async extendFor(user: UserToken, options: ExtendForOptions = {}): Promise<ExtendForResult> {
    return extendForUser(insidesOf(this).opened(), user, options);
  }

  /** Cut a storage resource in two: it keeps `sizeBytes` and the rest becomes a second one. **This spends SUI.** */
  async splitStorage(id: string, options: storageControl.SplitOptions) {
    return storageControl.splitStorageResource(insidesOf(this).opened(), id, options);
  }

  /** Join two of this wallet's storage resources into one. **This spends SUI**, and the contract judges the pair. */
  async mergeStorage(idA: string, idB: string, options: storageControl.StorageOpOptions = {}) {
    return storageControl.mergeStorageResources(insidesOf(this).opened(), idA, idB, options);
  }

  /** Hand a storage resource to a Sui address. **This spends SUI.** ⛔ It cannot be undone; no file goes with it. */
  async transferStorage(id: string, to: string, options: storageControl.StorageOpOptions = {}) {
    return storageControl.transferStorageResource(insidesOf(this).opened(), id, to, options);
  }

  /**
   * Buy a storage resource with no file: `sizeBytes` (encoded, as `storage()` lists) for `epochs`.
   * **This spends WAL and SUI**; `dryRun: true` only prices it. The new resource's id comes back.
   */
  async buyStorage(options: BuyStorageOptions): Promise<BuyStorageReview | BuyStorageResult> {
    return buyStorageResource(insidesOf(this).opened(), options);
  }

  /**
   * The operator's side of a sponsored upload: check a transaction another device built and sign it
   * as this account's wallet only if it is Walrus work within `limits`. **Signing spends WAL and
   * SUI** when the device submits it. A refusal throws `SPONSOR_REFUSED` and signs nothing.
   */
  async sponsor(bytes: Uint8Array | string, limits: SponsorLimits): Promise<Sponsored> {
    return sponsorTransaction(insidesOf(this).opened(), bytes, limits);
  }

  /** What an upload of `bytes` for `epochs` costs in WAL, SUI and credits. No file, account or wallet. */
  static async price(options: PriceOptions & ChainOptions): Promise<Price> {
    useOptions(chainOptionsOf(options));
    return priceOf(options);
  }

  /** The WAL and SUI any address holds on a network. Nothing is signed; no account is needed. */
  static async balances(address: string, options: NetworkOption & ChainOptions = {}): Promise<Balances> {
    useOptions(chainOptionsOf(options));
    return balancesOf(address, options);
  }

  /**
   * Is this transaction only Walrus work the operator agreed to pay for? Run it on your server
   * BEFORE signing. Never throws for a refusal: `{ ok: false, code, reason }` fits one log line.
   */
  static async checkSponsored(bytes: Uint8Array | string, policy: SponsorPolicy, options: ChainOptions = {}): Promise<SponsorVerdict> {
    useOptions(chainOptionsOf(options));
    return checkSponsoredBytes(bytes, policy);
  }
}
