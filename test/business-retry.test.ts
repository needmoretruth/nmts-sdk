// A signed read that failed on the way is signed again before it is repeated (2026-09-24).
//
// ⛔ THE SERVER HERE KEEPS EVERY BEARER IT HAS SEEN AND REFUSES A SECOND COPY 409, whatever it
//    answered the first — the strictest reading of «a signature is good once». The real server
//    spends a signature on every answer after the business's budget, so a 5xx or an answer lost on
//    the way leaves the retry's bearer already spent. `request`'s own retry sent the same bearer
//    again; every test below fails on a client that does.

import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";

import { generateBusinessKeys, NmtsError, toBase64Url } from "@needmoretruth/nmts-cli/portable";

import { Nmts } from "../src/index.ts";

const KEYS = generateBusinessKeys();
const BUSINESS_ID = toBase64Url(new Uint8Array(16).fill(11));

/** What the server answers before it answers properly, one status per request, in order. */
let failures: number[] = [];
/** Every bearer that arrived, in order. */
let bearers: string[] = [];
let calls: string[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const bearer = req.headers.authorization ?? "";
    const seenBefore = bearers.includes(bearer);
    bearers.push(bearer);
    calls.push(`${req.method} ${req.url}`);
    const status = seenBefore ? 409 : (failures.shift() ?? 200);
    const answer =
      status === 200
        ? req.url === "/p1/usage"
          ? { usage: { members: 2, users_today: 0, users_day_cap: 1000, files: 3, stored_bytes: 96, as_of: "2026-09-24T00:00:00Z" } }
          : { account: { account_id: BUSINESS_ID, created_at: "2026-09-24T00:00:00Z", status: "active" } }
        : { error: { code: status === 409 ? "BUSINESS_REQUEST_REPLAYED" : `FAILED_${status}`, message: `answered ${status}` } };
    res.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("the test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});
after(() => server.close());
beforeEach(() => {
  failures = [];
  bearers = [];
  calls = [];
});

function business(): ReturnType<typeof Nmts.business> {
  return Nmts.business({ accountId: BUSINESS_ID, privateKey: KEYS.privateKey, server: base });
}

test("⛔ a read refused 429 is answered on the retry, which carries a signature of its own", async () => {
  failures = [429];
  const usage = await business().usage();
  assert.equal(usage.storedBytes, 96);
  assert.equal(bearers.length, 2, "the 429 was not retried");
  assert.notEqual(bearers[0], bearers[1], "the retry sent the refused request's signature again");
});

test("⛔ a retry after a 5xx is not refused as a replay", async () => {
  failures = [503, 500];
  const usage = await business().usage();
  assert.equal(usage.files, 3);
  assert.equal(new Set(bearers).size, 3, `a signature was sent twice: ${calls.join(", ")}`);
});

test("a write is still sent once: a 5xx on registering a user is not repeated", async () => {
  failures = [503];
  await assert.rejects(business().registerUser(), (error: unknown) => {
    assert.ok(error instanceof NmtsError);
    return true;
  });
  assert.deepEqual(calls, ["POST /p1/users"], "a registration that may have landed was sent again");
});
