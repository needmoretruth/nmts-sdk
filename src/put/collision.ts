// What `put({ onCollision })` tells the file list, for both rails.
//
// ⛔ IT IS THE CALLING PROGRAM'S CHOICE AND IS SENT AS ONE. The command-line package holds an agent
//    at a command line to its autonomy modes before it may overwrite; a program that wrote
//    `onCollision: "overwrite"` into its own call is not that agent, and calling `put` is its
//    decision exactly as it is its agreement to spend. So the word goes down as a program's
//    choice, which the file list takes as given — and only for this one upload.

import { NmtsError, type AddEntryInput } from "@needmoretruth/nmts-cli/portable";

/** What a name already in use in that folder does to this one upload. */
export type OnCollision = "rename" | "overwrite";

/**
 * `onCollision` as the file list is told it, or nothing when the caller said nothing — which
 * leaves it to this machine's `nmts on-collision` setting, as before there was a choice.
 *
 * ⛔ A WORD THAT IS NEITHER IS REFUSED, before anything is opened. Read as "rename" it would look
 *    like it worked; read as "overwrite" it would trash a file nobody chose to replace.
 */
export function collisionOf(asked: OnCollision | undefined): Pick<AddEntryInput, "onCollision"> {
  if (asked === undefined) return {};
  if (asked === "rename" || asked === "overwrite") return { onCollision: { choice: asked, by: "program" } };
  throw new NmtsError(`\`onCollision\` is "rename" or "overwrite", not ${JSON.stringify(asked)}.`, {
    exitCode: 2,
    nextStep: "Nothing was sent and nothing was charged. Leave it out to follow this machine's setting.",
  });
}
