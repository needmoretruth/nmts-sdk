// `nmts.sponsor(bytes, limits)` — the operator's side of an upload its wallet pays for: check the
// transaction a customer's device built, and sign it as the sender only if it passes.
//
// ⛔ WHY (spec 2026-09-20 Deponejo · gap B · plan 2026-11-10 §1.3). A business that took its
//    customer's money however it likes — a card, Bitcoin, Monero — pays that customer's storage
//    from its own wallet: the device calls `put(file, { pay: { signer } })` and the signer forwards
//    each transaction here. On the chain the operator is the sender and nothing moves from the
//    operator to the customer. Turning the customer's payment into WAL is the business's own
//    treasury work. NMTS neither converts nor holds anybody's coins, so that nothing here makes it
//    an exchange or a custodian of other people's virtual assets.
//
// ⛔ CHECK, THEN SIGN, AND NOTHING ELSE. The operator is this account's paying wallet, the network
//    is this account's network, and the bytes go through `Nmts.checkSponsored`'s own judgement
//    inside the one signing door that has it (`signSponsored`). A refusal throws
//    `SPONSOR_REFUSED: <code>: <reason>` before a key is derived for signing. It does not submit:
//    the device that built the transaction submits it with the signature it gets back.

import { walletAddress, signSponsored, type SponsorPolicy, type SponsorSpend } from "@needmoretruth/nmts-cli/portable";

import { readList } from "./list.ts";
import { factsFor, type CheckSeams } from "./money.ts";
import { withAccount, type Opened } from "./session.ts";
import { refuseWithoutSpendScope } from "./storage.ts";

/** What one sponsored transaction may spend. The operator and the network are the account's own. */
export type SponsorLimits = Omit<SponsorPolicy, "network" | "operator">;

/** A signature the device submits with the bytes, and what the check measured. */
export interface Sponsored {
  /** The transaction, base64 — the same bytes that were checked. */
  bytes: string;
  signature: string;
  spends: SponsorSpend;
}

/** Check `bytes` against `limits` and sign as this account's paying wallet if they pass. */
export async function sponsorTransaction(
  opened: Opened,
  bytes: Uint8Array | string,
  limits: SponsorLimits,
  seams: CheckSeams = {},
): Promise<Sponsored> {
  return withAccount(opened, async (held) => {
    // ⛔ SIGNING HERE SPENDS THIS WALLET'S WAL AND SUI, so a delegated account needs `storage_spend`.
    await refuseWithoutSpendScope(opened, "and a sponsored transaction spends from the wallet");
    const wallet = (await readList(held)).activeWallet;
    const operator = await walletAddress(held.code, wallet);
    const raw = typeof bytes === "string" ? Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)) : bytes;
    return signSponsored({
      network: held.network,
      code: held.code,
      wallet,
      bytes: raw,
      policy: { ...limits, network: held.network, operator },
      facts: seams.facts ?? (await factsFor(held.network, operator)),
    });
  });
}
