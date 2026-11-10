// Say so before the operator's wallet runs dry. Run every few minutes from cron. No account needed.
//   node examples/money/balance-alert.mjs
//
//   OPERATOR_ADDRESS        the wallet that pays (GET /operator on your sponsor server prints it)
//   NMTS_NETWORK            mainnet or testnet
//   MIN_WAL_FROST, MIN_SUI_MIST   the floors (defaults: 5 WAL, 1 SUI)
//   ALERT_WEBHOOK_URL       optional: POSTed `{ text }` when a floor is crossed (Slack, Discord, …)
//
// It reads; it never signs. Topping the wallet up is the business's own treasury work.
import { Nmts } from "@needmoretruth/nmts-sdk";

const address = process.env.OPERATOR_ADDRESS;
if (address === undefined) throw new Error("set OPERATOR_ADDRESS");
const floors = { wal: BigInt(process.env.MIN_WAL_FROST ?? 5_000_000_000n), sui: BigInt(process.env.MIN_SUI_MIST ?? 1_000_000_000n) };

const held = await Nmts.balances(address, { network: process.env.NMTS_NETWORK });
const problems = [];
for (const coin of ["wal", "sui"]) {
  const { amount, why } = held[coin];
  if (amount === null) problems.push(`${coin.toUpperCase()} could not be read: ${why}`);
  else if (BigInt(amount) < floors[coin]) problems.push(`${coin.toUpperCase()} is ${amount}, below ${floors[coin]}`);
}
const line = `${new Date().toISOString()} ${address} on ${held.network}: WAL ${held.wal.amount ?? "?"} FROST · SUI ${held.sui.amount ?? "?"} MIST`;
if (problems.length === 0) {
  console.log(`${line} · ok`);
} else {
  console.log(`${line} · LOW: ${problems.join("; ")}`);
  if (process.env.ALERT_WEBHOOK_URL) {
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `NMTS operator wallet low: ${problems.join("; ")}` }),
    });
  }
  process.exitCode = 3;
}
