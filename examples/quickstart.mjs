// The README's quickstart, runnable: `node examples/quickstart.mjs ./some-file`.
//
// Needs NMTS_ACCOUNT_CODE_FILE (or NMTS_ACCOUNT_CODE) and NMTS_API_KEY_FILE (or NMTS_API_KEY) in
// the environment. The upload spends credits: one per started MiB of sealed bytes.
import { Nmts } from "@needmoretruth/nmts-sdk";

const file = process.argv[2] ?? "./README.md";
const nmts = Nmts.fromEnv();

const put = await nmts.put(file);
console.log(`stored ${put.path} — ${put.bytes} bytes, ${put.credits} credit(s)`);

const bytes = await nmts.get(put.path);
console.log(`fetched ${bytes.length} bytes back`);

for (const entry of await nmts.list()) console.log(`${entry.kind === "folder" ? "d" : "f"}  ${entry.size}\t${entry.path}`);
