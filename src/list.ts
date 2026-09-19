// The account's files and folders, as paths.
//
// ⛔ THE LIST IS OPENED HERE, ON THIS MACHINE. The server holds it sealed and cannot read a name in
//    it; the account code is what opens it, which is why `list()` needs the code and not just the
//    key. What comes back is every live entry with its full path — the trash is left out, the same
//    way `nmts ls` leaves it out unless asked.

import {
  activeWalletOf,
  buildIndex,
  fullPathOf,
  isLive,
  KIND_FOLDER,
  readFileList,
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

/** Every live entry, as a path, sorted so a folder comes before what is in it. */
export function toEntries(entries: readonly ManifestEntry[]): Entry[] {
  const index = buildIndex(entries);
  return entries
    .filter((e) => isLive(index, e))
    .map((e) => ({
      id: e.id,
      path: fullPathOf(index, e),
      kind: e.kind === KIND_FOLDER ? ("folder" as const) : ("file" as const),
      size: e.size,
      createdAt: new Date(e.createdAt).toISOString(),
      updatedAt: new Date(e.updatedAt).toISOString(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function listEntries(opened: Opened): Promise<Entry[]> {
  return withAccount(opened, async (held) => toEntries((await readList(held)).entries));
}
