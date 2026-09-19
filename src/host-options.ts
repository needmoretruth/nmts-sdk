// The client options a HOST needs, kept where both entry points can reach them.
//
// ⛔ THE HOST IS THE PAGE'S AND A CLIENT IS ONE ACCOUNT'S, so the two cannot be the same object.
//    `Nmts` is made with options; the host was registered when the entry point was imported, long
//    before. This is the one place between them: the client writes what the host needs, the host
//    reads it when it is asked to do the thing that needs it.
//
// ⛔ WHICH IS WHY A SECOND CLIENT WITH DIFFERENT ADDRESSES REPLACES THE FIRST'S. A page holds one
//    engine and talks to one storage network; two clients pointed at different relays would be two
//    answers to a question the runtime has only one of. Said here rather than discovered.
//
// ⚠ NO CREDENTIAL EVER GOES IN HERE. What a root holds is borrowed for one call and kept nowhere;
//   these are addresses and callbacks.

/** What a host may be asked for that only the caller knows. */
export interface HostOptions {
  /**
   * Where the engine's WebAssembly is, when a bundler put it somewhere the module cannot work out
   * for itself. Browser only — the Node host finds it in the installed package.
   */
  wasmUrl?: string | undefined;
  /** Where progress lines go. Absent, the Node host writes them to stderr and a browser says nothing. */
  onProgress?: ((line: string) => void) | undefined;
  /** The storage network's relay this page writes through, instead of the network's own. */
  relay?: string | undefined;
  /** The Sui JSON-RPC endpoint this page asks, instead of the network's own. */
  suiRpc?: string | undefined;
  /** Hosts to read stored bytes from, instead of the public aggregators for the network. */
  aggregators?: readonly string[] | undefined;
}

let current: HostOptions = {};

/** What the client has told the host. */
export function hostOptions(): HostOptions {
  return current;
}

/** Tell the host what this client knows. Values that are absent leave what was there. */
export function useHostOptions(next: HostOptions): void {
  const merged: HostOptions = { ...current };
  for (const key of Object.keys(next) as (keyof HostOptions)[]) {
    if (next[key] !== undefined) Reflect.set(merged, key, next[key]);
  }
  current = merged;
}

/** Start again with nothing. For tests. */
export function forgetHostOptions(): void {
  current = {};
}
