// Keep every customer's files stored while they pay, and let them run out when they stop. Run daily
// on the operator's server, alone: no customer's key and no customer's device is needed.
//   node examples/money/auto-extend.mjs
//
//   NMTS_ACCOUNT_CODE_FILE, NMTS_API_KEY_FILE   the OPERATOR's account; its wallet holds the storage
//                                               the sponsored uploads bought, and pays
//   NMTS_SERVER, NMTS_NETWORK                    the same server and network as sponsor-server.mjs
//   BUSINESS_ACCOUNT_ID, BUSINESS_KEY_FILE       your NMTS Platform business, to mint each customer's token
//   LEDGER_FILE (./ledger.json)                  see ledger.mjs; `ledger.mjs account <customer> <id>`
//                                               records each customer's NMTS account id
//   EXTEND_EPOCHS (2)                            how much to add when a file is due
//   EXTEND_EARLY=1                               extend even a file that is not due (to try it once)
//
// For each customer: a token with `files_read` and `storage_spend`, minted here and sent nowhere
// but the NMTS server; a dry run of `extendFor`, judged against what the customer has left in the
// ledger; then the run itself, charged to the ledger file by file. `extendFor` extends only files
// near their end and only storage this wallet holds, so run daily it keeps every paid file ahead.
//
// ⛔ NON-PAYMENT: mark the customer unpaid (`node ledger.mjs unpaid <customer>`). This job then skips
//    them before minting anything, and their files leave the storage network when the paid term
//    ends. Erasing them sooner is a separate decision with its own confirmation —
//    `nmts.erase(paths, { confirm: ERASE_CONFIRM })` — and nothing here does it.
import { readFileSync } from "node:fs";

import { Ledger } from "./ledger.mjs";

const MIB = 1024 * 1024;

/** One pass over every customer with a known account: a line per customer skipped and per file extended or left. */
export async function extendCustomers({ nmts, business, ledger, epochs = 2, force = false, log = console.log }) {
  const at = () => new Date().toISOString();
  for (const { customer, account, unpaid } of ledger.accounts()) {
    if (unpaid) {
      log(`${at()} skip ${customer}: marked unpaid · nothing minted, nothing signed`);
      continue;
    }
    const token = await business.delegate({ user: account, scope: ["files_read", "storage_spend"], ttlSecs: 3600 });
    const review = await nmts.extendFor(token, { epochs, force, dryRun: true });
    const due = review.files.filter((f) => f.outcome === "priced");
    if (due.length === 0) {
      log(`${at()} ${customer}: nothing due · ${review.files.length} files looked at`);
      continue;
    }
    // Each file is charged rounded up to whole MiB, so the total is judged the same way.
    const bytes = due.reduce((sum, f) => sum + Math.ceil(f.bytes / MIB) * MIB, 0);
    const fits = ledger.judge(customer, { bytes, epochs, suiMist: review.sui });
    if (!fits.ok) {
      log(`${at()} skip ${customer}: LEDGER ${fits.reason} · nothing signed`);
      continue;
    }
    const run = await nmts.extendFor(token, { epochs, force });
    for (const file of run.files) {
      if (file.outcome === "extended") {
        ledger.charge(customer, { bytes: file.bytes, epochs: file.epochs, suiMist: file.sui ?? "0" });
        log(`${at()} ${customer}: extended ${file.itemId} from epoch ${file.endEpoch} to ${file.newEndEpoch} · WAL ${file.wal} FROST · ${file.digest}`);
      } else if (file.code !== "EXTEND_NOT_DUE") {
        log(`${at()} ${customer}: left ${file.itemId} · ${file.code} ${file.reason}`);
      }
    }
    if (run.stopped !== null) log(`${at()} ${customer}: stopped · ${run.stopped.code} ${run.stopped.reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Loaded here, so the function above can be tried without a built package.
  const { Nmts } = await import("@needmoretruth/nmts-sdk");
  const env = process.env;
  await extendCustomers({
    nmts: Nmts.fromEnv(),
    business: Nmts.business({ accountId: env.BUSINESS_ACCOUNT_ID, privateKey: readFileSync(env.BUSINESS_KEY_FILE, "utf8").trim() }),
    ledger: Ledger.open(env.LEDGER_FILE ?? "./ledger.json"),
    epochs: Number(env.EXTEND_EPOCHS ?? 2),
    force: env.EXTEND_EARLY === "1",
  });
}
