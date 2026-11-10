// The money questions a business asks with no account open: what an upload costs, what an address
// holds, and whether a transaction somebody else built is one it agreed to pay for.
//
// ⛔ WHY (spec 2026-09-20 Deponejo · gaps B and C · plan 2026-11-10). A business prices an invoice
//    before its customer has an account, watches its own wallet's balance from a cron job, and
//    checks a customer device's transaction on its server before its wallet signs it. None of the
//    three opens an account or derives a key, so none is a method on an account: they are statics,
//    `Nmts.price`, `Nmts.balances` and `Nmts.checkSponsored`, and they run in the browser entry too.
//
// ⛔ THE ARITHMETIC IS THE UPLOAD'S AND THE CHECK IS THE SIGNER'S. `price` is the CLI's
//    `quoteUpload`, which prices with the function `put` prices with; `checkSponsored` is the CLI's
//    `judgeSponsored`, the one `nmts.sponsor()` runs before it signs. A second copy here could drift.

import {
  chainReader,
  DEFAULT_SERVER,
  judgeSponsored,
  quoteUpload,
  readBalances,
  resolveNetwork,
  sponsorFacts,
  walCoinType,
  type Network,
  type SponsorFacts,
  type SponsorPolicy,
  type SponsorVerdict,
  type UploadQuote,
  type UploadQuoteAsk,
} from "@needmoretruth/nmts-cli/portable";

/** Which storage network. Default: `NMTS_NETWORK`, else mainnet. */
export interface NetworkOption {
  network?: Network | undefined;
}

export type PriceOptions = UploadQuoteAsk & NetworkOption;
export type { UploadQuote as Price } from "@needmoretruth/nmts-cli/portable";

/** One coin an address holds, in base units as a decimal string — or why nobody knows. */
export type Balance = { amount: string; why: null } | { amount: null; why: string };

/** What one address holds on one network. ⛔ A coin that could not be read is null with why, never "0". */
export interface Balances {
  network: Network;
  address: string;
  /** WAL, in FROST (1 WAL = 10⁹ FROST). */
  wal: Balance;
  /** SUI, in MIST (1 SUI = 10⁹ MIST). */
  sui: Balance;
}

/** ⚠ A SEAM for tests: the chain facts a check reads, handed in instead of read. */
export interface CheckSeams {
  facts?: SponsorFacts | undefined;
}

/**
 * The chain facts, read once per network and operator and kept for ten minutes. ⚠ An operator's
 * server checks two or three transactions per upload; reading the package and asking every relay
 * for its tip address each time would be a round trip per signature for facts that do not move.
 */
const FACTS_KEPT_MS = 10 * 60 * 1000;
const kept = new Map<string, { at: number; facts: Promise<SponsorFacts> }>();
export function factsFor(network: Network, operator: string): Promise<SponsorFacts> {
  const key = `${network}:${operator}`;
  const now = Date.now();
  const hit = kept.get(key);
  if (hit !== undefined && now - hit.at < FACTS_KEPT_MS) return hit.facts;
  const facts = sponsorFacts(network, operator);
  // A failed read is not kept: the next check asks again.
  facts.catch(() => kept.delete(key));
  kept.set(key, { at: now, facts });
  return facts;
}

function networkOf(options: NetworkOption): Network {
  return resolveNetwork(DEFAULT_SERVER, options.network);
}

/** What an upload of `bytes` for `epochs` costs, with no file, no account and no wallet. */
export function priceOf(options: PriceOptions): Promise<UploadQuote> {
  const { bytes, epochs, padding, partSize } = options;
  return quoteUpload(networkOf(options), { bytes, epochs, padding, partSize });
}

/** The WAL and SUI any address holds. Nothing is signed; no account is needed. */
export async function balancesOf(address: string, options: NetworkOption = {}): Promise<Balances> {
  const network = networkOf(options);
  const read = await readBalances(chainReader(network, address), walCoinType(network));
  const one = (coin: (typeof read)["sui"]): Balance =>
    coin.read ? { amount: coin.baseUnits.toString(), why: null } : { amount: null, why: coin.why };
  return { network, address, wal: one(read.wal), sui: one(read.sui) };
}

/**
 * Judge a transaction another device built against what the operator agreed to pay for, BEFORE
 * signing it. Never throws for a refusal: `{ ok: false, code, reason }` says it in one log line.
 */
export async function checkSponsoredBytes(
  bytes: Uint8Array | string,
  policy: SponsorPolicy,
  seams: CheckSeams = {},
): Promise<SponsorVerdict> {
  const facts = seams.facts ?? (await factsFor(policy.network, policy.operator));
  return judgeSponsored(bytes, policy, facts);
}
