// Erasing files for good — the one verb in this package that nothing undoes.
//
// ⛔ WHY IT EXISTS AT ALL. `remove()` is the trash: the file stays, restorable, and goes on being
//    paid for. A business whose user says "erase my data" cannot honour that with a trash, and a
//    business that has to send the person somewhere else to do it has a reason to build on
//    something else. So the act is here, and what makes it safe is the SHAPE OF THE CALL rather
//    than the feature being missing.
//
// ⛔ THE SENTENCE IS IN THE CALL, AND THERE IS NO `true` THAT STANDS FOR IT. `confirm` must equal
//    `ERASE_CONFIRM` character for character, so the code that erases somebody's files SAYS SO
//    where it is written — a reviewer reading the diff sees the sentence, and `{ confirm: flag }`
//    computed somewhere else cannot arrive here by accident. Anything else refuses with
//    `ERASE_NOT_CONFIRMED` before a single request is sent.
//
// ⛔ THE ACT ITSELF IS THE COMMAND-LINE PACKAGE'S `drive-erase`, NOT A COPY OF IT. The order that
//    protects an account — the storage release first, the server's records next, the sealed list
//    last, and nothing erased behind a release that failed — is written once, over there, and
//    `nmts erase` and this are the same function with a different caller.
//
// ⛔ AND THE SERVER ASKS FOR THE ACCOUNT CODE'S OWN PROOF ON BOTH DOORS, whichever root holds the
//    key. A delegation token is its business's permission; the proof is an act only whoever holds
//    the code can perform, and this verb has the code in hand exactly as every other verb does.

import { erasePaths, type StorageRelease } from "@needmoretruth/nmts-cli/drive-erase";
import { NmtsError, registrationProofOf, type ListEditInput } from "@needmoretruth/nmts-cli/portable";

import { withAccount, type Held, type Opened } from "./session.ts";

/**
 * The sentence `erase()` takes, exactly.
 *
 * ⚠ IT IS THE COMMAND-LINE TOOL'S OWN, the one a person types at `nmts erase`. One sentence for
 *   both, so what a developer reads in this package is what their user will be asked to type.
 */
export const ERASE_CONFIRM = "I UNDERSTAND THIS IS PERMANENT";

/** What `erase()` takes. */
export interface EraseOptions {
  /**
   * `ERASE_CONFIRM`, character for character. There is no default and no boolean: the sentence is
   * how this call says out loud what it is about to do.
   */
  confirm: string;
  /**
   * Also destroy the storage bought with CREDITS under these files, on the chain, before erasing
   * them.
   *
   * ⚠ Off by default, and what it changes is money rather than secrecy: erased either way, the
   *   bytes are unreadable the moment their key is gone. Storage bought by the account's own
   *   wallet is never touched — nothing here can sign for that — and a file whose release the
   *   server refuses is erased anyway, with the refusal on its own line of `storage`.
   */
  releaseStorage?: boolean;
}

/** What happened to one file's storage. */
export interface EraseStorage {
  /** The file it is about, as the path named it. */
  path: string;
  /** True when the treasury's storage under it was destroyed on the chain. */
  released: boolean;
  /** Why not, when it was not — the server's own sentence. Absent when it was. */
  reason?: string;
}

/** What one erase did. */
export interface EraseResult {
  /** The paths erased, in the order the call named them. Folders are not here — their files are. */
  erased: string[];
  /**
   * One line per file whose storage was asked about. Empty unless `releaseStorage` was asked for.
   */
  storage: EraseStorage[];
}

/**
 * Erase files for good: the server's record of each one, this account's key to it, and its entry
 * in the sealed list. A folder erases every file under it.
 *
 * ⛔ NOTHING HERE CAN BE UNDONE, by this package or by us.
 */
export async function eraseForGood(
  opened: Opened,
  paths: string | readonly string[],
  options: EraseOptions,
): Promise<EraseResult> {
  // ⛔ BEFORE THE ACCOUNT IS EVEN OPENED. A wrong sentence must cost nothing at all — no request,
  //    no borrowed code, no store opened — so that a program that got this wrong learns it on the
  //    call rather than half way through an erase.
  if (options.confirm !== ERASE_CONFIRM) {
    throw new NmtsError(`ERASE_NOT_CONFIRMED: erase() takes \`confirm: "${ERASE_CONFIRM}"\`, exactly.`, {
      exitCode: 2,
      nextStep:
        "Nothing was sent and nothing was erased. Write the sentence in the call — " +
        "`erase(paths, { confirm: ERASE_CONFIRM })` — so the code that erases files says so.",
    });
  }
  const many = typeof paths === "string" ? [paths] : paths;
  return withAccount(opened, async (held) => {
    const outcome = await erasePaths(
      { ...editing(held), accountProof: await proofOf(held) },
      many,
      { releaseStorage: options.releaseStorage === true },
    );
    return {
      erased: outcome.files.map((f) => f.path),
      storage: outcome.releases.map(oneStorage),
    };
  });
}

/** What the erasing underneath takes: where to talk, what opens the list, and whose list it is. */
function editing(held: Held): ListEditInput {
  return { server: held.server, apiKey: held.bearer, code: held.code, accountId: held.accountId };
}

/**
 * The account code's proof for this one run.
 *
 * ⚠ `registrationProofOf` IS WHERE THIS VALUE IS DERIVED, and it is not only about registering:
 *   `authSecret` is the 32 bytes every sign-in sends and the same bytes the proof header carries.
 *   Deriving it a second time here would be a second implementation of one slice of NCF-3 §1.
 */
async function proofOf(held: Held): Promise<string> {
  return (await registrationProofOf(held.code)).authSecret;
}

/** One release, as a caller reads it: it happened, or it did not and here is why. */
function oneStorage(release: StorageRelease): EraseStorage {
  if (release.refused !== null) return { path: release.path, released: false, reason: release.refused };
  if (release.failed > 0) {
    return {
      path: release.path,
      released: release.released > 0,
      reason: `${release.failed} of this file's blobs could not be destroyed — those bytes are still being served.`,
    };
  }
  return { path: release.path, released: true };
}
