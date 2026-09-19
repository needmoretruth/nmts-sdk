// Turning a root and the two address options into an opened account: who it is, which server,
// which network.
//
// ⛔ NOTHING HERE READS THE ENVIRONMENT OR ASKS A PERSON. The command-line tool's session module
//    does both, because a terminal is where a person is; a library runs inside somebody else's
//    server, where a prompt hangs and an environment read is a decision the caller did not make.
//    `env.ts` is the one place this package reads the environment, and only when asked to.
//
// ⛔ THE CODE IS BORROWED, NOT HELD. `Opened` carries the ROOT, not the key, so nothing below this
//    line changes when the key moves from a person's device to a business's sealed store.
//    `withAccount` is the one door through which a verb borrows it, which is why "one call, one
//    opening" is a number a test can read off a managed root — and why nothing this package keeps
//    between calls can hold a code.
//
// ⛔ THE ACCOUNT CODE IS HELD, NOT COPIED, for the length of the work. It is the only key to the
//    account. Every derivation below takes it, uses the bytes it needs, and wipes the rest before
//    returning — the same discipline the command-line tool keeps, for the same reason: a live copy
//    of the derived buffer is a live copy of the account.

import {
  DERIVED,
  identityOf,
  loadCrypto,
  resolveNetwork,
  resolveServer,
  type CryptoGlue,
  type Network,
} from "@needmoretruth/nmts-cli/portable";

import { requireText, type Root } from "./root.ts";

/** Where an account talks. Not the root's business: one key is one account on any server. */
export interface ServerOptions {
  /** The NMTS server. Defaults to https://nmts.me. */
  server?: string | undefined;
  /**
   * `mainnet` or `testnet`. Defaults to mainnet for the public server and must be stated for any
   * other — guessing would look for files on a network they were never stored on.
   */
  network?: string | undefined;
}

/** An account this process can act for: the root that holds its key, and where it talks. */
export interface Opened {
  readonly root: Root;
  /**
   * What goes in the one header the server reads: an API key, or a delegation token.
   *
   * ⛔ NAMED FOR WHAT IT IS RATHER THAN FOR ONE OF THE TWO. Everything under this line hands it
   *    straight to a request, and a field called `apiKey` carrying a delegation token is how a
   *    reader comes to believe a delegated client cannot do something it can.
   */
  readonly bearer: string;
  readonly server: string;
  readonly network: Network;
}

/** The account WHILE one call holds its code — everything the library surface underneath takes. */
export interface Held {
  readonly code: string;
  readonly bearer: string;
  readonly server: string;
  readonly network: Network;
  readonly accountId: string;
}

/**
 * Check what can be checked without the code, and work out where this account talks.
 *
 * The credential is only checked for being present; the server is what judges one, on the first
 * request. Nothing here borrows the code, so a caller who got it wrong is refused without a
 * business's store having been opened for nothing.
 */
export function openAccount(root: Root, options: ServerOptions = {}): Opened {
  const identity = root.identity;
  const bearer =
    identity.kind === "api-key"
      ? requireText(
          identity.apiKey,
          "API key",
          "Make one on the account screen at nmts.me and pass it as `apiKey`, or set NMTS_API_KEY_FILE.",
        )
      : requireText(
          identity.token,
          "delegation token",
          "Ask the business this account belongs to for one, and pass it as `delegation`.",
        );
  const server = resolveServer(options.server);
  return { root, bearer, server, network: resolveNetwork(server, options.network) };
}

/**
 * Borrow the account's code for the length of `body`, and work out the account it names.
 *
 * ⛔ ONE CALL, ONE BORROW. Every verb in this package wraps the whole of itself in this, so a
 *    managed root is asked to open its sealed code exactly once however many requests the verb makes.
 *
 * ⛔ THE ACCOUNT ID IS DERIVED HERE RATHER THAN KEPT, because deriving it is the only check there
 *    is that a code is one: nothing about a string says which account it opens until the engine has
 *    parsed it. It is a pure function of the code, and the code is only here.
 */
export async function withAccount<T>(opened: Opened, body: (held: Held) => Promise<T>): Promise<T> {
  return opened.root.withCode(async (code) => {
    const identity = await identityOf(code);
    return body({
      code,
      bearer: opened.bearer,
      server: opened.server,
      network: opened.network,
      accountId: identity.accountId,
    });
  });
}

/**
 * Run `body` with the account's data key, then wipe it.
 *
 * The data key wraps every file key in the account. It exists for exactly as long as the work
 * that needs it, and the derivation output it came out of — which holds every other key too — is
 * zeroed before `body` even starts.
 */
export async function withDataKey<T>(
  code: string,
  body: (crypt: CryptoGlue, dataKey: Uint8Array) => Promise<T>,
): Promise<T> {
  const crypt = await loadCrypto();
  const [from, to] = DERIVED.dataKey;
  const derived = crypt.kdf_derive(crypt.account_code_parse(code));
  const dataKey = derived.slice(from, to);
  derived.fill(0);
  try {
    return await body(crypt, dataKey);
  } finally {
    dataKey.fill(0);
  }
}
