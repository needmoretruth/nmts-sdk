// A delegation token given as a FUNCTION: asked before every request, so a client that outlives one
// token — a business keeps one per user for as long as its process runs — keeps working.
//
// ⛔ WHAT IS MEASURED IS THE HEADER THAT LEFT. Every request goes through the caller's `fetch`, so a
//    recorder there sees the token each request actually carried; a test that read the client's own
//    state back would only prove the client agrees with itself.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { forgetReach, useReach } from "@needmoretruth/nmts-cli/portable";

import { Nmts } from "../src/index.ts";
import { bytesSource, putSource } from "../src/put.ts";
import { deviceRoot } from "../src/root.ts";
import { openAccount } from "../src/session.ts";
import { apiThat, protocolThat, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => {
  forgetReach();
  return drive.close();
});

/** Every request's method, path and Authorization header, in the order they left. */
function recorder(): { seen: { what: string; auth: string | null }[]; fetch: typeof fetch } {
  const seen: { what: string; auth: string | null }[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      seen.push({ what: `${init?.method ?? "GET"} ${url.pathname}`, auth: headers.get("authorization") });
      return fetch(input, init);
    },
  };
}

test("⛔ a delegation source is asked before each request, so the next call carries the next token", async () => {
  await withSandbox(drive, "sdk-delegation-source-list", async (code) => {
    const { seen, fetch: recording } = recorder();
    let current = "token-one";
    let asked = 0;
    const nmts = Nmts.device({
      accountCode: code,
      delegation: () => {
        asked += 1;
        return current;
      },
      server: drive.base,
      network: "testnet",
      fetch: recording,
    });
    assert.equal(asked, 0, "the source was asked before anything needed a token");
    await nmts.list();
    const first = seen.length;
    assert.ok(first > 0);
    assert.ok(seen.every((r) => r.auth === "Bearer token-one"));

    current = "token-two";
    await nmts.list();
    assert.ok(seen.slice(first).length > 0);
    assert.ok(seen.slice(first).every((r) => r.auth === "Bearer token-two"), "a request went out under the old token");
    assert.equal(asked, seen.length, "the source was not asked once per request");
  });
});

test("⛔ an upload that outlives its token names the file under the token that is current then", async () => {
  await withSandbox(drive, "sdk-delegation-source-put", async (code) => {
    const { seen, fetch: recording } = recorder();
    useReach({ fetch: recording });
    let current = "token-before";
    const opened = openAccount(deviceRoot({ accountCode: code, delegation: async () => current }), {
      server: drive.base,
      network: "testnet",
    });
    const { api } = apiThat({
      // The storage is bought and committed; the token runs out before the list is written.
      async createItem() {
        current = "token-after";
        return { id: "item-1" };
      },
    });
    const rail = async () => ({ api, protocol: protocolThat(), relayUrl: "https://relay.example", currentEpoch: 40 });
    const result = await putSource(opened, bytesSource(new TextEncoder().encode("late")), "late.txt", {}, rail);
    assert.equal(result.id, "item-1");
    const writes = seen.filter((r) => r.what.startsWith("PUT ") || r.what.startsWith("POST "));
    assert.ok(writes.length > 0, "the list was never written");
    assert.ok(writes.every((r) => r.auth === "Bearer token-after"), "the list was written under the token that had run out");
    forgetReach();
  });
});

test("a source that fails, or answers nothing, is refused by name and nothing is sent", async () => {
  await withSandbox(drive, "sdk-delegation-source-refused", async (code) => {
    const { seen, fetch: recording } = recorder();
    const failing = Nmts.device({
      accountCode: code,
      delegation: async () => {
        throw new Error("the minting service is down");
      },
      server: drive.base,
      network: "testnet",
      fetch: recording,
    });
    await assert.rejects(failing.list(), /The delegation source failed: the minting service is down/);
    const empty = Nmts.device({ accountCode: code, delegation: () => " ", server: drive.base, network: "testnet", fetch: recording });
    await assert.rejects(empty.list(), /answered no token/);
    assert.equal(seen.length, 0, "a request left without a token");
  });
});
