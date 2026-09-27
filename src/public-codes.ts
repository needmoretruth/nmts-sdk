// An account's public codes: the values other accounts send files to.
//
// ⛔ ONE KEY, NUMBERED CODES. Every code is derived from the account's NMTS key at a number — 0 is
//    the one every account starts with — so there is nothing to generate and nothing to store. An
//    account holds one to three live codes (a Platform user exactly one), makes a new one at the next
//    number, and revokes one for good; which ceilings apply is the server's answer, read by `list`.
//
// ⛔ EVERY VERB BORROWS THE KEY ONCE, on either root. The codes come from the key, so a caller that
//    holds it — this process, or a business's sealed store — lists, makes and revokes them the same
//    way: a feature works the same whoever holds the key. The functions underneath are the
//    command-line tool's own (`nmts public-code list · new · revoke`), with the terminal taken off.
//
// ⛔ AN IDENTITY IS NEVER TAKEN FROM THE CALLER. What `create` publishes is what the key derives at
//    that number; there is no form of it that sends bytes somebody handed in.
//
// ⚠ A REFUSAL ARRIVES AS THE SERVER'S `ServerError`, with its `code` to branch on:
//   `TOO_MANY_LIVE_CODES`, `PUBLIC_CODE_DAY_CAP`, `LAST_LIVE_CODE`, `PLATFORM_REPLACE_ONLY`.

import {
  codeActivity,
  defaultCode,
  liveCodes,
  loadCrypto,
  nextCodeIndex,
  NmtsError,
  publishCode,
  readPublicCodes,
  requireCodeIndex,
  revokeCode,
  shareKeyRing,
  shareKeysAt,
  toBase64Url,
  type CodeActivity,
  type PublicCodeRow,
  type ShareKeyRing,
} from "@needmoretruth/nmts-cli/portable";

import { withAccount, type Held, type Opened } from "./session.ts";

/** One code, as `list` answers it. */
export interface PublicCodeInfo {
  /** Its number. 0 is the code the account started with. */
  index: number;
  /** The grouped form a person reads, copies and types. */
  code: string;
  /** The same 16 bytes as the wire carries them, base64url. */
  address: string;
  /** The code this account shows and sends from: its lowest-numbered live one. */
  default: boolean;
  /** ISO 8601, UTC. `revokedAt` is null while the code is live. */
  createdAt: string;
  revokedAt: string | null;
  /** Shares sent from it, shares received with it, support messages that carry it. */
  sent: number;
  received: number;
  messages: number;
  /** With `{ activity: true }`: the shares themselves. */
  activity?: CodeActivity;
}

/** What `list` answers: every code, live ones first, and the server's ceilings on making more. */
export interface PublicCodeList {
  codes: PublicCodeInfo[];
  live: number;
  liveMax: number;
  madeToday: number;
  dayCap: number;
}

/** One code this key derives, with no request made. */
export interface PublicCodeIdentity {
  index: number;
  code: string;
  address: string;
}

/** What `create` answers: the code made, and the number it revoked in the same request, if any. */
export interface CreatedPublicCode extends PublicCodeIdentity {
  revoked: number | null;
}

export interface PublicCodes {
  /** Every code this account ever published. `{ activity: true }` adds each one's shares. */
  list(options?: { activity?: boolean }): Promise<PublicCodeList>;
  /**
   * Publish the code at the next number. `{ replace }` revokes that live code in the same request —
   * the only way a Platform user, who holds exactly one, changes theirs.
   */
  create(options?: { replace?: number }): Promise<CreatedPublicCode>;
  /** Revoke one code, for good. The account's last live code is refused (`LAST_LIVE_CODE`). */
  revoke(index: number): Promise<void>;
  /** The code this key derives at `index`. Offline: nothing is sent. */
  identityFor(index: number): Promise<PublicCodeIdentity>;
}

/**
 * The code at a row's number, derived — and refused by name when the server holds another. From a
 * ring, so a list runs the key's slow derivation once, not once per row.
 */
function derived(ring: ShareKeyRing, row: PublicCodeRow): string {
  const keys = ring.at(row.index);
  if (toBase64Url(keys.address) !== row.address) {
    throw new NmtsError(`PUBLIC_CODE_MISMATCH: the server lists a public code #${row.index} this NMTS key does not derive.`, {
      exitCode: 4,
      nextStep: "Nothing was changed. The key and the credential this client holds belong to different accounts.",
    });
  }
  return keys.display;
}

async function listFor(held: Held, activity: boolean): Promise<PublicCodeList> {
  const crypt = await loadCrypto();
  const list = await readPublicCodes(held.server, held.bearer);
  const live = liveCodes(list);
  const ordered = [...live, ...list.codes.filter((c) => c.revokedAt !== null)];
  const def = defaultCode(list)?.index ?? null;
  const shares = activity
    ? await codeActivity(crypt, held.code, { server: held.server, token: held.bearer, accountId: held.accountId }, list)
    : null;
  const ring = shareKeyRing(crypt, held.code);
  let shown: Map<number, string>;
  try {
    shown = new Map(ordered.map((row) => [row.index, derived(ring, row)]));
  } finally {
    ring.wipe();
  }
  return {
    codes: ordered.map((row) => ({
      index: row.index,
      code: shown.get(row.index) ?? "",
      address: row.address,
      default: row.index === def,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      sent: row.sent,
      received: row.received,
      messages: row.support,
      ...(shares === null ? {} : { activity: shares.get(row.index) ?? { sent: [], received: [] } }),
    })),
    live: live.length,
    liveMax: list.liveMax,
    madeToday: list.madeToday,
    dayCap: list.dayCap,
  };
}

/** Derive the code at `index` from a borrowed key. Shared with the business's batch. */
export async function identityAt(code: string, index: number): Promise<PublicCodeIdentity & { identity: string }> {
  const crypt = await loadCrypto();
  const keys = shareKeysAt(crypt, code, requireCodeIndex(index));
  try {
    return { index, code: keys.display, address: toBase64Url(keys.address), identity: toBase64Url(keys.identity) };
  } finally {
    keys.wipe();
  }
}

/** The four verbs on one opened account. */
export function publicCodesOn(opened: Opened): PublicCodes {
  return {
    list: (options = {}) => withAccount(opened, (held) => listFor(held, options.activity === true)),
    create: (options = {}) =>
      withAccount(opened, async (held) => {
        const replace = options.replace === undefined ? undefined : requireCodeIndex(options.replace);
        const crypt = await loadCrypto();
        const list = await readPublicCodes(held.server, held.bearer);
        const made = await publishCode(crypt, held.code, { server: held.server, token: held.bearer }, nextCodeIndex(list), replace);
        return { index: made.index, code: made.code, address: made.address, revoked: replace ?? null };
      }),
    revoke: (index) =>
      withAccount(opened, (held) => revokeCode({ server: held.server, token: held.bearer }, requireCodeIndex(index))),
    identityFor: (index) =>
      withAccount(opened, async (held) => {
        const got = await identityAt(held.code, index);
        return { index: got.index, code: got.code, address: got.address };
      }),
  };
}
