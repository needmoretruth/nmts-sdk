// Keep a customer's files stored while they pay, and let them run out when they stop. Run daily.
//   node examples/money/auto-extend.mjs
//
//   NMTS_ACCOUNT_CODE_FILE, NMTS_API_KEY_FILE   the customer's account (or open each one with
//                                               Nmts.managed() if your business holds the keys)
//   SPONSOR_URL, CUSTOMER, CUSTOMER_TOKEN        see remote-signer.mjs
//   EXTEND_EPOCHS (2)                            how much to add when a file is due
//   EXTEND_EARLY=1                               extend even a file that is not due (to try it once)
//
// The operator's wallet pays each extension through the same check as the upload: the server signs
// only an `extend_blob` of a blob it is willing to pay for, and only while the ledger says the
// customer has paid. `extend()` itself extends only a file whose term ends within 14 days or 3
// epochs, whichever is longer, and skips the rest (EXTEND_NOT_DUE): run daily, this keeps every
// file at least that far ahead and buys nothing further.
//
// ⛔ NON-PAYMENT: mark the customer unpaid (`node ledger.mjs unpaid <customer>`). The server then
//    refuses their extensions, and their files leave the storage network when the paid term ends.
//    Erasing them sooner is a separate decision with its own confirmation —
//    `nmts.erase(paths, { confirm: ERASE_CONFIRM })` — and nothing here does it.
import { Nmts } from "@needmoretruth/nmts-sdk";

import { signerFromEnv } from "./remote-signer.mjs";

const nmts = Nmts.fromEnv();
const signer = await signerFromEnv();
const epochs = Number(process.env.EXTEND_EPOCHS ?? 2);
const at = () => new Date().toISOString();

const files = (await nmts.list()).filter((entry) => entry.kind === "file");
for (const file of files) {
  try {
    const done = await nmts.extend(file.path, { epochs, pay: { signer }, force: process.env.EXTEND_EARLY === "1" });
    console.log(`${at()} extended ${file.path} by ${done.epochs} epochs to ${done.endEpoch} · ${done.digest}`);
  } catch (error) {
    const message = String(error.message);
    if (message.startsWith("EXTEND_NOT_DUE")) console.log(`${at()} not due ${file.path}`);
    else if (message.includes("operator refused")) console.log(`${at()} not extended ${file.path}: ${message}`);
    else console.log(`${at()} skipped ${file.path}: ${message}`);
  }
}
