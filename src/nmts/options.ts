// What a caller hands the client, what it gets back about the account, and the two seams those
// options reach the command-line package through.

import { host, NmtsError, useReach, type Network } from "@needmoretruth/nmts-cli/portable";

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
  /**
   * The Sui JSON-RPC endpoints this client asks, instead of the network's own: one, or a list
   * tried in order.
   *
   * ⛔ IT REPLACES THE LIST rather than adding to it, exactly as `aggregators` does — somebody who
   *    names a node is saying *those*, and reaching a public mirror as well would send their
   *    traffic somewhere they did not choose.
   */
  suiRpc?: string | readonly string[] | undefined;
  /**
   * The function every request this client makes goes through — the NMTS server, the storage
   * network's relay and aggregators, and the Sui nodes, including the requests the storage and
   * chain libraries make for themselves. Absent, the runtime's own `fetch`.
   *
   * This is where a proxy goes, and it is the whole of what one needs: an `undici` `ProxyAgent`,
   * a SOCKS tunnel, a recorder, a counter. Nothing about a proxy is built into this package.
   */
  fetch?: typeof fetch | undefined;
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
 * The fields that say where to talk and what to talk through, taken off a convenience maker's one
 * object.
 *
 * ⛔ SO THAT NO CREDENTIAL IS COPIED ONTO THE CLIENT. `Nmts.device({ accountCode, … })` takes one
 *    flat object because that is what is pleasant to write; what the client keeps out of it is
 *    these, and the code goes to the root and nowhere else.
 */
export function optionsOf(from: NmtsOptions): NmtsOptions {
  return {
    server: from.server,
    network: from.network,
    aggregators: from.aggregators,
    relay: from.relay,
    suiRpc: from.suiRpc,
    fetch: from.fetch,
    onProgress: from.onProgress,
    wasmUrl: from.wasmUrl,
  };
}

/** One host or several, as the one shape everything underneath reads. */
function suiRpcList(named: string | readonly string[] | undefined): readonly string[] | undefined {
  if (named === undefined) return undefined;
  const hosts = (typeof named === "string" ? [named] : named).map((h) => h.trim()).filter((h) => h !== "");
  return hosts.length === 0 ? undefined : hosts;
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
  const suiRpc = suiRpcList(options.suiRpc);
  // ⛔ WHERE THIS CLIENT TALKS AND WHAT IT TALKS THROUGH, TOLD TO THE PACKAGE THAT DOES THE
  //    TALKING. Until this existed, `relay` and `suiRpc` were read by the browser host alone and
  //    were silently ignored on Node — a caller who named a relay watched their bytes go to the
  //    public one. Every host reads these now, and `fetch` is the whole of what a proxy needs.
  useReach({
    relay: options.relay,
    suiRpc,
    aggregators: options.aggregators,
    fetch: options.fetch,
  });
  // ⛔ THE HOST IS THE RUNTIME'S AND THIS IS THE ONE SEAM TO IT. A host was registered when the
  //    entry point was imported, long before any client existed; these are the things only a
  //    caller knows, and the host reads them when it is asked to do the thing that needs them.
  //
  // ⚠ THE ADDRESSES ARE STILL WRITTEN HERE, because a page that builds its own `browserHost` and
  //   never makes a client reads them through this one; a client fills both, with the same values.
  useHostOptions({
    relay: options.relay,
    suiRpc: suiRpc?.[0],
    aggregators: options.aggregators,
    onProgress: options.onProgress,
    wasmUrl: options.wasmUrl,
  });
}

export interface GetOptions {
  /** How many bytes `get()` may hold in memory. Default 256 MiB. Over it, use `getTo()`. */
  maxBytes?: number | undefined;
  /** The video's preview picture instead of the video. A video without one is refused (exit 4). */
  thumbnail?: boolean | undefined;
}

export interface GetToOptions {
  /** Replace a file already at the destination. Off by default, and saying so is the point. */
  force?: boolean | undefined;
  /** The video's preview picture instead of the video. A video without one is refused (exit 4). */
  thumbnail?: boolean | undefined;
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
