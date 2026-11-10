// A customer's device uploads a file into ITS OWN account, and the operator's wallet pays.
//   node examples/money/sponsored-upload.mjs ./photo.jpg
//
//   NMTS_ACCOUNT_CODE_FILE, NMTS_API_KEY_FILE   the CUSTOMER's account (the file is listed there)
//   NMTS_SERVER, NMTS_NETWORK                    the same server and network as the operator's
//   SPONSOR_URL, CUSTOMER, CUSTOMER_TOKEN        see remote-signer.mjs
//
// The file is sealed on this device with this account's keys; the operator signs the transactions
// that buy and certify the storage and never sees the bytes or the key. The storage object belongs
// to the operator's address, so the operator extends it (auto-extend.mjs), and the recovery
// program's search from the key alone does not find it: the customer keeps a recovery list file.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Nmts } from "@needmoretruth/nmts-sdk";

import { signerFromEnv } from "./remote-signer.mjs";

const file = process.argv[2];
if (file === undefined) throw new Error("usage: sponsored-upload.mjs <file>");
const nmts = Nmts.fromEnv();
const signer = await signerFromEnv();
console.log(`uploading ${basename(file)} into this account · paid by the operator ${signer.address}`);

const put = await nmts.put(file, { pay: { signer } });
console.log(`stored ${put.path} · the operator paid ${put.wal} FROST of WAL and ${put.sui} MIST of SUI · runs to epoch ${put.endEpoch}`);

const back = await nmts.get(put.path);
console.log(`opened ${put.path}: ${back.length} bytes · byte-identical ${Buffer.compare(Buffer.from(back), readFileSync(file)) === 0}`);
