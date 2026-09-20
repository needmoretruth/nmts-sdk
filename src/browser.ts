// `@needmoretruth/nmts-sdk/browser` — the same package, in a page.
//
// ⛔ THE SAME NAMES AND THE SAME VERBS. What differs is the shape bytes arrive in — a `Blob` or an
//    array rather than a path — and who holds the engine and the state. Everything else is the
//    module the Node entry point exports, unchanged, which is what keeps "a feature works the same
//    whoever holds the key" true of the runtime as well.
//
// ⛔ IT REGISTERS A HOST AND NOTHING ELSE. The three seams the Node entry fills — reading a path,
//    writing a file, reading an environment — are deliberately left empty here, so `put("/path")`,
//    `getTo()` and `Nmts.fromEnv()` refuse by name instead of failing somewhere deeper.
//
// ⛔ THE PACKAGE DOES NOT USE THE `browser` EXPORT CONDITION, on purpose. A bundler that swapped
//    the entry point by itself would hand a page this file without the page having asked, and the
//    first thing a reader would know about it is a different error. Importing
//    `@needmoretruth/nmts-sdk/browser` is the caller saying so.

import { registerHost } from "@needmoretruth/nmts-cli/portable";

import { browserHost } from "./host-browser.ts";

// ⛔ BEFORE ANY EXPORT BELOW CAN BE CALLED, for the reason the Node entry registers its own on the
//    way in: a module's imports run before its body, so nothing a caller holds exists yet.
registerHost(browserHost());

export { Nmts } from "./nmts.ts";
export type {
  AccountInfo,
  GetOptions,
  GetToOptions,
  NmtsOptions,
  WalletAddressOptions,
} from "./nmts.ts";

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
// Erasing for good — the same verb in a page, and nothing about it reaches for a file or a path.
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
export type { ActiveWallet, WalletInfo } from "./wallets.ts";
export type {
  CreditsPut,
  CreditsReview,
  PutOptions,
  PutResult,
  PutReview,
  PutStorage,
  WalletPut,
  WalletReview,
} from "./put.ts";
// ⛔ WITHOUT THE PATH. A page has no file paths, so the type a caller writes against here has no
//    `string` in it and the compiler refuses one; `put` refuses it at run time as well, by name.
export type { BrowserPutInput as PutInput } from "./put.ts";
export type { GetResult } from "./get.ts";
export { blobSource } from "./source-blob.ts";

export { NmtsError, ServerError, UploadError } from "@needmoretruth/nmts-cli/portable";
export type { FileUploadStep, ServerRefusal } from "@needmoretruth/nmts-cli/portable";

export { HOME_URL, SDK_NAME, SOURCE_URL, VERSION } from "./product.ts";
