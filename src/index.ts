// `@needmoretruth/nmts-sdk` — what `import { Nmts } from "@needmoretruth/nmts-sdk"` hands you.
//
// One class, three verbs, and the two answers to "who holds the key". Everything else is a type, or
// the error every failure arrives in.

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
export type { Credentials, Identity, ManagedCredentials, Root, RootMode } from "./root.ts";
export type { Entry } from "./list.ts";
// The wallets one NMTS key opens, and which of them pays.
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
export type { GetResult } from "./get.ts";

// The failures. `NmtsError` carries `exitCode` and `nextStep` exactly as the command-line tool's
// do, so a program can print the same sentence a person would have seen; `ServerError` is the
// server's own refusal with its code; `UploadError` says whether money moved.
export { NmtsError, ServerError, UploadError } from "@needmoretruth/nmts-cli";
export type { FileUploadStep, ServerRefusal } from "@needmoretruth/nmts-cli";

export { HOME_URL, SDK_NAME, SOURCE_URL, VERSION } from "./product.ts";
