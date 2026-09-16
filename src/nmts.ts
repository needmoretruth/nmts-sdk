// `Nmts` — one account, opened once, with the three things a program does with storage.
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
// ⛔ EVERY METHOD IS THE COMMAND-LINE TOOL'S CODE with the terminal taken off. `list` is `nmts ls`,
//    `put` is `nmts put`, `get` is `nmts get`. Where this file decides something the tool decides
//    by asking a person — spending, reading a code from the environment — the decision is the
//    caller's, made by calling the method, and the README says so at the top.

import {
  createBlobProtocol,
  createUploadApi,
  fileSource,
  measureLocal,
  readCurrentEpoch,
  walletAddress,
  type Network,
  type ReadOptions,
} from "@needmoretruth/nmts-cli";

import { credentialsFromEnvironment } from "./env.ts";
import { DEFAULT_IN_MEMORY_LIMIT, getBytes, getToFile, type GetResult } from "./get.ts";
import { listEntries, type Entry } from "./list.ts";
import {
  bytesSource,
  nameOf,
  putSource,
  type PutOptions,
  type PutResult,
  type PutReview,
  type UploadRail,
} from "./put.ts";
import { putSourceWithWallet } from "./put-wallet.ts";
import { deviceRoot, managedRoot, type Credentials, type ManagedCredentials, type Root } from "./root.ts";
import { openAccount, withAccount, type Opened, type ServerOptions } from "./session.ts";
import {
  payingWallet,
  requireWalletIndex,
  setActiveWallet,
  wallets,
  type ActiveWallet,
  type WalletInfo,
} from "./wallets.ts";

export interface NmtsOptions extends ServerOptions {
  /**
   * Hosts to read stored bytes from, instead of the public aggregators for the network. For a
   * development stack, or an aggregator you run yourself.
   */
  aggregators?: readonly string[] | undefined;
}

/**
 * The three fields that say where to talk, taken off a convenience maker's one object.
 *
 * ⛔ SO THAT NO CREDENTIAL IS COPIED ONTO THE CLIENT. `Nmts.device({ accountCode, … })` takes one
 *    flat object because that is what is pleasant to write; what the client keeps out of it is
 *    these three, and the code goes to the root and nowhere else.
 */
function optionsOf(from: NmtsOptions): NmtsOptions {
  return { server: from.server, network: from.network, aggregators: from.aggregators };
}

export interface GetOptions {
  /** How many bytes `get()` may hold in memory. Default 256 MiB. Over it, use `getTo()`. */
  maxBytes?: number | undefined;
}

export interface GetToOptions {
  /** Replace a file already at the destination. Off by default, and saying so is the point. */
  force?: boolean | undefined;
}

export interface WalletAddressOptions {
  /** Which of this key's wallets. Absent = the one the account pays from. */
  index?: number | undefined;
}

export interface AccountInfo {
  /** The account's public id — what the server knows it by. Not a secret. */
  accountId: string;
  server: string;
  network: Network;
}

export class Nmts {
  readonly #root: Root;
  readonly #options: NmtsOptions;
  #opened: Opened | null = null;

  constructor(root: Root, options: NmtsOptions = {}) {
    this.#root = root;
    this.#options = { ...options };
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
   * A device client whose credentials come from the environment, the way the command-line tool
   * finds them.
   *
   * `NMTS_ACCOUNT_CODE_FILE` and `NMTS_API_KEY_FILE` name files (preferred); `NMTS_ACCOUNT_CODE`
   * and `NMTS_API_KEY` hold the values. `NMTS_SERVER` and `NMTS_NETWORK` are read by every call
   * either way. Nothing is read until this is called.
   */
  static fromEnv(options: NmtsOptions = {}): Nmts {
    const found = credentialsFromEnvironment();
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
    const opened = this.#account();
    const asked = options.index;
    if (asked !== undefined) {
      const index = requireWalletIndex(asked);
      return opened.root.withCode(async (code) => walletAddress(code, index));
    }
    return withAccount(opened, async (held) => walletAddress(held.code, await payingWallet(held)));
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

  /** Every live file and folder, as paths. Nothing is spent. */
  async list(): Promise<Entry[]> {
    return listEntries(this.#account());
  }

  /**
   * Upload one file. **This spends.** By default it spends credits — one per started MiB of
   * sealed bytes, for the storage period the account buys uploads for. With `pay: "wallet"` it
   * spends WAL and SUI out of the wallet the account pays from instead — `wallet: n` names another
   * of this key's wallets for this one upload — for as many of the storage network's epochs as
   * `epochs` asks for. Neither comes back, and calling this is the agreement to that;
   * `dryRun: true` says what it would cost and spends nothing.
   *
   * A path names a file on this machine; bytes need a `name`. A name already in use is numbered,
   * `report (2).pdf`, unless the machine's `nmts on-collision` setting says overwrite.
   */
  async put(file: string | Uint8Array, options: PutOptions & { dryRun: true }): Promise<PutReview>;
  async put(file: string | Uint8Array, options?: PutOptions): Promise<PutResult>;
  async put(file: string | Uint8Array, options: PutOptions = {}): Promise<PutResult | PutReview> {
    const opened = this.#account();
    const source = typeof file === "string" ? fileSource(file, measureLocal(file)) : bytesSource(file);
    const name = options.name ?? (typeof file === "string" ? nameOf(file) : "");
    // ⛔ WHICH MONEY IS DECIDED BEFORE ANYTHING IS READ, as the command-line tool decides it. The
    //    credit rail below cannot price in WAL or sign a transaction, and it must not learn.
    if (options.pay === "wallet") return putSourceWithWallet(opened, source, name, options);
    return putSource(opened, source, name, options, (sealedBytes) => this.#rail(opened, sealedBytes, options));
  }

  /** The credit-paid rail: the server sells the storage, the network's relay takes the bytes. */
  async #rail(opened: Opened, sealedBytes: number, options: PutOptions): Promise<UploadRail> {
    const protocol = createBlobProtocol(opened.network, sealedBytes, options.onProgress);
    return {
      api: createUploadApi(opened.server, opened.apiKey),
      protocol,
      relayUrl: protocol.relayUrl,
      currentEpoch: await readCurrentEpoch(opened.network),
    };
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
    return getToFile(this.#account(), path, destination, options.force === true, this.#read());
  }
}
