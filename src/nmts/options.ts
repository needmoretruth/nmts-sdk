// What a caller hands the client, what it gets back about the account, and the one seam those
// options reach the runtime's host through.

import { host, NmtsError, type Network } from "@needmoretruth/nmts-cli/portable";

import { useHostOptions } from "../host-options.ts";
import type { ServerOptions } from "../session.ts";

export interface NmtsOptions extends ServerOptions {
  /**
   * Hosts to read stored bytes from, instead of the public aggregators for the network. For a
   * development stack, or an aggregator you run yourself.
   */
  aggregators?: readonly string[] | undefined;
  /**
   * The storage network's relay this client writes through, instead of the network's own.
   *
   * ⚠ ONE host, not a list: unlike reads there is nothing to fail over to.
   */
  relay?: string | undefined;
  /** The Sui JSON-RPC endpoint this client asks, instead of the network's own. */
  suiRpc?: string | undefined;
  /**
   * Told each progress line the work produces. Absent, the command-line package's Node host writes
   * them to stderr and a page says nothing.
   */
  onProgress?: ((line: string) => void) | undefined;
  /**
   * BROWSER ENTRY ONLY: where the engine's WebAssembly is, when a bundler put it somewhere the
   * module cannot work out for itself. On Node it is refused rather than ignored — the engine
   * there comes out of the installed package, so a caller who set this did not get what they asked
   * for.
   */
  wasmUrl?: string | undefined;
}

/**
 * The three fields that say where to talk, taken off a convenience maker's one object.
 *
 * ⛔ SO THAT NO CREDENTIAL IS COPIED ONTO THE CLIENT. `Nmts.device({ accountCode, … })` takes one
 *    flat object because that is what is pleasant to write; what the client keeps out of it is
 *    these three, and the code goes to the root and nowhere else.
 */
export function optionsOf(from: NmtsOptions): NmtsOptions {
  return {
    server: from.server,
    network: from.network,
    aggregators: from.aggregators,
    relay: from.relay,
    suiRpc: from.suiRpc,
    onProgress: from.onProgress,
    wasmUrl: from.wasmUrl,
  };
}

/** What the constructor does with the options it was handed, and the only thing it does with them. */
export function useOptions(options: NmtsOptions): void {
  // ⛔ AN OPTION THAT WOULD BE IGNORED IS A REFUSAL, not a shrug. The Node host finds the engine
  //    in the installed package, so a caller who named a URL for it was writing for the browser
  //    entry and is running on the other one.
  if (options.wasmUrl !== undefined && host().name !== "browser") {
    throw new NmtsError("OPTION_NODE_IGNORED: `wasmUrl` only applies to the browser entry point.", {
      exitCode: 2,
      nextStep:
        "Nothing was read or written. Import `@needmoretruth/nmts-sdk/browser` to use it, or drop " +
        "it — on Node the engine comes out of the installed command-line package.",
    });
  }
  // ⛔ THE HOST IS THE RUNTIME'S AND THIS IS THE ONE SEAM TO IT. A host was registered when the
  //    entry point was imported, long before any client existed; these are the things only a
  //    caller knows, and the host reads them when it is asked to do the thing that needs them.
  useHostOptions({
    relay: options.relay,
    suiRpc: options.suiRpc,
    aggregators: options.aggregators,
    onProgress: options.onProgress,
    wasmUrl: options.wasmUrl,
  });
}

export interface GetOptions {
  /** How many bytes `get()` may hold in memory. Default 256 MiB. Over it, use `getTo()`. */
  maxBytes?: number | undefined;
}

export interface GetToOptions {
  /** Replace a file already at the destination. Off by default, and saying so is the point. */
  force?: boolean | undefined;
}

export interface WalletAddressOptions {
  /** Which of this key's wallets. Absent = the one the account pays from. */
  index?: number | undefined;
}

export interface AccountInfo {
  /** The account's public id — what the server knows it by. Not a secret. */
  accountId: string;
  server: string;
  network: Network;
}
