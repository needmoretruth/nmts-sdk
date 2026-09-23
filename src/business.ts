// The business side of the Platform: the doors a business's own server knocks on, and the tokens
// it mints for its users.
//
// ⛔ NO ROOT AND NO ACCOUNT CODE. Everything else in this package is about ONE account's key; this
//    is about a business's SIGNING key, which opens no file and derives no wallet. Two different
//    secrets doing two different jobs, and nothing here can reach the other one.
//
// ⛔ THE PRIVATE KEY NEVER TRAVELS AND NEVER REACHES A REFUSAL. What goes out is a signature over
//    the request being made — its moment, method, path and body — so a captured request cannot be
//    replayed as a different one, and the server holds only the public half.
//
// ⛔ THE SIGNATURE IS OVER THE BYTES THAT ARE SENT. The body is turned into JSON once and both
//    signed and sent: signing one encoding and sending another would be a request refused for a
//    reason nobody could find from either side.
//
// ⚠ WHAT IS NOT HERE: registering the business. Attaching a standing credential to an account is
//   not a decision a program makes on its own — it happens in a browser, with a person signed in,
//   and everything here needs it to have happened already.

import {
  businessPublicKey,
  host,
  mintDelegation,
  newAccountCode,
  NmtsError,
  registrationProofOf,
  request,
  resolveServer,
  rotationProof,
  signBusinessRequest,
  type ScopeName,
} from "@needmoretruth/nmts-cli/portable";

/** The four things a delegation token may carry, by name. The command-line package owns the list. */
export type { ScopeName } from "@needmoretruth/nmts-cli/portable";

/** Where a business talks. The network is not among these: no door here touches a chain. */
export interface BusinessOptions {
  /** The NMTS server. Defaults to https://nmts.me. */
  server?: string | undefined;
}

/** What a business needs to speak for itself: who it is, and the key it signs with. */
export interface BusinessCredentials {
  /** The business account's public id, base64url — what the server knows it by. */
  accountId: string;
  /** The private half of the registered key pair, base64url. Never sent. */
  privateKey: string;
}

/** Who this business is, and what it has spent today. */
export interface BusinessInfo {
  accountId: string;
  /** The registered public key, base64url. */
  publicKey: string;
  /** What the business called itself, or null. */
  name: string | null;
  /** ISO 8601, UTC. */
  createdAt: string;
  /**
   * When the registered key was last replaced, ISO 8601 UTC — null if it never was.
   *
   * ⚠ NULL ALSO WHEN THE SERVER IS OLDER THAN THE FIELD, and the two cannot be told apart from
   *   here. Neither answer means a rotation happened, which is what a caller reads it for.
   */
  keyChangedAt: string | null;
  /** How many users it has registered today, and the ceiling it is held to. */
  usersToday: number;
  usersDayCap: number;
}

/** One account a business made, as the server describes it. */
export interface RegisteredUser {
  accountId: string;
  createdAt: string;
  /** `active`, or `stopped` where a measure already stands against that id. */
  status: string;
  /**
   * The account's NMTS key — present ONLY when this call made it.
   *
   * ⛔ THE ONLY COPY THAT WILL EVER EXIST. The server keeps a verifier of a value derived from it
   *    and nothing else, so seal it before doing anything else: an account whose code is lost is
   *    one nobody — not its owner, not the business, not NMTS — can ever open again.
   */
  accountCode?: string;
}

/** What `delegate` is asked for. */
export interface DelegationOrder {
  /** The account id of the user this token speaks for. */
  user: string;
  /** What it may do. At least one. */
  scope: readonly ScopeName[];
  /** How long it lasts, in seconds. At most thirty days; longer is refused before anything is sent. */
  ttlSecs: number;
}

/** A business's own client. */
export interface Business {
  /** Who this business is, and what it has registered today. */
  info(): Promise<BusinessInfo>;
  /**
   * Make an account for one of this business's users, in the managed form: the business signs the
   * request, and the code is the business's to keep.
   *
   * With no argument a fresh NMTS key is made here and comes back in `accountCode`, for the
   * business to seal. With `{ accountCode }` it is a code the business already holds, and nothing
   * about it comes back.
   */
  registerUser(of?: { accountCode: string }): Promise<RegisteredUser>;
  /** Mint a token that lets one of this business's users act, for a while, within a scope. */
  delegate(order: DelegationOrder): Promise<string>;
  /**
   * Replace the registered key.
   *
   * ⛔ EVERY LIVE TOKEN THE OLD KEY SIGNED DIES HERE, and that is the point rather than a side
   *    effect: the server verifies against the current key and keeps no history, so this is the
   *    one act that withdraws every token at once — what a business does the hour it finds a leak.
   */
  rotateKey(newPrivateKey: string): Promise<void>;
}

/** What a device holding a `register` token calls to make its own account. */
export interface EmbeddedRegistration extends BusinessOptions {
  /** The NMTS key this device made. It stays here; what is sent is derived from it. */
  accountCode: string;
  /** The token the business minted for this account, carrying the `register` scope. */
  delegation: string;
}

/**
 * The business's own client.
 *
 * ⛔ IT DOES NO WORK UNTIL IT IS CALLED, exactly as `Nmts` does none: making one is free, and a
 *    key that is not one fails on the first call, where a caller can act on it.
 *
 * ⛔ AND IT REFUSES IN A PAGE, BY NAME. A business's signing key in a page is that key handed to
 *    everyone who opens it; what a page holds is a delegation token signed on the business's own
 *    machine. ⚠ The check moved here from `Nmts.business()` on 2026-09-20 — that file is at the
 *    length gate — and a rule that lives beside the thing it guards cannot be left behind by a
 *    second caller.
 */
export function businessClient(credentials: BusinessCredentials & BusinessOptions): Business {
  if (host().name === "browser") {
    throw new NmtsError("BUSINESS_IN_A_PAGE: a business's signing key does not belong in a browser.", {
      exitCode: 2,
      nextStep:
        "Nothing was sent. Sign on your own server and hand the page a delegation token — " +
        "`Nmts.device({ accountCode, delegation })` is what a page uses.",
    });
  }
  const { accountId, privateKey } = credentials;
  const server = resolveServer(credentials.server);

  /** One signed request. The body is turned into JSON once, and that is what is signed. */
  const signed = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const token = signBusinessRequest({ accountId, privateKey, method, path, body: new TextEncoder().encode(text) });
    // ⚠ `body`, not `text`: the request serialises the same value again — one object, one encoder,
    //   one process, the same bytes. Handing over the string would send a JSON string instead of
    //   the object the server parses.
    return await request(server, path, body === undefined ? { method, token } : { method, body, token });
  };

  return {
    async info(): Promise<BusinessInfo> {
      return readInfo(await signed("GET", "/p1/business"));
    },

    async registerUser(of?: { accountCode: string }): Promise<RegisteredUser> {
      const code = of?.accountCode ?? (await newAccountCode());
      const proof = await registrationProofOf(code);
      const made = readUser(await signed("POST", "/p1/users", { account_id: proof.accountId, auth_secret: proof.authSecret }));
      // ⛔ ANSWERED ONLY WHEN THIS CALL MADE IT. Handing back a code the caller already had would
      //    put a second copy of it somewhere the caller did not choose.
      return of === undefined ? { ...made, accountCode: code } : made;
    },

    async delegate(order: DelegationOrder): Promise<string> {
      return mintDelegation({
        business: accountId,
        user: order.user,
        privateKey,
        scope: order.scope,
        ttlSecs: order.ttlSecs,
      });
    },

    async rotateKey(newPrivateKey: string): Promise<void> {
      // ⛔ BOTH HALVES IN ONE HAND. The request is signed by the OLD key and carries a proof made
      //    by the NEW one over the old public key, so neither key alone can move a business.
      await signed("PUT", "/p1/business/key", {
        pubkey: businessPublicKey(newPrivateKey),
        proof: rotationProof(businessPublicKey(privateKey), newPrivateKey),
      });
    },
  };
}

/**
 * A device holding a `register` token makes its own account.
 *
 * ⛔ THE CODE STAYS ON THE DEVICE. What is sent is the pair every account door has always taken —
 *    the id the server knows the account by, and the one-way value it stores a verifier of — and
 *    the token the business signed is what says this account may be made at all. The business
 *    never sees the code, which is what makes this the form where the person holds their own key.
 */
export async function registerWithDelegation(options: EmbeddedRegistration): Promise<RegisteredUser> {
  const proof = await registrationProofOf(options.accountCode);
  const answer = await request(resolveServer(options.server), "/p1/users", {
    method: "POST",
    body: { account_id: proof.accountId, auth_secret: proof.authSecret },
    token: options.delegation,
  });
  return readUser(answer);
}

/** The server's answer, read field by field rather than trusted whole. */
function readInfo(answer: unknown): BusinessInfo {
  const row = field(answer, "business");
  return {
    accountId: text(row, "account_id"),
    publicKey: text(row, "pubkey"),
    name: typeof field(row, "name") === "string" ? text(row, "name") : null,
    createdAt: text(row, "created_at"),
    keyChangedAt: typeof field(row, "key_changed_at") === "string" ? text(row, "key_changed_at") : null,
    usersToday: count(row, "users_today"),
    usersDayCap: count(row, "users_day_cap"),
  };
}

function readUser(answer: unknown): RegisteredUser {
  const row = field(answer, "account");
  return { accountId: text(row, "account_id"), createdAt: text(row, "created_at"), status: text(row, "status") };
}

function field(from: unknown, name: string): unknown {
  return typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined;
}

function text(from: unknown, name: string): string {
  const value = field(from, name);
  if (typeof value !== "string") throw unreadable(name);
  return value;
}

function count(from: unknown, name: string): number {
  const value = field(from, name);
  if (typeof value !== "number") throw unreadable(name);
  return value;
}

/**
 * The server answered something this version cannot read.
 *
 * ⚠ THE FIELD NAME AND NOT THE VALUE. An answer in the wrong shape may have come from something in
 *   front of the server, and whatever it carried is not ours to repeat into a caller's log.
 */
function unreadable(name: string): NmtsError {
  return new NmtsError(`The server's answer carried no usable \`${name}\`.`, {
    exitCode: 1,
    nextStep: "Check that `server` names an NMTS server, and that this package is not older than it.",
  });
}
