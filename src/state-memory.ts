// State that lives only as long as the page or the process does.
//
// ⛔ IT IS A REAL ANSWER, NOT A STUB. A browser that will not open a database still has to be able
//    to upload a file: everything the store holds — a kept file list, a chunk of one, a
//    reservation a resume would use — is an optimisation over asking the server again. What is
//    lost when this is what is holding them is that a reload starts over, and `durable` says so
//    rather than leaving a caller to find out.
//
// ⛔ IT COPIES ON THE WAY IN AND ON THE WAY OUT. Every caller in the package treats what it reads
//    as its own — some of them zero it — and a map handing back the same array twice would let one
//    caller's wipe empty another's record.

import type { StateHost } from "@needmoretruth/nmts-cli/portable";

/** A store in memory. Also what both hosts' tests run the contract against. */
export function memoryState(): StateHost {
  const held = new Map<string, Uint8Array>();
  return {
    durable: false,
    async read(key: string): Promise<Uint8Array | undefined> {
      const bytes = held.get(key);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
    async write(key: string, bytes: Uint8Array): Promise<void> {
      held.set(key, new Uint8Array(bytes));
    },
    async remove(key: string): Promise<void> {
      held.delete(key);
    },
    async keys(prefix: string): Promise<string[]> {
      return [...held.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}
