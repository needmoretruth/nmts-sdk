// A Node service that holds its customers' NMTS keys and stores files for them: the managed mode.
//
// Run it with the API key in the environment (the variable is NMTS_API_KEY):
//   node examples/node-managed/server.mjs
// Then: curl -X POST --data-binary @photo.jpg "http://127.0.0.1:8787/put?customer=alice&name=photo.jpg"
//       curl "http://127.0.0.1:8787/list?customer=alice"
//
// What this shape means: your service can read every file it stores, and so can whoever it lets
// in. NMTS still cannot — the sealing happens in this process. Choose it when the customer should
// not have to keep a key; choose the browser entry when they should be the only one who can read.
//
// The vault below is a stand-in. Replace `openCode` with your own store — a cloud key service, a
// master key, a hardware module. The client calls it once per verb and keeps nothing between calls,
// so your store stays the only place a code rests.
import { createServer } from "node:http";
import { Nmts } from "@needmoretruth/nmts-sdk";

const vault = new Map([
  // customer id → that customer's NMTS key (made once, by a person, at nmts.me)
  ["alice", process.env.ALICE_ACCOUNT_CODE ?? ""],
]);

function clientFor(customer) {
  const code = vault.get(customer);
  if (!code) throw new Error(`no account for customer ${customer}`);
  return Nmts.managed({ openCode: async () => code, apiKey: process.env.NMTS_API_KEY ?? "" });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const customer = url.searchParams.get("customer") ?? "";
  try {
    const nmts = clientFor(customer);
    if (req.method === "POST" && url.pathname === "/put") {
      const name = url.searchParams.get("name") ?? "upload.bin";
      const put = await nmts.put({ name, bytes: await readBody(req) });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(put));
    } else if (url.pathname === "/list") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await nmts.list()));
    } else if (url.pathname === "/get") {
      const bytes = await nmts.get(url.searchParams.get("path") ?? "");
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    res.writeHead(400, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
  }
}).listen(8787, "127.0.0.1", () => console.log("listening on http://127.0.0.1:8787"));
