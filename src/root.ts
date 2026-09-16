// Who holds the NMTS key — the one thing that differs between a person's own program and a
// business running this for other people, and the only place in the package where it differs.
//
// ⛔ EVERY VERB TAKES A ROOT, AND THERE ARE TWO ROOTS, NOT TWO SETS OF VERBS. Everything an account
//    can do is derived from its key, so the question "who holds it" has exactly one seam: which
//    process the key is in. Splitting the verbs by mode instead would mean writing each one twice,
//    and a verb written twice is a verb that ends up working for one holder and not the other.
//    `test/roots.ts` walks every verb through both, so a verb that only works one way is a red test
//    rather than a discovery made by whoever tried it second.
//
// ⛔ A JAVASCRIPT STRING CANNOT BE ZEROED, so `withCode` does what a runtime with immutable strings
//    allows: it lends the code for one piece of work, keeps no reference of its own afterwards, and
//    never stores what it opened. What is derived FROM the code is wiped — `withDataKey` in
//    `session.ts` zeroes the derivation before it returns. The device root is the exception by
//    definition: the caller handed it the code, so the caller's own object holds it.
//
// ⛔ NO SERVER AND NO NETWORK HERE. A root answers "who holds the key" and "who does the server
//    think is calling". Where to talk is `NmtsOptions`, because the same key is the same account on
//    any server, and a root carrying an address would be a key that only worked against one.

import { NmtsError } from "@needmoretruth/nmts-cli";

/**
 * Which process holds the key.
 *
 * A third, `gateway` — the key inside an S3-compatible gateway process a business runs — is not
 * built yet. When it is, it is another implementation in this file and another row in the test
 * registry, and no verb moves.
 */
export type RootMode = "device" | "managed";

/**
 * Who the server is asked to believe is calling.
 *
 * One kind for now. A business acting for a person it has delegation for is `{ kind: "delegation";
 * token: string }`, and it arrives with the Platform API rather than before it.
 */
export type Identity = { kind: "api-key"; apiKey: string };

/** Something that holds one account's NMTS key and will lend it for the length of one piece of work. */
export interface Root {
  readonly mode: RootMode;
  readonly identity: Identity;
  withCode<T>(use: (code: string) => Promise<T>): Promise<T>;
}

/** What the device root takes. Two secrets, because they do two different jobs — see the README. */
export interface Credentials {
  /** Opens the files and derives the wallet. Never leaves this process. */
  accountCode: string;
  /** Makes the server answer. Opens nothing; can be revoked on the account screen. */
  apiKey: string;
}

/** What the managed root takes: a way to open the sealed code, and the key the server answers to. */
export interface ManagedCredentials {
  /**
   * Opens the account's code out of wherever this business sealed it, and answers it.
   *
   * Called once for each call this package makes on the account, and never for anything else. How
   * the code is sealed — a cloud key service, a master key, a hardware module — is the business's
   * own decision and this package does not reach into it.
   */
  openCode: () => Promise<string>;
  /** Makes the server answer. Opens nothing; can be revoked on the account screen. */
  apiKey: string;
}

const CODE_NEXT_STEP =
  "Pass `accountCode` to Nmts.device(), or set NMTS_ACCOUNT_CODE_FILE and use `Nmts.fromEnv()`.";

const OPENED_NOTHING_NEXT_STEP =
  "Nothing was sent. `openCode` answered no account code, so there was nothing to open the account with.";

/**
 * A credential is text or it is a refusal.
 *
 * ⛔ THE REFUSAL NEVER CONTAINS THE VALUE. It names what was missing and what to do; a caller's log
 *    is not a place an account code should be able to reach.
 */
export function requireText(value: unknown, what: string, nextStep: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NmtsError(`No ${what} was given.`, { exitCode: 3, nextStep });
  }
  return value.trim();
}

/**
 * The key is in THIS process: a browser, an app, a game client, a developer's own program.
 *
 * The code is checked when it is first used rather than here, so that making one of these does no
 * work and a code that is not one fails on the first call, where the caller can act on it.
 */
export function deviceRoot(credentials: Credentials): Root {
  const { accountCode, apiKey } = credentials;
  return {
    mode: "device",
    identity: { kind: "api-key", apiKey },
    async withCode<T>(use: (code: string) => Promise<T>): Promise<T> {
      return use(requireText(accountCode, "account code", CODE_NEXT_STEP));
    },
  };
}

/**
 * The key is in a BUSINESS'S STORE: it sealed the code and opens it when something needs it.
 *
 * ⛔ ASKED EVERY TIME AND KEPT NOWHERE. This package holds no copy between calls, which is what
 *    makes the business's own store the only place the code lives at rest: revoking it there ends
 *    the access, and a long-running process that was asked once does not go on holding it. The cost
 *    is one `openCode` per call, and the test registry counts exactly that.
 */
export function managedRoot(source: ManagedCredentials): Root {
  const { openCode, apiKey } = source;
  return {
    mode: "managed",
    identity: { kind: "api-key", apiKey },
    async withCode<T>(use: (code: string) => Promise<T>): Promise<T> {
      let code: string | null = requireText(await openCode(), "account code", OPENED_NOTHING_NEXT_STEP);
      try {
        return await use(code);
      } finally {
        // The local would go out of scope anyway. Dropping it here is what a reader can check, and
        // what stops a later edit from quietly holding the code past the work that borrowed it.
        code = null;
      }
    },
  };
}
