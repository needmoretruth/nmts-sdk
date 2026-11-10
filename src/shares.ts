// Sharing one file with another NMTS account: send, see what came in and what went out, receive,
// take back. The command-line tool's own functions (`nmts share · shares · receive · unshare`),
// with the terminal taken off (spec 2026-09-20 unit C).
//
// ⛔ THE SAME ON EVERY ROOT. The key opens the file and seals it to the recipient, so whoever holds
//    the key shares the same way: a device key, a business's sealed store, or a delegation token
//    beside the key. A token sends only with its `share` bit and the code's proof, and the proof is
//    made here from the key, per request, and sent on the two sending requests alone.
//
// ⛔ CALLING `share` IS THE DECISION. The command asks its person `--yes` first; a program decides
//    by calling, and a share cannot be recalled once opened, so the docs say so beside the verb.
//
// ⚠ A REFUSAL ARRIVES AS THE SERVER'S `ServerError`, with its `code`: `DELEGATION_SCOPE` when a
//   token lacks the `share` bit, `PUBLIC_CODE_REVOKED` when the recipient revoked that code, and
//   `AGENT_VERIFY_REQUIRED` when an API key sends without a person's recent check (it stays so).

import {
  addressFromTyped,
  fromBase64Url,
  loadCrypto,
  NmtsError,
  receivedShares,
  receiveShare,
  registrationProofOf,
  removeShare,
  sendShare,
  sentShares,
  shareableFileAt,
  type ReadOptions,
  type ReceivedFile,
  type ReceivedShare,
  type SentShare,
  type ShareAccount,
} from "@needmoretruth/nmts-cli/portable";

import { bytesSink, DEFAULT_IN_MEMORY_LIMIT } from "./get.ts";
import { nodeSeams } from "./node-seams.ts";
import { withAccount, type Held, type Opened } from "./session.ts";

export type { ReceivedShare, SentShare } from "@needmoretruth/nmts-cli/portable";

export interface ShareOptions {
  /** Which of this account's live public codes sends. Absent = the lowest-numbered live one. */
  as?: number | undefined;
}

/** Who one file was shared with, newest first as the server lists them. */
export interface SentShareRow {
  /** The share's id; `unshare(id)` withdraws it. */
  id: string;
  /** The recipient's public code, readable form — the same text `share` answered. */
  recipient: string;
  createdAt: string;
  /** Which of this account's codes sent it. */
  fromIndex: number;
  /** True once the recipient has revoked the code it was sent to. */
  recipientRevoked: boolean;
}

/** A received file held in memory, checked against the hash its sender sealed. */
export interface ReceivedBytes extends Omit<ReceivedFile, "bytes" | "delivered" | "parts"> {
  bytes: Uint8Array;
}

/** A received file written to disk, checked before it was made visible. */
export interface ReceivedTo extends Omit<ReceivedFile, "bytes" | "delivered" | "parts"> {
  /** Where it was written. */
  path: string;
  size: number;
}

export interface ReceiveOptions {
  /** The in-memory ceiling, as for `get()`. Default 256 MiB. */
  maxBytes?: number | undefined;
  /** Replace a file already at `to`. Default false. */
  force?: boolean | undefined;
}

/** What `nmts.shares` answers. */
export interface Shares {
  /** Everything shared with this account. `total` is larger than the list when the server bounded it. */
  received(): Promise<{ shares: ReceivedShare[]; total: number }>;
  /** One received file in memory; with `to`, streamed to that file instead. */
  get(id: string): Promise<ReceivedBytes>;
  get(id: string, to: string, options?: ReceiveOptions): Promise<ReceivedTo>;
  get(id: string, to?: string, options?: ReceiveOptions): Promise<ReceivedBytes | ReceivedTo>;
  /** Who one file of this account was shared with. */
  sent(path: string): Promise<SentShareRow[]>;
}

async function accountOf(held: Held, withProof: boolean): Promise<ShareAccount> {
  return {
    server: held.server,
    bearer: held.bearer,
    code: held.code,
    accountId: held.accountId,
    network: held.network,
    // ⛔ ONLY WHERE A SHARE LEAVES. The proof is the code's own act; a door that does not ask for
    //    it is not handed it.
    ...(withProof ? { accountProof: (await registrationProofOf(held.code)).authSecret } : {}),
  };
}

/** Seal one file of this account to `publicCode` and send it. A share cannot be recalled once opened. */
export async function shareFile(opened: Opened, path: string, publicCode: string, options: ShareOptions = {}): Promise<SentShare> {
  // ⛔ THE CODE IS CHECKED HERE, BEFORE THE NETWORK: a typo must not become a question to the server
  //    about somebody who might exist.
  const recipient = addressFromTyped(await loadCrypto(), publicCode);
  return withAccount(opened, async (held) => {
    const account = await accountOf(held, true);
    return sendShare(account, await shareableFileAt(account, path), recipient, { as: options.as });
  });
}

/**
 * `put(file, { shareWith })` stored the file and then a share failed.
 *
 * ⛔ THE UPLOAD STAYS, AND THIS SAYS SO. The money is spent and the file is in the account; undoing
 *    it because a share failed would lose what the caller paid for. `upload` is what `put` would
 *    have answered, `shared` the shares that did go, `failedFor` the code that did not, and `cause`
 *    the refusal itself.
 */
export class ShareAfterUploadError extends NmtsError {
  readonly upload: { name: string; path: string; id: string };
  readonly shared: SentShare[];
  readonly failedFor: string;
  override readonly cause: unknown;

  constructor(upload: { name: string; path: string; id: string }, shared: SentShare[], failedFor: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`"${upload.path}" was uploaded, but sharing it with ${failedFor} failed: ${why}`, {
      exitCode: cause instanceof NmtsError ? cause.exitCode : 1,
      nextStep: `The file stays in the account. Share it again with share("${upload.path}", code).`,
    });
    this.name = "ShareAfterUploadError";
    this.upload = upload;
    this.shared = shared;
    this.failedFor = failedFor;
    this.cause = cause;
  }
}

/** Check every code before anything is sent, so a typo costs nothing. */
export async function checkShareCodes(codes: readonly string[]): Promise<void> {
  const crypt = await loadCrypto();
  for (const code of codes) addressFromTyped(crypt, code);
}

/** Share a file just stored with each code in turn; the first failure stops it, the upload stays. */
export async function shareStored(
  opened: Opened,
  upload: { name: string; path: string; id: string },
  codes: readonly string[],
): Promise<SentShare[]> {
  const shared: SentShare[] = [];
  for (const code of codes) {
    try {
      shared.push(await shareFile(opened, upload.path, code));
    } catch (error) {
      throw new ShareAfterUploadError(upload, shared, code, error);
    }
  }
  return shared;
}

/** Withdraw a share this account sent, or remove one it was sent. A copy already taken stays taken. */
export async function unshareOf(opened: Opened, id: string): Promise<void> {
  return withAccount(opened, async (held) => removeShare(await accountOf(held, false), id));
}

export function sharesOn(opened: Opened, read: () => ReadOptions | undefined): Shares {
  function get(id: string): Promise<ReceivedBytes>;
  function get(id: string, to: string, options?: ReceiveOptions): Promise<ReceivedTo>;
  function get(id: string, to?: string, options?: ReceiveOptions): Promise<ReceivedBytes | ReceivedTo>;
  async function get(id: string, to?: string, options: ReceiveOptions = {}): Promise<ReceivedBytes | ReceivedTo> {
    return withAccount(opened, async (held) => {
      const account = await accountOf(held, false);
      if (to === undefined) {
        const memory = bytesSink(options.maxBytes ?? DEFAULT_IN_MEMORY_LIMIT);
        const got = await receiveShare(account, id, () => memory.sink, read());
        return { ...described(got), bytes: memory.take() };
      }
      const sink = nodeSeams(
        "SHARE_TO_UNAVAILABLE",
        "Nothing was fetched. Use shares.get(id), which answers the bytes — a page writes them out itself.",
      ).sink(to, { force: options.force === true });
      const got = await receiveShare(account, id, () => sink, read());
      return { ...described(got), path: to, size: got.bytes };
    });
  }
  return {
    received: () => withAccount(opened, async (held) => receivedShares(await accountOf(held, false))),
    get,
    sent: (path) =>
      withAccount(opened, async (held) => {
        const { rows } = await sentShares(await accountOf(held, false), path);
        const crypt = await loadCrypto();
        return rows.map((row) => sentRow(row, (address) => crypt.share_address_display(fromBase64Url(address))));
      }),
  };
}

function described(got: ReceivedFile): Omit<ReceivedFile, "bytes" | "delivered" | "parts"> {
  return { id: got.id, name: got.name, sender: got.sender, senderRevoked: got.senderRevoked, toIndex: got.toIndex, toCode: got.toCode };
}

function sentRow(row: unknown, display: (address: string) => string): SentShareRow {
  const field = (name: string): unknown => (typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined);
  const id = field("id");
  const address = field("recipient_address");
  const createdAt = field("created_at");
  if (typeof id !== "string" || typeof address !== "string" || typeof createdAt !== "string") {
    throw new NmtsError("The server listed a share this version cannot read.", {
      nextStep: "Nothing was changed. A newer version of this package may understand it.",
    });
  }
  const from = field("from_index");
  return {
    id,
    recipient: display(address),
    createdAt,
    fromIndex: typeof from === "number" ? from : 0,
    recipientRevoked: field("recipient_code_revoked") === true,
  };
}
