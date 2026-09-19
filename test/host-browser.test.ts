// The browser host sits the same contract the Node host sits, and says so when it cannot.
//
// ⛔ THE CONTRACT IS THE COMMAND-LINE PACKAGE'S OWN FUNCTION, run here over IndexedDB. Two tests
//    written separately would drift, and the way that drift shows up is a half-finished upload
//    that resumes on a laptop and starts again in a page — same account, same file, two answers.
//
// ⛔ AND THE FALLBACK IS TESTED, NOT ASSUMED. A private window, blocked site data and a worker
//    without storage are ordinary; what must not happen is an upload that fails because of one.
//    The store degrades to memory and `durable` turns false, which is the sentence a caller can
//    put in front of a person before they start a large upload.
//
// ⚠ `fake-indexeddb` IS THE BROWSER'S OWN API, NOT A STUB OF OURS. It implements the specification
//   this module was written against, so what passes here is the transaction behaviour a page has.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import "fake-indexeddb/auto";

import { hostContract, zstdCodec } from "@needmoretruth/nmts-cli/portable";
import {
  AGGREGATOR_ENV_VAR,
  RELAY_ENV_VAR,
  SERVER_ENV_VAR,
  SUI_RPC_ENV_VAR,
} from "@needmoretruth/nmts-cli/portable";

import { browserHost, forgetBrowserZstd } from "../src/host-browser.ts";
import { forgetHostOptions } from "../src/host-options.ts";
import { idbState } from "../src/state-idb.ts";
import { memoryState } from "../src/state-memory.ts";

/** Run `body` in a runtime with no IndexedDB, and give it back afterwards. */
async function withoutIndexedDb(body: () => Promise<void>): Promise<void> {
  const had = Reflect.get(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "indexedDB");
  try {
    await body();
  } finally {
    Reflect.set(globalThis, "indexedDB", had);
  }
}

test("the browser host keeps state the way every caller in the package expects", async () => {
  forgetHostOptions();
  assert.deepEqual(await hostContract(browserHost({}, idbState())), []);
});

test("the memory store keeps it too — it is what both hosts' tests fall back to", async () => {
  assert.deepEqual(await hostContract(browserHost({}, memoryState())), []);
});

test("⛔ what IndexedDB holds survives a new store: this is the resume an upload depends on", async () => {
  const first = idbState();
  await first.write("uploads/keep.bin", new Uint8Array([7, 7, 7]));
  assert.equal(first.durable, true);
  const second = idbState();
  assert.deepEqual([...(await second.read("uploads/keep.bin")) ?? []], [7, 7, 7]);
  assert.deepEqual(await second.keys("uploads/"), ["uploads/keep.bin"]);
  await second.remove("uploads/keep.bin");
});

test("⛔ no IndexedDB is a slower page, not a broken one — and `durable` says which it was", async () => {
  await withoutIndexedDb(async () => {
    const state = idbState();
    await state.write("manifest/acc", new Uint8Array([1, 2]));
    assert.deepEqual([...(await state.read("manifest/acc")) ?? []], [1, 2]);
    assert.equal(state.durable, false, "a page with no store called itself durable");
    assert.deepEqual(await hostContract(browserHost({}, state)), []);
  });
});

test("a page has no environment: the addresses come from the client's options and nothing else", () => {
  forgetHostOptions();
  const host = browserHost(
    { relay: "https://relay.example", suiRpc: "https://rpc.example", aggregators: ["https://a.example"] },
    memoryState(),
  );
  assert.equal(host.name, "browser");
  assert.equal(host.env(RELAY_ENV_VAR), "https://relay.example");
  assert.equal(host.env(SUI_RPC_ENV_VAR), "https://rpc.example");
  assert.equal(host.env(AGGREGATOR_ENV_VAR), "https://a.example");
  // ⛔ EVERYTHING ELSE IS UNDEFINED, including the server: where an account talks is an option on
  //    the client, not something a page could have been told by a variable.
  assert.equal(host.env(SERVER_ENV_VAR), undefined);
  assert.deepEqual(host.envEntries(), []);
});

test("progress lines go where the caller asked, and nowhere when nobody asked", () => {
  forgetHostOptions();
  const said: string[] = [];
  browserHost({ onProgress: (line) => said.push(line) }, memoryState()).log("half way");
  assert.deepEqual(said, ["half way"]);
  forgetHostOptions();
  browserHost({}, memoryState()).log("nobody is listening");
  assert.deepEqual(said, ["half way"]);
});

test("⛔ the zstd register is filled with a real encoder, so a page reads what the browser wrote", async () => {
  forgetBrowserZstd();
  assert.equal(zstdCodec(), null, "something had already filled the register");
  await browserHost({}, memoryState()).zstd.register();
  const codec = zstdCodec();
  assert.ok(codec !== null, "the register is still empty after the host filled it");
  assert.equal(typeof codec.compress, "function");
  assert.equal(typeof codec.decompress, "function");
  // The round trip is the thing that matters: a register holding two functions that do not agree
  // would pass the check above and lose a file list.
  const plain = new TextEncoder().encode("a file list, several times over. ".repeat(40));
  const packed = await codec.compress(plain, 6);
  assert.ok(packed.length < plain.length, "the encoder did not compress");
  assert.deepEqual([...(await codec.decompress(packed, 1 << 20))], [...plain]);
});
