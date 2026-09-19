// The browser host: the same five things the Node host answers, answered the way a page can.
//
// ⛔ THE ENGINE IS THE SAME BUILD. `@needmoretruth/nmts-cli/vendor/nmts-crypto/*` is the
//    WebAssembly the command-line tool loads off a disk and the browser app fetches over the
//    network — one crate, one set of derivations. A second implementation of NCF-3 for pages is
//    the one thing this package will not have.
//
// ⛔ STATE IS THE BROWSER'S STORE, AND IT DEGRADES OUT LOUD. `state-idb.ts` falls back to memory
//    when IndexedDB is missing or will not open, and `durable` says which it ended up as.
//
// ⛔ THERE IS NO ENVIRONMENT IN A PAGE. Every address the command-line tool would take from a
//    variable is a `Nmts` option here, and this host is where those options are answered — under
//    the same names, so the module that asks has one way of asking wherever it runs.

import {
  AGGREGATOR_ENV_VAR,
  isCryptoGlue,
  missingExports,
  NmtsError,
  RELAY_ENV_VAR,
  setZstdCodec,
  SUI_RPC_ENV_VAR,
  zstdContentSize,
  type CryptoGlue,
  type Host,
  type StateHost,
  type ZstdCodec,
} from "@needmoretruth/nmts-cli/portable";

import { hostOptions, useHostOptions, type HostOptions } from "./host-options.ts";
import { idbState } from "./state-idb.ts";

/** Where the engine's WebAssembly sits beside this module, unless a bundler put it somewhere else. */
function wasmUrl(): string {
  return hostOptions().wasmUrl ?? new URL("nmts_crypto_wasm_bg.wasm", import.meta.url).href;
}

let engine: CryptoGlue | null = null;

/**
 * Load the engine once per page.
 *
 * ⛔ NO TYPE ASSERTION. What comes back from a dynamic import is `unknown`, and `crypto-surface.ts`
 *    is what narrows it — the same gate the Node load passes, so a build that renamed an export is
 *    named at load time in both runtimes rather than as "undefined is not a function" somewhere
 *    inside a derivation.
 */
async function loadEngine(): Promise<CryptoGlue> {
  if (engine !== null) return engine;
  if (typeof WebAssembly === "undefined") {
    throw new NmtsError("WASM_UNAVAILABLE: this runtime has no WebAssembly.", {
      exitCode: 1,
      nextStep:
        "Nothing was read or written. Every key this account has is derived by a WebAssembly " +
        "engine, so there is nothing this package can do without one.",
    });
  }
  // ⛔ A LITERAL SPECIFIER, so a bundler follows it and puts the glue in the page's bundle. It is
  //    the same build the Node host loads off a disk; `web-globals.d.ts` declares its shape,
  //    because the file ships inside the installed command-line package rather than in this tree.
  const module: unknown = await import("@needmoretruth/nmts-cli/vendor/nmts-crypto/nmts_crypto_wasm.js");
  const init: unknown = Reflect.get(Object(module), "default");
  if (typeof init !== "function") {
    throw new NmtsError("The NMTS crypto engine did not load (initialiser is not callable).", { exitCode: 1 });
  }
  await init({ module_or_path: wasmUrl() });
  if (!isCryptoGlue(module)) {
    throw new NmtsError(
      `The NMTS crypto engine is missing: ${missingExports(module).join(", ")}. This build does not match this package.`,
      { exitCode: 1, nextStep: "Reinstall @needmoretruth/nmts-cli, and serve its wasm file with your bundle." },
    );
  }
  engine = module;
  return module;
}

/** For tests that need a fresh load. */
export function forgetBrowserEngine(): void {
  engine = null;
}

/** The zstd encoder a page fetches, filled into the file-list codec's register (NCF-3 §6.3.4). */
let zstdRegistered = false;

async function registerBrowserZstd(): Promise<void> {
  if (zstdRegistered) return;
  const wasm: unknown = await import("@bokuweb/zstd-wasm");
  const init: unknown = Reflect.get(Object(wasm), "init");
  const compress: unknown = Reflect.get(Object(wasm), "compress");
  const decompress: unknown = Reflect.get(Object(wasm), "decompress");
  if (typeof init !== "function" || typeof compress !== "function" || typeof decompress !== "function") {
    throw new NmtsError("The zstd build this page loaded is not the one this package expects.", {
      nextStep: "Nothing was written. Reinstall @bokuweb/zstd-wasm, or serve its wasm file beside the bundle.",
    });
  }
  await init();
  const codec: ZstdCodec = {
    async compress(bytes: Uint8Array, level: number): Promise<Uint8Array> {
      return new Uint8Array(await compress(bytes, level));
    },
    async decompress(bytes: Uint8Array, maxOut: number): Promise<Uint8Array> {
      // The frame's own claim is read first — the same bound the Node encoder checks, and for the
      // same reason: a buffer must not be sized from a number the frame supplied about itself.
      const declared = zstdContentSize(bytes);
      if (declared === null) throw new Error("This part of the file list does not say how large it expands to.");
      if (declared > maxOut) {
        throw new Error(`This part of the file list claims ${declared} bytes, over the ${maxOut} allowed.`);
      }
      const out = new Uint8Array(await decompress(bytes));
      if (out.length > maxOut) throw new Error(`This part of the file list expanded past the ${maxOut} allowed.`);
      return out;
    },
  };
  zstdRegistered = true;
  setZstdCodec(codec);
}

/** For tests that need this page to look like one with no encoder yet. */
export function forgetBrowserZstd(): void {
  zstdRegistered = false;
  setZstdCodec(null);
}

/** The addresses a page cannot take from an environment, under the names the modules ask for. */
function fromOptions(name: string): string | undefined {
  const options = hostOptions();
  if (name === RELAY_ENV_VAR) return options.relay;
  if (name === SUI_RPC_ENV_VAR) return options.suiRpc;
  const hosts = options.aggregators;
  if (name === AGGREGATOR_ENV_VAR) return hosts === undefined || hosts.length === 0 ? undefined : hosts.join(",");
  return undefined;
}

/**
 * This page, as the package's host.
 *
 * `state` is handed in by the tests, which run the same contract over a memory store.
 */
export function browserHost(options: HostOptions = {}, state: StateHost = idbState()): Host {
  useHostOptions(options);
  return {
    name: "browser",
    engine: { load: loadEngine },
    state,
    env: fromOptions,
    // A page holds no environment, so there is nothing of that kind to take out of a report.
    envEntries: () => [],
    log: (line: string): void => hostOptions().onProgress?.(line),
    zstd: { register: registerBrowserZstd },
  };
}
