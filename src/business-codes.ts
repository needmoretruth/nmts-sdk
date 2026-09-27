// A business replacing its users' public codes in one signed request.
//
// ⛔ THE BUSINESS KEY ALONE CANNOT DO THIS, AND THAT IS THE DESIGN. The server cannot tell whether a
//    new identity came from the user's own key — it cannot open anything — so each item carries that
//    user's sign-in secret, which only their NMTS key derives, and the server checks it the way it
//    checks a sign-in. Whoever holds the user's root (the business in the managed form, the user's
//    device in the embedded form) is therefore the only one who can build an item.
//
// ⛔ SO EVERY ITEM IS BUILT FROM A ROOT, HERE. There is no form of this that takes an identity or a
//    secret from the caller: each is derived from the root it belongs to, borrowed once per attempt.
//
// ⚠ A PLATFORM USER HOLDS EXACTLY ONE CODE. Every item publishes the next number and the server
//   revokes the user's other code in the same step; for a user with none it is the first publish.
//   Which number is next is not readable with the business key, so without `next` this walks from 0,
//   retrying only the items the server refused as `INDEX_NOT_NEXT` or `PUBLIC_CODE_REVOKED`. The
//   last answer's `index` plus one is the `next` to pass the time after.

import { NmtsError, PUBLISH_TRIES, registrationProofOf } from "@needmoretruth/nmts-cli/portable";

import { identityAt } from "./public-codes.ts";
import type { Root } from "./root.ts";

/** One user whose code is replaced: the root that holds their key, and the number to publish at. */
export interface PublicCodeUser {
  root: Root;
  /** The number the user's new code gets. Absent: found by walking up from 0. */
  next?: number;
}

/** What happened to one user, in the order the users were given. */
export type PublicCodeResult =
  | { ok: true; index: number; code: string }
  | { ok: false; error: string };

/** How many users one request carries — the server's ceiling. More are sent in several requests. */
export const PUBLIC_CODE_BATCH = 100;

/**
 * The business door that needs both secrets: its items are built from the USERS' roots, handed in
 * by the caller, and the business's signing key still never touches them. Part of `Business`.
 */
export interface PublicCodeDoor {
  /**
   * Replace users' public codes: each gets its code at `next` (or the next free number) and loses
   * the one it had, in one signed request per hundred users. Each item is built from that user's
   * root — its identity and its sign-in secret — so only a holder of the user's key can build one.
   * One result per user, in order; one user's refusal does not stop the others.
   */
  setPublicCodes(users: readonly PublicCodeUser[]): Promise<PublicCodeResult[]>;
}

/** A signed request on the business's own key, as `businessClient` makes one. */
export type SignedCall = (method: "POST", path: string, body: unknown) => Promise<unknown>;

interface Pending {
  at: number;
  root: Root;
  index: number;
  walks: boolean;
}

interface Item {
  user: string;
  auth_secret: string;
  index: number;
  identity: string;
  address: string;
}

/** The server's `results`, read entry by entry. */
function readResults(answer: unknown, count: number): { ok: boolean; error: string }[] {
  const rows: unknown = typeof answer === "object" && answer !== null ? Reflect.get(answer, "results") : undefined;
  if (!Array.isArray(rows) || rows.length !== count) {
    throw new NmtsError("The server's answer carried no usable `results`.", {
      exitCode: 1,
      nextStep: "Check that `server` names an NMTS server, and that this package is not older than it.",
    });
  }
  return rows.map((row: unknown) => {
    const ok = typeof row === "object" && row !== null && Reflect.get(row, "ok") === true;
    const error: unknown = typeof row === "object" && row !== null ? Reflect.get(row, "error") : undefined;
    return { ok, error: typeof error === "string" ? error : "unreadable" };
  });
}

/** Build one item from a root, borrowing its key once. */
async function itemFor(p: Pending): Promise<{ item: Item; code: string }> {
  return p.root.withCode(async (code) => {
    const proof = await registrationProofOf(code);
    const made = await identityAt(code, p.index);
    return {
      item: { user: proof.accountId, auth_secret: proof.authSecret, index: p.index, identity: made.identity, address: made.address },
      code: made.code,
    };
  });
}

/** Replace every user's public code; one result per user, in order. */
export async function setPublicCodesWith(signed: SignedCall, users: readonly PublicCodeUser[]): Promise<PublicCodeResult[]> {
  const results: PublicCodeResult[] = users.map(() => ({ ok: false, error: "NOT_SENT" }));
  let pending: Pending[] = users.map((u, at) => ({ at, root: u.root, index: u.next ?? 0, walks: u.next === undefined }));
  for (let round = 0; round < PUBLISH_TRIES && pending.length > 0; round += 1) {
    const again: Pending[] = [];
    for (let from = 0; from < pending.length; from += PUBLIC_CODE_BATCH) {
      const chunk = pending.slice(from, from + PUBLIC_CODE_BATCH);
      const built: { item: Item; code: string }[] = [];
      for (const p of chunk) built.push(await itemFor(p));
      const answer = await signed("POST", "/p1/public-codes", { items: built.map((b) => b.item) });
      readResults(answer, chunk.length).forEach((r, j) => {
        const p = chunk[j];
        const b = built[j];
        if (p === undefined || b === undefined) return;
        if (r.ok) {
          // ⚠ The number the code was DERIVED at, which is the number the item named.
          results[p.at] = { ok: true, index: p.index, code: b.code };
          return;
        }
        results[p.at] = { ok: false, error: r.error };
        if (p.walks && (r.error === "INDEX_NOT_NEXT" || r.error === "PUBLIC_CODE_REVOKED")) {
          again.push({ ...p, index: p.index + 1 });
        }
      });
    }
    pending = again;
  }
  return results;
}
