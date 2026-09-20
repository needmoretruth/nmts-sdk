// `@needmoretruth/nmts-sdk` — what `import { Nmts } from "@needmoretruth/nmts-sdk"` hands you.
//
// One class, its verbs — read, write, and the five that change where a file is rather than what is
// in it — and the two answers to "who holds the key". Everything else is a type, or the error every
// failure arrives in.
//
// ⛔ THIS ENTRY POINT IS NODE'S. Importing it registers the command-line package's Node host — the
//    engine on disk, state in the config directory, the real environment — and fills in the three
//    things only a machine with files can do. `@needmoretruth/nmts-sdk/browser` is the other side:
//    the same names, a browser host, and no path anywhere.

import { fileSink, fileSource, measureLocal } from "@needmoretruth/nmts-cli";

import { credentialsFromEnvironment } from "./env.ts";
import { useNodeSeams } from "./node-seams.ts";

// ⛔ BEFORE ANY EXPORT BELOW CAN BE CALLED. A module's imports run before its body, so by the time
//    a program holds anything from this file the seams are in place — and `put("/tmp/x")`,
//    `getTo()` and `Nmts.fromEnv()` work exactly as they did before there were two entry points.
useNodeSeams({
  source: (path: string) => fileSource(path, measureLocal(path)),
  sink: fileSink,
  environment: credentialsFromEnvironment,
});

export { Nmts } from "./nmts.ts";
export type {
  AccountInfo,
  GetOptions,
  GetToOptions,
  NmtsOptions,
  WalletAddressOptions,
} from "./nmts.ts";

// Who holds the account's key. `Nmts.device()` and `Nmts.managed()` make these for you; the makers
// are here for a program that builds its client from a root it was handed.
export { deviceRoot, managedRoot } from "./root.ts";
export type {
  Credentials,
  Identity,
  ManagedCredentials,
  Root,
  RootMode,
  ServerCredential,
} from "./root.ts";
// The business side of the Platform. `Nmts.business()` makes one; these are the shapes it takes
// and answers. ⚠ Types only: a page never holds the key that speaks for a business.
export type {
  Business,
  BusinessCredentials,
  BusinessInfo,
  BusinessOptions,
  DelegationOrder,
  EmbeddedRegistration,
  RegisteredUser,
  ScopeName,
} from "./business.ts";
export type { Entry, ListOptions } from "./list.ts";
// Wallet sign-in. ⛔ Attaching a wallet lets whoever holds it open every file in the account, from
// any machine, until it is removed; on a managed root these refuse by name, because a business's
// own sealed store is already that road.
export type { AttachedWallet, OpenerInfo, Openers, SignWallet, WalletCredentials, WalletInput } from "./openers.ts";
// Erasing for good. ⛔ The sentence is a VALUE and not only a type: a caller writes
// `confirm: ERASE_CONFIRM`, and that it is visible in the call is the whole safety of it.
export { ERASE_CONFIRM } from "./erase.ts";
export type { EraseOptions, EraseResult, EraseStorage } from "./erase.ts";
// Folders, moving, renaming and the trash: what the five verbs answer.
export type {
  MkdirResult,
  Moved,
  MoveResult,
  RemoveResult,
  RenameResult,
  RestoreResult,
} from "./organise.ts";
// The wallets one NMTS key opens, and which of them pays.
export type { ActiveWallet, WalletInfo } from "./wallets.ts";
// Which money buys the storage, and the wallet a caller holds the key to.
export type { ExternalSigner, PayerOptions, PayFrom } from "./pay.ts";
export type {
  CreditsPut,
  CreditsReview,
  PutInput,
  PutOptions,
  PutResult,
  PutReview,
  PutStorage,
  WalletPut,
  WalletReview,
} from "./put.ts";
// Storage control: what the account's wallet holds free, buying one file more time, and cutting,
// joining and handing over a resource. ⛔ Every one of these spends, and `dryRun` is how a caller
// asks what it would cost without signing.
export type {
  ExtendOptions,
  ExtendResult,
  ExtendReview,
  MergeResult,
  MergeReview,
  SplitOptions,
  SplitResult,
  SplitReview,
  StorageOpOptions,
  StorageResourceInfo,
  StorageWallet,
  TransferResult,
  TransferReview,
} from "./storage.ts";
export type { GetResult } from "./get.ts";
// Bytes that came from a file picker, a drag, a `fetch` or a canvas. Node has `Blob` too.
export { blobSource } from "./source-blob.ts";

// The failures. `NmtsError` carries `exitCode` and `nextStep` exactly as the command-line tool's
// do, so a program can print the same sentence a person would have seen; `ServerError` is the
// server's own refusal with its code; `UploadError` says whether money moved.
export { NmtsError, ServerError, UploadError } from "@needmoretruth/nmts-cli/portable";
export type { FileUploadStep, ServerRefusal } from "@needmoretruth/nmts-cli/portable";

export { HOME_URL, SDK_NAME, SOURCE_URL, VERSION } from "./product.ts";
