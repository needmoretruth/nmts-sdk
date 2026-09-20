// Paying for storage from the account's own wallet instead of with credits:
//   node examples/pay-from-wallet.mjs ./some-file
//
// Needs NMTS_ACCOUNT_CODE_FILE (or NMTS_ACCOUNT_CODE) and NMTS_API_KEY_FILE (or NMTS_API_KEY) in
// the environment, and WAL and SUI in the wallet the first line prints. This is the rail a product
// built on NMTS uses: credits are not for resale, the wallet's coins are yours, and nothing on this
// rail is paid to NMTS — WAL buys the storage on Walrus, SUI pays the relay's tip and the chain fee.
//
// ⛔ THE SECOND put() BELOW SPENDS. There is no confirmation step: calling it is the agreement.
//    The first one, with `dryRun: true`, signs nothing and spends nothing.
import { Nmts } from "@needmoretruth/nmts-sdk";

const file = process.argv[2] ?? "./README.md";
const nmts = Nmts.fromEnv();

console.log(`this account pays from ${await nmts.walletAddress()}`);

// The price before anything is signed. `wal` and `sui` are the chains' smallest units (FROST and
// MIST) as decimal strings; a balance the chain could not read is null, not zero.
const review = await nmts.put(file, { pay: "wallet", epochs: 4, dryRun: true });
console.log(`storage ${review.wal} FROST · tip and fee ${review.sui} MIST · runs to epoch ${review.endEpoch}`);
console.log(`the wallet holds ${review.wallet.wal ?? "unread"} FROST and ${review.wallet.sui ?? "unread"} MIST`);
if (review.shortfall !== null) {
  // Names the coin that is short, with what the wallet holds and what is needed. Nothing was signed.
  console.error(review.shortfall);
  process.exit(4);
}

const put = await nmts.put(file, { pay: "wallet", epochs: 4 });
console.log(`stored ${put.path} — paid ${put.wal} FROST and ${put.sui} MIST, no credits`);
