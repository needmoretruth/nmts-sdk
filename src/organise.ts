// Folders, moving, renaming and the trash — the five verbs that change where a file is rather than
// what is in it.
//
// ⛔ NONE OF THEM SPENDS AND NONE OF THEM SENDS BYTES. A folder has no server row at all; a name and
//    a parent live only inside the sealed list, which the server holds and cannot read. What the
//    trash costs is nothing extra: a file in it goes on being stored, and paid for, until the
//    thirty days run out. A delegation token needs `files_write` for all five and nothing more —
//    `storage_spend` is about money, and no money moves here.
//
// ⛔ THE EDITING ITSELF IS THE COMMAND-LINE PACKAGE'S `drive-edit`, NOT A COPY OF IT. Every rule
//    below the surface — one write per run, every guard re-decided after a lost compare-and-swap,
//    the server row before the list, a trashed folder's children keeping their own clock — is
//    written once, over there, and `nmts mv` and `move()` are the same function with a different
//    caller. A second implementation here would be a second place for those to be got right, and
//    the copy nobody re-reads is the one that quietly disagrees.
//
// ⛔ AND EVERY REFUSAL ARRIVES WITH A CODE: `NOT_FOUND`, `NAME_TAKEN`, `BAD_NAME`, `NOT_IN_TRASH`,
//    `INTO_ITSELF`. A program branches on `error.code`; `nextStep` is the sentence for whoever it
//    ends up in front of.

import {
  makeFolder,
  moveEntries,
  renameEntry,
  trashPaths,
} from "@needmoretruth/nmts-cli/drive-edit";
import type { ListEditInput } from "@needmoretruth/nmts-cli/portable";

import { withAccount, type Held, type Opened } from "./session.ts";

/** What making a folder did. */
export interface MkdirResult {
  /** The folder asked for, as the drive spells it: no leading slash, no trailing one. */
  path: string;
  /**
   * The folders this call actually made, outermost first.
   *
   * ⚠ EMPTY IS A SUCCESS, not a refusal: the folder was already there, which is the answer the
   *   caller wanted. It is named rather than counted so that a caller can undo exactly what it did.
   */
  created: string[];
}

/** One thing a move carried. */
export interface Moved {
  /** Its full path before the move. */
  from: string;
  /**
   * Its full path now.
   *
   * ⚠ Null when another device took it out of the list between the read and the write — it was
   *   moved, and then there was nowhere for it to be. Nothing is invented for that case.
   */
  to: string | null;
}

export interface MoveResult {
  /**
   * What moved, in the order the paths were given.
   *
   * ⚠ Something already in the destination is not in here: nothing was written for it, and saying
   *   it moved would be a claim about a save that never happened.
   */
  moved: Moved[];
}

/** What renaming did: the full path before and the full path after. */
export interface RenameResult {
  from: string;
  to: string;
}

/** What went to the trash. Restorable for thirty days, and still stored until then. */
export interface RemoveResult {
  removed: string[];
}

/** What came back out of the trash. */
export interface RestoreResult {
  restored: string[];
}

/**
 * One path or many.
 *
 * ⛔ A STRING IS NOT AN ARRAY OF ONE CHARACTER HERE. `remove("notes.txt")` is what a program with
 *    one file writes, and taking only an array would make the single case the awkward one.
 */
function many(paths: string | readonly string[]): readonly string[] {
  return typeof paths === "string" ? [paths] : paths;
}

/** What the editing underneath takes: where to talk, what opens the list, and whose list it is. */
function editing(held: Held): ListEditInput {
  return { server: held.server, apiKey: held.bearer, code: held.code, accountId: held.accountId };
}

/**
 * Make a folder, and any folder above it that is missing.
 *
 * A folder that is already there IS the folder asked for — never a numbered one — so calling this
 * twice is safe and the second call writes nothing.
 */
export async function makeFolderAt(opened: Opened, path: string): Promise<MkdirResult> {
  return withAccount(opened, async (held) => {
    const made = await makeFolder(editing(held), path);
    return { path: made.path, created: made.made };
  });
}

/**
 * Move files and folders into a folder. `"/"` is the top of the account.
 *
 * ⛔ A NAME ALREADY IN THE DESTINATION IS REFUSED, not numbered. An upload picks `report (2).pdf`
 *    because nobody is watching; a move is a program saying where something goes, and quietly
 *    putting it somewhere else is how a caller loses track of its own files.
 */
export async function moveTo(
  opened: Opened,
  paths: string | readonly string[],
  toFolder: string,
): Promise<MoveResult> {
  return withAccount(opened, async (held) => {
    const outcome = await moveEntries(editing(held), many(paths), toFolder);
    return { moved: outcome.moved.map((m) => ({ from: m.from, to: m.path })) };
  });
}

/**
 * Give one thing a new name, where it is.
 *
 * The name is a name: a `/` in it is refused (`BAD_NAME`) rather than taken as a move, and a name
 * the folder already holds is refused (`NAME_TAKEN`) rather than numbered.
 */
export async function renameTo(opened: Opened, path: string, name: string): Promise<RenameResult> {
  return withAccount(opened, async (held) => {
    const outcome = await renameEntry(editing(held), path, name);
    return { from: outcome.fromPath, to: beside(outcome.fromPath, name) };
  });
}

/**
 * Move things to the trash, where they can be restored for thirty days. A folder takes everything
 * under it.
 *
 * ⚠ THE BYTES ARE STILL THERE AND STILL PAID FOR until the thirty days run out. Nothing in this
 *   package destroys a stored file: the door that does is closed to an API key on purpose.
 */
export async function removeToTrash(
  opened: Opened,
  paths: string | readonly string[],
): Promise<RemoveResult> {
  return withAccount(opened, async (held) => {
    const outcome = await trashPaths(editing(held), "rm", many(paths), { strict: true });
    return { removed: outcome.paths };
  });
}

/**
 * Bring things back out of the trash, to where they were.
 *
 * ⛔ REFUSED RATHER THAN SKIPPED. Something that is not in the trash answers `NOT_IN_TRASH`, and a
 *    name that has been taken since answers `NAME_TAKEN`: a program that asked for five things back
 *    and got four has no line of prose to read about the fifth.
 */
export async function restoreFromTrash(
  opened: Opened,
  paths: string | readonly string[],
): Promise<RestoreResult> {
  return withAccount(opened, async (held) => {
    const outcome = await trashPaths(editing(held), "restore", many(paths), { strict: true });
    return { restored: outcome.paths };
  });
}

/**
 * The path a renamed thing now has: its old one, with the last name replaced.
 *
 * ⛔ STRING ARITHMETIC, NOT `node:path`. A drive path always uses `/`, whatever separator the
 *    machine reading it happens to use, and the platform's own join answers in the MACHINE's
 *    separator — which on Windows would hand a caller a path no lookup here accepts. A name cannot
 *    contain `/` (that is what `BAD_NAME` is for), so the last one is the whole of what changes.
 */
function beside(path: string, name: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? name : `${path.slice(0, cut + 1)}${name}`;
}
