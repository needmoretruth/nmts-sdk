// What this package's own Node-only modules may ask a client for, and callers may not.

import { NmtsError, type ReadOptions } from "@needmoretruth/nmts-cli/portable";

import type { Nmts } from "../nmts.ts";
import type { Opened } from "../session.ts";

/**
 * What this package's own Node-only modules need of a client, and callers do not.
 *
 * ⛔ A WEAK MAP RATHER THAN A METHOD ON THE CLASS. The gateway builds a drive out of a client, and
 *    to do that it needs the opened account — the root that holds the key and the credential every
 *    request carries. Put on `Nmts` that would be public surface in all but name: the README would
 *    have to explain it, `surface.test.ts` would list it, and the first program to reach for it
 *    would be reaching past the three verbs on purpose. Here it is reachable from the modules that
 *    import this file and from nowhere else, and it adds nothing a caller can see.
 */
export interface ClientInsides {
  /** The account this client speaks for, opened on first use and kept. */
  opened(): Opened;
  /** Which hosts stored bytes are read from, when the caller named any. */
  read(): ReadOptions | undefined;
}

const insides = new WeakMap<Nmts, ClientInsides>();

/** Said once, by the constructor, for the client it is building. */
export function rememberInsides(client: Nmts, of: ClientInsides): void {
  insides.set(client, of);
}

/** The insides of a client this package made. Anything else is a caller's own object. */
export function insidesOf(client: Nmts): ClientInsides {
  const found = insides.get(client);
  if (found === undefined) {
    throw new NmtsError("NOT_A_CLIENT: that is not an Nmts client this package made.", {
      exitCode: 2,
      nextStep: "Nothing was read or written. Hand the gateway what `Nmts.device()` or `Nmts.managed()` answered.",
    });
  }
  return found;
}
