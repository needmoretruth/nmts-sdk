// The recovery list, for a program: the file `nmts recovery-list` writes, and the switch that has
// each small wallet upload carry a copy of it to the storage network (spec 2026-09-20 unit B).
//
// ⛔ THE SAME FOR EVERY ROOT. The three recovery doors ask for the account code's proof beside the
//    credential — an API key or a delegation token alike — and the proof comes out of the code the
//    root hands over for this one call. A business that holds the key and a person who holds it
//    get the same file and flip the same switch.
//
// ⛔ THE LIST IS THE COMMAND LINE'S, BYTE FOR BYTE. Building it is `makeRecoveryList` in the
//    command-line package; this file only opens the account and names what comes back.

import {
  makeRecoveryList,
  NmtsError,
  readRecoveryCopy,
  recordRecoveryList,
  registrationProofOf,
  setRecoveryCopy,
  type RecoveryAccount,
} from "@needmoretruth/nmts-cli/portable";

import { withAccount, type Held, type Opened } from "./session.ts";

/** The recovery list, as the file `nmts recovery-list` writes. */
export interface RecoveryList {
  /** The file name the command line gives it, e.g. `nmts-recovery-map-hAVCsRVv-0007.nmtsmap`. */
  filename: string;
  /** The file itself. It opens with the account code and nothing else. */
  content: Uint8Array;
  /** The list's number. Each new list beats the last. */
  seq: number;
  /** How many files it describes, and their total size in bytes. */
  files: number;
  bytes: number;
  /** Ids of stored files the server knows and the sealed file list does not describe. */
  missing: readonly string[];
}

/** The storage-network copy's switch. */
export interface RecoveryCopy {
  /** Small wallet uploads carry the newest list in the same quilt. */
  on: boolean;
  /** A copy has been written to the storage network at least once. */
  written: boolean;
}

/** The account as the recovery doors take it, with the code's proof for this one call. */
async function accountOf(held: Held): Promise<RecoveryAccount> {
  return {
    server: held.server,
    bearer: held.bearer,
    code: held.code,
    accountId: held.accountId,
    network: held.network,
    accountProof: (await registrationProofOf(held.code)).authSecret,
  };
}

/**
 * Build the recovery list and tell the server its number, as `nmts recovery-list` does.
 *
 * ⚠ KEEPING THE FILE IS THE CALLER'S. The server is told a list was kept here (`kind: local`), so
 *   the account screen counts it; where the bytes go is up to whoever called.
 */
export async function recoveryListOf(opened: Opened): Promise<RecoveryList> {
  return withAccount(opened, async (held) => {
    const account = await accountOf(held);
    const made = await makeRecoveryList(account);
    await recordRecoveryList(account, { seq: made.seq, capturedAt: made.capturedAt });
    return {
      filename: made.file.filename,
      content: made.file.content,
      seq: made.seq,
      files: made.built.fileCount,
      bytes: made.built.totalBytes,
      missing: made.built.missingFromSource,
    };
  });
}

/** Whether the copy is on, and whether one was ever written. */
export async function recoveryCopyOf(opened: Opened): Promise<RecoveryCopy> {
  return withAccount(opened, async (held) => {
    const state = await readRecoveryCopy(held);
    if (state === null) {
      throw new NmtsError("RECOVERY_COPY_UNREADABLE: this server cannot say yet whether the recovery list's storage copy is on.", {
        nextStep: "Nothing was changed. setRecoveryCopy(on) still works on this server.",
      });
    }
    return { on: state.enabled, written: state.written };
  });
}

/** Turn the copy on or off. It takes effect from the next upload. */
export async function setRecoveryCopyOf(opened: Opened, on: boolean): Promise<void> {
  await withAccount(opened, async (held) => setRecoveryCopy(await accountOf(held), on));
}
