// A request made through the SDK says so: `x-nmts-client: sdk/<the SDK's version>`, which is what
// the public stats page counts as SDK use. Without it the server would count the request under the
// command line, whose package the SDK drives.
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

import { CLIENT_HEADER, clientHeaderValue } from "@needmoretruth/nmts-cli/portable";

import { Nmts } from "../src/index.ts";
import { deviceRoot } from "../src/root.ts";
import { VERSION } from "../src/product.ts";
import { generateCode, KEY } from "./helpers.ts";

const said: (string | undefined)[] = [];
const fake: Server = createServer((req, res) => {
  const v = req.headers[CLIENT_HEADER];
  said.push(Array.isArray(v) ? v.join(",") : v);
  res.writeHead(200, { "content-type": "application/json" });
  // An account with no file list yet: `list()` answers [] from this.
  res.end(JSON.stringify({ state: "absent" }));
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const address = fake.address();
if (address === null || typeof address !== "object") throw new Error("fake server did not bind");
after(() => fake.close());

test("loading the SDK makes every request say `sdk` and the SDK's own version", async () => {
  assert.equal(clientHeaderValue(), `sdk/${VERSION}`);
  const client = new Nmts(deviceRoot({ accountCode: await generateCode(), apiKey: KEY }), {
    server: `http://127.0.0.1:${address.port}`,
    network: "testnet",
  });
  assert.deepEqual(await client.list(), []);
  assert.ok(said.length > 0, "the server was asked");
  for (const v of said) assert.equal(v, `sdk/${VERSION}`);
});
