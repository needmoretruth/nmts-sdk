// Where a client talks, and what it talks through: the two options that were ignored on Node, and
// the one function every request has to go through.
//
// ⛔ THE FIRST TEST IS ON NODE ON PURPOSE. `relay` and `suiRpc` were answered by the browser host
//    alone, so a caller on a server named a relay and watched the bytes go to the public one —
//    with nothing said. An option that is passed is honoured on every host or refused by name.
//
// ⛔ THE PROXY TEST TAKES THE GLOBAL `fetch` AWAY. A proxy that most requests go through is not a
//    proxy: one request that reached round it is the one that says where this account is. So the
//    runtime's own `fetch` is replaced by a function that throws and names the address it was
//    handed, and a whole lap is run — anything that leaked fails the test and says what leaked.
//
// ⚠ THESE DO NOT WALK EVERY ROOT. What is judged here is the wire, which is the same wire whoever
//   holds the key; the verbs themselves are walked through every root by their own tests.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { createBlobProtocol, forgetReach, relayHost, suiRpcHosts } from "@needmoretruth/nmts-cli/portable";

import { Nmts, NmtsError } from "../src/index.ts";
import { bytesSource, putSource } from "../src/put.ts";
import { putSourceWithWallet } from "../src/put-wallet.ts";
import { openAccount } from "../src/session.ts";
import { deviceRoot } from "../src/root.ts";
import {
  apiThat,
  entry,
  KEY,
  partsOf,
  protocolThat,
  sealFile,
  startFakeAggregator,
  startFakeDrive,
  testWallet,
  walletSeams,
  withSandbox,
  type FakeAggregator,
  type FakeDrive,
} from "./helpers.ts";
// Registers the Node host, with its state in memory, for every test in this file.
import "./roots.ts";

let drive: FakeDrive;
let aggregator: FakeAggregator;
before(async () => {
  drive = await startFakeDrive();
  aggregator = await startFakeAggregator();
});
after(() => {
  drive.close();
  aggregator.close();
});

const ITEM = "99999999-8888-7777-6666-555555555555";

/** The address a `fetch` was handed, whichever of its three shapes it arrived in. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A client that needs no account: what these tests ask is where it WOULD talk. */
function clientWith(options: Parameters<typeof Nmts.device>[0]): Nmts {
  return Nmts.device(options);
}

test("⛔ relay and suiRpc are honoured on Node, not only in a page", () => {
  forgetReach();
  // What the network's own hosts are, so that what follows is visibly a change and not a default.
  assert.equal(relayHost("testnet"), "https://upload-relay.testnet.walrus.space");
  assert.deepEqual([...suiRpcHosts("testnet")], [
    "https://sui-testnet-rpc.publicnode.com",
    "https://testnet.suiet.app",
  ]);
  clientWith({
    accountCode: "not-used-here",
    apiKey: KEY,
    server: "https://server.example",
    network: "testnet",
    relay: "https://relay.example",
    suiRpc: ["https://rpc-one.example", "https://rpc-two.example"],
  });
  assert.equal(relayHost("testnet"), "https://relay.example", "the relay option was ignored on Node");
  assert.deepEqual(
    [...suiRpcHosts("testnet")],
    ["https://rpc-one.example", "https://rpc-two.example"],
    "the suiRpc option was ignored on Node, or it did not take a list",
  );
  forgetReach();
});

test("suiRpc takes one host as well as a list, and replaces the network's own either way", () => {
  forgetReach();
  clientWith({ accountCode: "not-used-here", apiKey: KEY, network: "testnet", suiRpc: "https://only.example" });
  assert.deepEqual([...suiRpcHosts("testnet")], ["https://only.example"]);
  forgetReach();
});

test("⛔ every request goes through the fetch the caller passed — put, get, list and a wallet quote", async () => {
  await withSandbox(drive, "sdk-reach-lap", async (code) => {
    const plaintext = new Uint8Array(4000).map((_, i) => (i * 11) % 251);
    const sealed = await sealFile(code, [plaintext]);
    await drive.serve(code, [
      entry({
        id: ITEM,
        name: "notes.bin",
        size: plaintext.length,
        dekWrapped: sealed.dekWrapped,
        contentHashCt: sealed.contentHashCt,
      }),
    ]);
    drive.parts.set(ITEM, partsOf(sealed, plaintext.length));
    aggregator.blobs.clear();
    for (const p of sealed.parts) aggregator.blobs.set(p.blobId, p.sealed);

    forgetReach();
    const real = globalThis.fetch;
    const asked: string[] = [];
    const through: typeof fetch = (input, init) => {
      asked.push(urlOf(input));
      return real(input, init);
    };
    // ⛔ THE RUNTIME'S OWN `fetch` IS GONE for the length of the lap, and what is in its place
    //    names the address it was asked for. Nothing below may reach it.
    Reflect.set(globalThis, "fetch", (input: Parameters<typeof fetch>[0]): never => {
      throw new Error(`the global fetch was used for ${urlOf(input)}`);
    });
    try {
      const credentials = { accountCode: code, apiKey: KEY };
      const where = { server: drive.base, network: "testnet", aggregators: [aggregator.base], fetch: through };
      const client = Nmts.device({ ...credentials, ...where });
      const opened = openAccount(deviceRoot(credentials), where);

      assert.deepEqual((await client.list()).map((e) => e.path), ["notes.bin"]);
      assert.deepEqual(await client.get("notes.bin"), plaintext);
      const put = await putSource(opened, bytesSource(new Uint8Array([1, 2, 3])), "new.txt", {}, async () => ({
        api: apiThat().api,
        protocol: protocolThat(),
        relayUrl: "https://relay.example",
        currentEpoch: 40,
      }));
      assert.equal(put.path, "new.txt");
      const quote = await putSourceWithWallet(
        opened,
        bytesSource(new Uint8Array([4, 5, 6])),
        "quoted.txt",
        { pay: "wallet", dryRun: true },
        walletSeams().seams,
      );
      assert.equal(quote.dryRun, true);
    } finally {
      Reflect.set(globalThis, "fetch", real);
      forgetReach();
    }
    // The lap is only a proof if it made requests: an empty list would pass every assertion above.
    assert.ok(asked.length >= 4, `only ${asked.length} requests went through the caller's fetch`);
    assert.ok(
      asked.some((u) => u.startsWith(aggregator.base)),
      "the stored bytes were read without going through the caller's fetch",
    );
  });
});

test("⛔ signing in with a wallet asks through the caller's fetch from its first request", async () => {
  // Found by signing in through Tor (2026-09-20): `fromWallet` looked the slot up BEFORE the
  // options were applied, so that one request went round the proxy.
  forgetReach();
  const real = globalThis.fetch;
  const asked: string[] = [];
  Reflect.set(globalThis, "fetch", (input: Parameters<typeof fetch>[0]): never => {
    throw new Error(`the global fetch was used for ${urlOf(input)}`);
  });
  try {
    await assert.rejects(
      Nmts.fromWallet({
        ...testWallet(),
        apiKey: KEY,
        server: drive.base,
        network: "testnet",
        fetch: (input, init) => {
          asked.push(urlOf(input));
          return real(input, init);
        },
      }),
      (error: unknown) => error instanceof NmtsError && /NO_OPENER_FOR_WALLET/.test(error.message),
    );
    assert.ok(asked.some((url) => url.includes("/v1/opener/")), `the slot was not asked for through it: ${asked.join(", ")}`);
  } finally {
    Reflect.set(globalThis, "fetch", real);
    forgetReach();
  }
});

test("⛔ the Sui nodes and the relay are the caller's too, libraries and all", async () => {
  forgetReach();
  const asked: string[] = [];
  clientWith({
    accountCode: "not-used-here",
    apiKey: KEY,
    network: "testnet",
    relay: "https://relay.example",
    suiRpc: ["https://rpc-one.example"],
    fetch: (input) => {
      asked.push(urlOf(input));
      // Named so that a request answered by the runtime's own `fetch` instead is a different
      // failure with a different message, rather than a test that passes for the wrong reason.
      throw new Error("ONLY_THE_CALLERS_FETCH");
    },
  });
  try {
    const protocol = createBlobProtocol("testnet", 4096);
    assert.equal(protocol.relayUrl, "https://relay.example", "the relay the writer bound itself to");
    await assert.rejects(protocol.computeMetadata({ bytes: new Uint8Array(4096) }), /ONLY_THE_CALLERS_FETCH/);
    assert.ok(
      asked.some((u) => u.startsWith("https://rpc-one.example")),
      `the chain library asked ${asked.join(", ") || "nothing"} rather than the node the caller named`,
    );
  } finally {
    forgetReach();
  }
});
