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
//    `put` is `nmts put`, `get` is `nmts get`, and `mkdir`, `move`, `rename`, `remove` and
//    `restore` are `mkdir`, `mv`, `rename`, `rm` and `restore` — the same functions, called by a
//    program instead of a person. Where this file decides something the tool decides
//    by asking a person — spending, reading a code from the environment — the decision is the
//    caller's, made by calling the method, and the README says so at the top.

import {
  createBlobProtocol,
  createUploadApi,
  host,
  newAccountCode,
  NmtsError,
  readCurrentEpoch,
  registrationProofOf,
  walletAddress,
  type Network,
  type PlaintextSource,
  type ReadOptions,
} from "@needmoretruth/nmts-cli/portable";

import {
  businessClient,
  registerWithDelegation,
  type Business,
  type BusinessCredentials,
  type EmbeddedRegistration,
  type RegisteredUser,
} from "./business.ts";
import { DEFAULT_IN_MEMORY_LIMIT, getBytes, getTo, type GetResult } from "./get.ts";
import { useHostOptions } from "./host-options.ts";
import { listEntries, type Entry, type ListOptions } from "./list.ts";
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
import {
  bytesSource,
  nameOf,
  putSource,
  type PutInput,
  type PutOptions,
  type PutResult,
  type PutReview,
  type UploadRail,
} from "./put.ts";
import { putSourceWithWallet } from "./put-wallet.ts";
import { blobSource } from "./source-blob.ts";
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
  /**
   * The storage network's relay this client writes through, instead of the network's own.
   *
   * ⚠ ONE host, not a list: unlike reads there is nothing to fail over to.
   */
  relay?: string | undefined;
  /** The Sui JSON-RPC endpoint this client asks, instead of the network's own. */
  suiRpc?: string | undefined;
  /**
   * Told each progress line the work produces. Absent, the command-line package's Node host writes
   * them to stderr and a page says nothing.
   */
  onProgress?: ((line: string) => void) | undefined;
  /**
   * BROWSER ENTRY ONLY: where the engine's WebAssembly is, when a bundler put it somewhere the
   * module cannot work out for itself. On Node it is refused rather than ignored — the engine
   * there comes out of the installed package, so a caller who set this did not get what they asked
   * for.
   */
  wasmUrl?: string | undefined;
}

/**
 * The three fields that say where to talk, taken off a convenience maker's one object.
 *
 * ⛔ SO THAT NO CREDENTIAL IS COPIED ONTO THE CLIENT. `Nmts.device({ accountCode, … })` takes one
 *    flat object because that is what is pleasant to write; what the client keeps out of it is
 *    these three, and the code goes to the root and nowhere else.
 */
function optionsOf(from: NmtsOptions): NmtsOptions {
  return {
    server: from.server,
    network: from.network,
    aggregators: from.aggregators,
    relay: from.relay,
    suiRpc: from.suiRpc,
    onProgress: from.onProgress,
    wasmUrl: from.wasmUrl,
  };
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

/**
 * The bytes an upload will read, and the name they came with.
 *
 * ⛔ A PATH IS READ ONLY WHERE THERE IS A DISK. The modules that open one live behind the Node
 *    entry point, so this reaches for them when it is handed a path and refuses when the runtime
 *    that registered the host has no files — which is the honest answer in a page, and a sentence
 *    rather than a crash three calls further in.
 */
function sourceOf(file: PutInput | Uint8Array): { source: PlaintextSource; name: string } {
  if (typeof file === "string") {
    const seams = nodeSeams(
      "PUT_PATH_UNAVAILABLE",
      "Nothing was sent. Hand `put` the bytes — `{ name, bytes }` — or a `Blob` — " +
        "`{ name, blob }` — which is what a file picker, a drag or a `fetch` already gives you.",
    );
    return { source: seams.source(file), name: nameOf(file) };
  }
  if (file instanceof Uint8Array) return { source: bytesSource(file), name: "" };
  if ("blob" in file) return { source: blobSource(file.blob, file.name), name: file.name };
  return { source: bytesSource(file.bytes), name: file.name };
}

/**
 * What this package's own Node-only modules need of a client, and callers do not.
 *
 * ⛔ A WEAK MAP RATHER THAN A METHOD ON THE CLASS. The gateway builds a drive out of a client, and
 *    to do that it needs the opened account — the root that holds the key and the credential every
 *    request carries. Put on `Nmts` that would be public surface in all but name: the README would
 *    have to explain it, `surface.test.ts` would list it, and the first program to reach for it
 *    would be reaching past the three verbs on purpose. Here it is reachable from the modules that
 *    import this file and from nowhere else, and it adds nothing a caller can see.
 */
export interface ClientInsides {
  /** The account this client speaks for, opened on first use and kept. */
  opened(): Opened;
  /** Which hosts stored bytes are read from, when the caller named any. */
  read(): ReadOptions | undefined;
}

const insides = new WeakMap<Nmts, ClientInsides>();

/** The insides of a client this package made. Anything else is a caller's own object. */
export function insidesOf(client: Nmts): ClientInsides {
  const found = insides.get(client);
  if (found === undefined) {
    throw new NmtsError("NOT_A_CLIENT: that is not an Nmts client this package made.", {
      exitCode: 2,
      nextStep: "Nothing was read or written. Hand the gateway what `Nmts.device()` or `Nmts.managed()` answered.",
    });
  }
  return found;
}

export class Nmts {
  readonly #root: Root;
  readonly #options: NmtsOptions;
  #opened: Opened | null = null;

  constructor(root: Root, options: NmtsOptions = {}) {
    this.#root = root;
    this.#options = { ...options };
    insides.set(this, { opened: () => this.#account(), read: () => this.#read() });
    // ⛔ AN OPTION THAT WOULD BE IGNORED IS A REFUSAL, not a shrug. The Node host finds the engine
    //    in the installed package, so a caller who named a URL for it was writing for the browser
    //    entry and is running on the other one.
    if (options.wasmUrl !== undefined && host().name !== "browser") {
      throw new NmtsError("OPTION_NODE_IGNORED: `wasmUrl` only applies to the browser entry point.", {
        exitCode: 2,
        nextStep:
          "Nothing was read or written. Import `@needmoretruth/nmts-sdk/browser` to use it, or drop " +
          "it — on Node the engine comes out of the installed command-line package.",
      });
    }
    // ⛔ THE HOST IS THE RUNTIME'S AND THIS IS THE ONE SEAM TO IT. A host was registered when the
    //    entry point was imported, long before any client existed; these are the things only a
    //    caller knows, and the host reads them when it is asked to do the thing that needs them.
    useHostOptions({
      relay: options.relay,
      suiRpc: options.suiRpc,
      aggregators: options.aggregators,
      onProgress: options.onProgress,
      wasmUrl: options.wasmUrl,
    });
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
   * ⚠ OF THE OPTIONS, ONLY `server` IS READ, and the rest are taken so that one options object can
   *   be handed to both clients. No Platform door touches a chain, the storage network or the
   *   engine, so there is nothing here for the others to mean.
   */
  static business(credentials: BusinessCredentials & NmtsOptions): Business {
    if (host().name === "browser") {
      throw new NmtsError("BUSINESS_IN_A_PAGE: a business's signing key does not belong in a browser.", {
        exitCode: 2,
        nextStep:
          "Nothing was sent. Sign on your own server and hand the page a delegation token — " +
          "`Nmts.device({ accountCode, delegation })` is what a page uses.",
      });
    }
    return businessClient({ accountId: credentials.accountId, privateKey: credentials.privateKey, server: credentials.server });
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
  async put(file: PutInput | Uint8Array, options: PutOptions & { dryRun: true }): Promise<PutReview>;
  async put(file: PutInput | Uint8Array, options?: PutOptions): Promise<PutResult>;
  async put(file: PutInput | Uint8Array, options: PutOptions = {}): Promise<PutResult | PutReview> {
    const opened = this.#account();
    const { source, name: own } = sourceOf(file);
    const name = options.name ?? own;
    // ⛔ WHICH MONEY IS DECIDED BEFORE ANYTHING IS READ, as the command-line tool decides it. The
    //    credit rail below cannot price in WAL or sign a transaction, and it must not learn.
    if (options.pay === "wallet") return putSourceWithWallet(opened, source, name, options);
    return putSource(opened, source, name, options, (sealedBytes) => this.#rail(opened, sealedBytes, options));
  }

  /** The credit-paid rail: the server sells the storage, the network's relay takes the bytes. */
  async #rail(opened: Opened, sealedBytes: number, options: PutOptions): Promise<UploadRail> {
    const protocol = createBlobProtocol(opened.network, sealedBytes, options.onProgress);
    return {
      api: createUploadApi(opened.server, opened.bearer),
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
    const sink = nodeSeams(
      "GET_TO_UNAVAILABLE",
      "Nothing was fetched. Use get(path), which answers the bytes — a page writes them out itself.",
    ).sink(destination, { force: options.force === true });
    return getTo(this.#account(), path, sink, this.#read());
  }
}
