// The three things this package can only do where there are files, and the one register that
// holds them.
//
// ⛔ A REGISTER, NOT A BRANCH, for the same reason the command-line package's host is one: the
//    modules that need these run in both runtimes and must not each decide which they are in.
//    The Node entry point fills this in on the way past; the browser entry does not, and the
//    three verbs that would have used it refuse by name instead of failing somewhere deeper.
//
// ⛔ AND IT IS WHAT KEEPS `node:fs` OUT OF A PAGE'S BUNDLE. `nmts.ts`, `get.ts` and `env.ts` are
//    imported by both entry points; a plain import of a path reader in any of them would drag
//    Node's filesystem into every bundle built from `/browser`, where it cannot be resolved at all.

import { NmtsError, type PlaintextSink, type PlaintextSource } from "@needmoretruth/nmts-cli/portable";

// Type only, so nothing of `env.ts` — and nothing of Node's filesystem behind it — is loaded here.
import type { FromEnvironment } from "./env.ts";

/** Everything that needs a filesystem, in one object so a runtime supplies all of it or none. */
export interface NodeSeams {
  /** A file on this machine, read a chunk at a time. Its size is measured here too. */
  source(path: string): PlaintextSource;
  /** A file on this machine, written through a temporary name and made visible once proved. */
  sink(destination: string, options: { force: boolean }): PlaintextSink;
  /** The credentials the environment holds, including the files its variables name. */
  environment(): FromEnvironment;
}

let seams: NodeSeams | null = null;

/** Called once, by the Node entry point, before anything a caller holds exists. */
export function useNodeSeams(next: NodeSeams): void {
  seams = next;
}

/** Empty the register. For tests that need to see what the browser entry does. */
export function forgetNodeSeams(): void {
  seams = null;
}

/**
 * The seams, or the refusal that names what to do instead.
 *
 * `code` is the sentence's own identifier — a caller reading a log should be able to tell the
 * three apart without parsing English.
 */
export function nodeSeams(code: string, nextStep: string): NodeSeams {
  if (seams === null) throw new NmtsError(`${code}: this runtime has no files.`, { exitCode: 2, nextStep });
  return seams;
}
