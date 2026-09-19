// The account's files and folders, as paths.
//
// ⛔ THE LIST IS OPENED HERE, ON THIS MACHINE. The server holds it sealed and cannot read a name in
//    it; the account code is what opens it, which is why `list()` needs the code and not just the
//    key. What comes back is every live entry with its full path — the trash is left out, the same
//    way `nmts ls` leaves it out unless asked.
//
// ⛔ AND "IN THE TRASH" IS INHERITED, NOT STAMPED. Trashing a folder marks the folder alone, so a
//    file under it is in the trash without carrying an instant of its own — which is why
//    `trashedAt` below is read with the walk from the shared module rather than off the entry.
//    Reading `deletedAt` and nothing else would answer "not in the trash" for most of the trash.

import {
  activeWalletOf,
  buildIndex,
  fullPathOf,
  isLive,
  KIND_FOLDER,
  readFileList,
  trashedAt,
  type ManifestEntry,
  type PaddingRule,
} from "@needmoretruth/nmts-cli/portable";

import { withAccount, type Held, type Opened } from "./session.ts";

/** One thing in the account. */
export interface Entry {
  /** The server's id for a file; a client-made id for a folder. Stable for the entry's life. */
  id: string;
  /** Full path from the top of the account, `photos/2026/cat.jpg`. Folders end without a slash. */
  path: string;
  kind: "file" | "folder";
  /** Plaintext bytes. 0 for a folder. */
  size: number;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
  /**
   * When this went to the trash — ISO 8601, UTC. Absent unless it is in the trash, which is why
   * it is the field to read rather than a flag: a path is in the trash exactly when it has one.
   *
   * ⚠ For something inside a trashed folder it is the FOLDER's instant, because that is when the
   *   thirty days started for it. Restoring the folder brings it back with the folder.
   */
  trashedAt?: string;
}

/** What `list()` takes. */
export interface ListOptions {
  /**
   * Include what is in the trash, each entry carrying `trashedAt`. Off by default, so a program
   * that asks for the account's files is never handed something already on its way out.
   */
  trash?: boolean | undefined;
}

/** The opened list: its entries, and the settings an upload needs from it. */
export interface OpenedList {
  /** Empty for a new account that has no list yet — not an error. */
  entries: readonly ManifestEntry[];
  /**
   * How coarsely a file's last part is rounded before sealing — the account's choice, made in the
   * browser. An upload that rounded differently would say which program made it.
   */
  padding: PaddingRule;
  /**
   * Which of this key's wallets pays, by index — the account's own number.
   *
   * ⛔ IT COMES OUT OF THIS READ AND NOT A SECOND ONE, the way the command-line tool takes it. A
   *    wallet-paid upload prices the wallet it is about to sign with, so the number that was priced
   *    and the number that signs have to come from one answer.
   */
  activeWallet: number;
}

/** Read the sealed list and open it. */
export async function readList(held: Held): Promise<OpenedList> {
  const list = await readFileList(held.server, held.bearer, held.code, held.accountId);
  return {
    entries: list.manifest?.entries ?? [],
    padding: list.manifest?.settings?.paddingMode === "pow2" ? "pow2" : "padme",
    activeWallet: activeWalletOf(list.manifest?.settings),
  };
}

/**
 * Every entry as a path, sorted so a folder comes before what is in it.
 *
 * ⚠ `trash` WIDENS WHAT COMES BACK; it does not narrow it to the trash. A program organising an
 *   account wants one list with the state of everything in it, and asking twice to get both halves
 *   would be two reads of a list that can move in between.
 */
export function toEntries(entries: readonly ManifestEntry[], options: ListOptions = {}): Entry[] {
  const index = buildIndex(entries);
  const wanted = options.trash === true ? entries : entries.filter((e) => isLive(index, e));
  return wanted
    .map((e) => {
      const gone = trashedAt(index, e);
      return {
        id: e.id,
        path: fullPathOf(index, e),
        kind: e.kind === KIND_FOLDER ? ("folder" as const) : ("file" as const),
        size: e.size,
        createdAt: new Date(e.createdAt).toISOString(),
        updatedAt: new Date(e.updatedAt).toISOString(),
        // ⚠ Absent rather than null for something that is not in the trash: the field's presence is
        //   the answer, and `exactOptionalPropertyTypes` keeps the two from being confused.
        ...(gone === null ? {} : { trashedAt: new Date(gone).toISOString() }),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function listEntries(opened: Opened, options: ListOptions = {}): Promise<Entry[]> {
  return withAccount(opened, async (held) => toEntries((await readList(held)).entries, options));
}
