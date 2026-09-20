// `Nmts` — one account, opened once, and everything a program does with its storage.
//
// ⛔ THE ROOT IS THE FIRST ARGUMENT BECAUSE IT IS THE ONE DECISION THAT MATTERS. Who holds the
//    account's key — this process, or a business's sealed store — is answered once, where the
//    client is made, and every method below reads the same whichever answer it was. That is the
//    whole of how this package keeps the rule that a verb must work the same for both; the two
//    convenience makers are named after the two answers so the choice cannot be made by accident.
//
// ⛔ THE CONSTRUCTOR DOES NO WORK. It keeps the root and the options and nothing else happens
//    until the first call, so making one is free, making one with a bad code fails on the first
//    call rather than in a constructor that cannot be awaited, and a server that is down is a
//    failure of the call that needed it.
//
// ⛔ EVERY METHOD IS THE COMMAND-LINE TOOL'S CODE with the terminal taken off: `list` is `nmts ls`,
//    `put` is `nmts put`, `extend` is `nmts extend`, and the storage resource this key's wallet
//    holds is reshaped by the three the tool spells `nmts wallet storage split|merge|transfer` —
//    the same functions, called by a program instead of a person. Where this file decides something
//    the tool decides by asking a person — spending, reading a code from the environment — the
//    decision is the caller's, made by calling the method, and the README says so at the top.
//
// ⚠ WHAT IS NOT A METHOD LIVES IN `nmts/`, and this file is still the name both entry points and
//   the gateway import: the option shapes, the weak map the gateway reads a client's account out
//   of, and the two things `put` needs before it starts.

import { newAccountCode, registrationProofOf, type ReadOptions } from "@needmoretruth/nmts-cli/portable";

import {
  businessClient,
  registerWithDelegation,
  type Business,
  type BusinessCredentials,
  type EmbeddedRegistration,
  type RegisteredUser,
} from "./business.ts";
import { eraseForGood, type EraseOptions, type EraseResult } from "./erase.ts";
import { DEFAULT_IN_MEMORY_LIMIT, getBytes, getTo, type GetResult } from "./get.ts";
import { listEntries, type Entry, type ListOptions } from "./list.ts";
import { credentialsFromWallet, openersOn, type Openers, type WalletCredentials } from "./openers.ts";
import { rememberInsides } from "./nmts/insides.ts";
import {
  optionsOf,
  useOptions,
  type AccountInfo,
  type GetOptions,
  type GetToOptions,
  type NmtsOptions,
  type WalletAddressOptions,
} from "./nmts/options.ts";
import { putVia } from "./nmts/uploading.ts";
import { nodeSeams } from "./node-seams.ts";
import {
  makeFolderAt,
  moveTo,
  removeToTrash,
  renameTo,
  restoreFromTrash,
  type MkdirResult,
  type MoveResult,
  type RemoveResult,
  type RenameResult,
  type RestoreResult,
} from "./organise.ts";
import type { PutInput, PutOptions, PutResult, PutReview } from "./put.ts";
import { deviceRoot, managedRoot, type Credentials, type ManagedCredentials, type Root } from "./root.ts";
import type { PayerOptions } from "./pay.ts";
import * as storageControl from "./storage.ts";
import { openAccount, withAccount, type Opened } from "./session.ts";
import { addressOfWallet, setActiveWallet, wallets, type ActiveWallet, type WalletInfo } from "./wallets.ts";

// The shapes a caller hands in and gets back, and the door this package's own Node-only modules
// read a client's opened account through. Both entry points and the gateway import them from here.
export type {
  AccountInfo,
  GetOptions,
  GetToOptions,
  NmtsOptions,
  WalletAddressOptions,
} from "./nmts/options.ts";
export { insidesOf } from "./nmts/insides.ts";
export type { ClientInsides } from "./nmts/insides.ts";

export class Nmts {
  readonly #root: Root;
  readonly #options: NmtsOptions;
  #opened: Opened | null = null;

  constructor(root: Root, options: NmtsOptions = {}) {
    this.#root = root;
    this.#options = { ...options };
    rememberInsides(this, { opened: () => this.#account(), read: () => this.#read() });
    useOptions(options);
  }

  /** The key is in THIS process: a browser, an app, a game client, your own program. */
  static device(credentials: Credentials & NmtsOptions): Nmts {
    return new Nmts(deviceRoot(credentials), optionsOf(credentials));
  }

  /**
   * The key is in YOUR store, sealed, and `openCode` opens it for one call at a time.
   *
   * What this means for the people whose files they are is in the README's first table: a business
   * that holds the key can read the files. It is a choice, not a defect, and it is the caller's.
   */
  static managed(source: ManagedCredentials & NmtsOptions): Nmts {
    return new Nmts(managedRoot(source), optionsOf(source));
  }

  /**
   * A BUSINESS's own client: its Platform doors, and the tokens it mints for its users.
   *
   * ⛔ IT REFUSES BY NAME IN A PAGE rather than being missing from the browser entry — the three
   *    calls that need files already do that, so a program moved into a page fails with a sentence
   *    instead of an import that is suddenly not there. And what is wrong in a page is not the
   *    runtime: a business's signing key in a page is that key handed to everyone who opens it. A
   *    page holds a delegation token; the key stays on the business's own server.
   *
   * ⚠ OF THE ADDRESSES, ONLY `server` MEANS ANYTHING, and the rest are taken so that one options
   *   object can be handed to both clients. No Platform door touches a chain, the storage network
   *   or the engine. ⛔ `fetch` IS THE EXCEPTION AND IT IS READ: these doors make requests, and a
   *   business that routes its traffic through a proxy must not have this one road round it.
   */
  static business(credentials: BusinessCredentials & NmtsOptions): Business {
    useOptions(optionsOf(credentials));
    return businessClient({ accountId: credentials.accountId, privateKey: credentials.privateKey, server: credentials.server });
  }

  /**
   * A device client whose account is opened by a WALLET rather than by a code somebody typed.
   *
   * The wallet signs one fixed message; that signature names the sealed slot holding this
   * account's key and is the only thing that opens it. What comes back is an ordinary device
   * client — the key is in this process exactly as `Nmts.device()`'s is, and whoever holds the
   * wallet holds the account. `account` picks which of that wallet's accounts (default 1) and
   * `app` scopes the signature to one product; both are inside what the person signs.
   */
  static async fromWallet(input: WalletCredentials & NmtsOptions): Promise<Nmts> {
    // ⛔ BEFORE THE FIRST REQUEST, not in the constructor below: finding the slot is a request, and
    //    it went round the caller's `fetch` (found 2026-09-20 by signing in through Tor).
    useOptions(optionsOf(input));
    return new Nmts(deviceRoot(await credentialsFromWallet(input)), optionsOf(input));
  }

  /**
   * A brand-new NMTS key, made in this process by the engine.
   *
   * ⛔ Nothing is sent and nothing is stored: the caller is the only holder. In the embedded form
   *    this runs on the person's device, so the business never sees the key.
   */
  static newAccountCode(): Promise<string> {
    return newAccountCode();
  }

  /**
   * The public id of the account an NMTS key opens — what a device tells its business so that the
   * business can sign a delegation token for it. Not a secret, and derived without any request.
   */
  static async accountIdOf(accountCode: string): Promise<string> {
    return (await registrationProofOf(accountCode)).accountId;
  }

  /**
   * The embedded form: a device holding a token with the `register` scope makes its own account.
   *
   * The NMTS key stays where it was made — this sends only the pair every account door has always
   * taken — so the business that signed the token never sees it.
   */
  static registerWithDelegation(options: EmbeddedRegistration & NmtsOptions): Promise<RegisteredUser> {
    useOptions(optionsOf(options));
    return registerWithDelegation({
      accountCode: options.accountCode,
      delegation: options.delegation,
      server: options.server,
    });
  }

  /**
   * A device client whose credentials come from the environment, the way the command-line tool
   * finds them.
   *
   * `NMTS_ACCOUNT_CODE_FILE` and `NMTS_API_KEY_FILE` name files (preferred); `NMTS_ACCOUNT_CODE`
   * and `NMTS_API_KEY` hold the values. `NMTS_SERVER` and `NMTS_NETWORK` are read by every call
   * either way. Nothing is read until this is called.
   */
  static fromEnv(options: NmtsOptions = {}): Nmts {
    const found = nodeSeams(
      "FROM_ENV_UNAVAILABLE",
      "There is no environment to read. Pass `accountCode` and `apiKey` to Nmts.device().",
    ).environment();
    return Nmts.device({ ...options, ...found.credentials });
  }

  // A failed open is not kept: the assignment never happens, so the next call tries again.
  #account(): Opened {
    this.#opened ??= openAccount(this.#root, this.#options);
    return this.#opened;
  }

  #read(): ReadOptions | undefined {
    const hosts = this.#options.aggregators;
    return hosts === undefined || hosts.length === 0 ? undefined : { hosts };
  }

  /** Which account this is, on which server and network. Offline: derived from the code alone. */
  async account(): Promise<AccountInfo> {
    return withAccount(this.#account(), async (held) => ({
      accountId: held.accountId,
      server: held.server,
      network: held.network,
    }));
  }

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
    return addressOfWallet(this.#account(), options.index);
  }

  /**
   * The wallets that open this account: which they are, attaching one, taking one off, and the
   * sealed copy of one that the recovery tool opens with a signature.
   *
   * ⛔ ATTACHING ONE LETS WHOEVER HOLDS THAT WALLET OPEN EVERY FILE IN THIS ACCOUNT, from any
   *    machine, until it is removed — and removal is "from now on", not "as if it never knew".
   *    On a managed root these refuse by name: where the business holds the key, its own sealed
   *    store is already that road.
   */
  get openers(): Openers {
    return openersOn(this.#account());
  }

  /**
   * Every wallet this account has — the ones it has made, and any further out that a chain says
   * have been used — with the one that pays marked. Nothing is spent and nothing is written.
   */
  async wallets(): Promise<WalletInfo[]> {
    return wallets(this.#account());
  }

  /**
   * Say which of this key's wallets pays for storage from now on.
   *
   * It is the ACCOUNT's choice and not this machine's: the number rides inside the sealed file
   * list, so every device and every program on this account pays from the same address afterwards.
   * Nothing is created or deleted — every number a key can derive already exists.
   */
  async setActiveWallet(index: number): Promise<ActiveWallet> {
    return setActiveWallet(this.#account(), index);
  }

  /**
   * Every live file and folder, as paths. Nothing is spent.
   *
   * `{ trash: true }` includes what is in the trash as well, and each of those carries `trashedAt`.
   */
  async list(options: ListOptions = {}): Promise<Entry[]> {
    return listEntries(this.#account(), options);
  }

  /**
   * Make a folder, and any folder above it that is missing. Nothing is spent.
   *
   * A folder that is already there is the folder asked for, so this is safe to call twice: the
   * second call writes nothing and `created` comes back empty.
   */
  async mkdir(path: string): Promise<MkdirResult> {
    return makeFolderAt(this.#account(), path);
  }

  /**
   * Move files and folders into a folder — `"/"` for the top of the account. Nothing is spent.
   *
   * Everything named moves together or nothing does. A name the destination already holds is
   * refused (`NAME_TAKEN`) rather than numbered, and a folder asked into its own subtree is
   * refused (`INTO_ITSELF`).
   */
  async move(paths: string | readonly string[], toFolder: string): Promise<MoveResult> {
    return moveTo(this.#account(), paths, toFolder);
  }

  /**
   * Give one file or folder a new name, where it is. Nothing is spent.
   *
   * The name is a name: a `/` in it is `BAD_NAME`, and a name the folder already holds is
   * `NAME_TAKEN`.
   */
  async rename(path: string, name: string): Promise<RenameResult> {
    return renameTo(this.#account(), path, name);
  }

  /**
   * Move files and folders to the trash, where they can be restored for thirty days. A folder takes
   * everything under it.
   *
   * ⚠ THE STORAGE IS STILL PAID FOR until the thirty days run out — this is a deletion the account
   *   can undo, and nothing in this package destroys a stored file for good.
   */
  async remove(paths: string | readonly string[]): Promise<RemoveResult> {
    return removeToTrash(this.#account(), paths);
  }

  /**
   * Bring files and folders back out of the trash, to where they were. Nothing is spent.
   *
   * Something that is not in the trash is `NOT_IN_TRASH`, and a name taken since is `NAME_TAKEN` —
   * neither is skipped quietly, because a program has no line of prose to read about it.
   */
  async restore(paths: string | readonly string[]): Promise<RestoreResult> {
    return restoreFromTrash(this.#account(), paths);
  }

  /**
   * Erase files for good. **Nothing undoes this** — not the trash, not this package, not us.
   *
   * What goes is the server's record of each file, this account's key to it, and its entry in the
   * sealed list; a folder erases every file under it. `confirm` must be `ERASE_CONFIRM`, character
   * for character, so the code that erases somebody's files says so where it is written — anything
   * else refuses with `ERASE_NOT_CONFIRMED` and sends nothing.
   *
   * `releaseStorage: true` also destroys the storage bought with CREDITS under each file, on the
   * chain, before erasing it; storage bought by the account's own wallet is never touched, and
   * what happened to each file's storage comes back in `storage`.
   */
  async erase(paths: string | readonly string[], options: EraseOptions): Promise<EraseResult> {
    return eraseForGood(this.#account(), paths, options);
  }

  /**
   * Upload one file. **This spends.** By default it spends credits — one per started MiB of
   * sealed bytes, for the storage period the account buys uploads for. With `pay: "wallet"` it
   * spends WAL and SUI out of the wallet the account pays from instead — `wallet: n` names another
   * of this key's wallets for this one upload — for as many of the storage network's epochs as
   * `epochs` asks for. With `pay: { signer }` the same WAL and SUI come from a wallet you hold the
   * key to, which is asked to sign every transaction. None of it comes back, and calling this is the
   * agreement to that; `dryRun: true` says what it would cost and spends nothing.
   *
   * A path names a file on this machine; bytes need a `name`. A name already in use is numbered,
   * `report (2).pdf`, unless the machine's `nmts on-collision` setting says overwrite.
   */
  async put(file: PutInput | Uint8Array, options: PutOptions & { dryRun: true }): Promise<PutReview>;
  async put(file: PutInput | Uint8Array, options?: PutOptions): Promise<PutResult>;
  async put(file: PutInput | Uint8Array, options: PutOptions = {}): Promise<PutResult | PutReview> {
    return putVia(this.#account(), file, options);
  }

  /**
   * Every free storage resource the paying wallet holds, usable first. Nothing is spent.
   * `pay: { signer }` lists what a wallet you hold holds instead — what that signer can act on.
   */
  async storage(options: PayerOptions = {}): Promise<storageControl.StorageResourceInfo[]> {
    return storageControl.storageResources(this.#account(), options);
  }

  /**
   * Buy one stored file more time. **This spends WAL and SUI** from the paying wallet; `dryRun: true`
   * only prices it. ⛔ What a wallet you hold paid for, that wallet extends: pass the same `pay`.
   */
  async extend(path: string, options: storageControl.ExtendOptions = {}) {
    return storageControl.extendFile(this.#account(), path, options);
  }

  /** Cut a storage resource in two: it keeps `sizeBytes` and the rest becomes a second one. **This spends SUI.** */
  async splitStorage(id: string, options: storageControl.SplitOptions) {
    return storageControl.splitStorageResource(this.#account(), id, options);
  }

  /** Join two of this wallet's storage resources into one. **This spends SUI**, and the contract judges the pair. */
  async mergeStorage(idA: string, idB: string, options: storageControl.StorageOpOptions = {}) {
    return storageControl.mergeStorageResources(this.#account(), idA, idB, options);
  }

  /** Hand a storage resource to a Sui address. **This spends SUI.** ⛔ It cannot be undone; no file goes with it. */
  async transferStorage(id: string, to: string, options: storageControl.StorageOpOptions = {}) {
    return storageControl.transferStorageResource(this.#account(), id, to, options);
  }

  /** One file, whole and checked, in memory. Nothing is spent. */
  async get(path: string, options: GetOptions = {}): Promise<Uint8Array> {
    return getBytes(this.#account(), path, options.maxBytes ?? DEFAULT_IN_MEMORY_LIMIT, this.#read());
  }

  /**
   * One file, streamed to `destination` and made visible only once it is checked. No size
   * ceiling. Refuses to overwrite unless `force` says so.
   */
  async getTo(path: string, destination: string, options: GetToOptions = {}): Promise<GetResult> {
    const sink = nodeSeams(
      "GET_TO_UNAVAILABLE",
      "Nothing was fetched. Use get(path), which answers the bytes — a page writes them out itself.",
    ).sink(destination, { force: options.force === true });
    return getTo(this.#account(), path, sink, this.#read());
  }
}
