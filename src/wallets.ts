// Every wallet one NMTS key opens, and which of them pays for storage.
//
// ⛔ THE NUMBERS COME FROM THE KEY, SO THERE IS NOTHING TO CREATE AND NOTHING TO DELETE. One NMTS
//    key derives a wallet at every index (NCF-3 §1.3); "which of them exist" is not a list anybody
//    keeps, so it is answered by WALKING — ask the chain about a number, then the next, and stop
//    after twenty unused ones in a row. The walk itself is the command-line package's own
//    (`discoverWallets`), so this library and `nmts wallet list` show one key the same wallets.
//
// ⛔ WHICH ONE PAYS IS THE ACCOUNT'S, NOT THIS PROCESS'S. It rides inside the sealed file list,
//    where no server can read it, so a phone, a browser and a program built on this package all
//    spend from the same address. Money leaving from one address on one device and another address
//    on another is how a balance goes missing without anything failing.
//
// ⛔ AND IT IS REFUSED RATHER THAN GUESSED. When the list cannot be read this does not fall back to
//    wallet 0: that would name one address in a price and sign with another, on an account whose
//    owner may never have funded the first. "I do not know which wallet should pay" is an answer;
//    wallet 0 is not. It is the command-line tool's rule (`wallet-pay-index.ts`), for money that
//    does not come back either way.

import {
  activeWalletOf,
  applyManyToList,
  chainReader,
  discoverWallets,
  hasHistory,
  NmtsError,
  readBalances,
  readFileList,
  walCoinType,
  walletAddress,
  walletCountOf,
  WALLET_INDEX_LIMIT,
  type ChainReader,
  type CoinBalance,
  type Network,
} from "@needmoretruth/nmts-cli";

import { withAccount, type Held, type Opened } from "./session.ts";

/** One of the wallets this account's NMTS key opens. */
export interface WalletInfo {
  /** The index the key derives it at. 0 is the wallet every account starts with. */
  index: number;
  /** Its Sui address — the same address on every network. */
  address: string;
  /** Is this the wallet storage is paid from? Exactly one wallet of an account is. */
  active: boolean;
}

/** What `setActiveWallet()` answers: the wallet that pays now, and whether this call moved it. */
export interface ActiveWallet {
  index: number;
  address: string;
  /** False when the account already paid from this wallet, so nothing was written. */
  changed: boolean;
}

/**
 * What the walk asks a chain. ⚠ Seams, not options: no caller of `wallets()` reaches them, and a
 * test hands in a chain that answers from a table exactly as the command-line tool's own do.
 */
export interface WalletReads {
  openChain?: ((network: Network, address: string) => ChainReader | Promise<ChainReader>) | undefined;
  hasHistory?: ((network: Network, address: string) => Promise<boolean>) | undefined;
}

/**
 * A wallet number as a caller wrote it.
 *
 * ⛔ REFUSED, NEVER ROUNDED. `1.5` and `-1` are calls to correct; taking either of them to a
 *    neighbouring wallet would pay from an address nobody named. The write path below clamps, which
 *    is right for a slider and wrong for an argument, so the refusal happens before it.
 */
export function requireWalletIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= WALLET_INDEX_LIMIT) {
    throw new NmtsError(`A wallet number is a whole number from 0 to ${WALLET_INDEX_LIMIT - 1}.`, {
      exitCode: 2,
      nextStep: "`wallets()` lists this key's wallets and their numbers.",
    });
  }
  return value;
}

/**
 * Which wallet this account pays from, out of its sealed list.
 *
 * An account that has never written the setting pays from the first wallet — that is a READ
 * answer and not a fallback: the list opened, and it said nothing about a wallet.
 */
export async function payingWallet(held: Held): Promise<number> {
  try {
    const list = await readFileList(held.server, held.apiKey, held.code, held.accountId);
    return activeWalletOf(list.manifest?.settings);
  } catch (error) {
    // A refusal this package already worded — no API key, a server that said no — is passed on as
    // it stands; it names the thing to fix, and a second sentence over it would bury that.
    if (error instanceof NmtsError) throw error;
    throw new NmtsError(
      `Which wallet this account pays from is written in its file list, and it could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      {
        exitCode: 1,
        nextStep:
          "Nothing was signed. Try again when the list can be read, or name the wallet for this one " +
          "call — `walletAddress({ index })` and `put(…, { wallet })` each take a number.",
      },
    );
  }
}

/**
 * Every wallet this account has, in index order: the ones it has made, and any further out that a
 * chain says have been used.
 *
 * Nothing is spent and nothing is written. The walk costs one balance read per number it asks
 * about, plus a transaction question for a wallet that holds neither coin — a wallet somebody
 * emptied is in use too, and a walk that asked about balances alone would report it as one that
 * does not exist.
 *
 * ⚠ A WALLET FUNDED FURTHER OUT THAN THE GAP IS NOT FOUND HERE. It is not lost: numbers come from
 *   the key, so `walletAddress({ index })` and `setActiveWallet(index)` still reach it.
 */
export async function wallets(opened: Opened, reads: WalletReads = {}): Promise<WalletInfo[]> {
  const open = reads.openChain ?? chainReader;
  const history = reads.hasHistory ?? hasHistory;
  return withAccount(opened, async (held) => {
    const list = await readFileList(held.server, held.apiKey, held.code, held.accountId);
    const settings = list.manifest?.settings;
    const active = activeWalletOf(settings);
    const count = walletCountOf(settings);
    const walType = walCoinType(held.network);

    // Every number the walk asked about, so no address is derived or read twice.
    const seen = new Map<number, string>();
    const scan = await discoverWallets(
      async (index) => {
        const address = await walletAddress(held.code, index);
        seen.set(index, address);
        const balances = await readBalances(await open(held.network, address), walType);
        // ⛔ A BALANCE THAT COULD NOT BE READ IS NOT A ZERO, so it is not a wallet this walk gets to
        //    call unused: the transaction question below still has its say, and a wallet that has
        //    one is reported whatever the node did with the balance.
        const holds = (coin: CoinBalance): boolean => coin.read && coin.baseUnits > 0n;
        if (holds(balances.sui) || holds(balances.wal)) return true;
        return history(held.network, address);
      },
      { count },
    );

    // ⛔ THE COUNT IS READ AND NOT RAISED HERE. "Making a wallet" is a person's act on the wallets
    //    screen, and a library that wrote the account's list while answering a question about it
    //    would be spending a file-list version on a read its caller did not ask to change anything
    //    with. What the walk found is reported; what the account holds stays what it held.
    return [...seen]
      .filter(([index]) => index < count || scan.used.includes(index))
      .map(([index, address]) => ({ index, address, active: index === active }))
      .sort((a, b) => a.index - b.index);
  });
}

/**
 * Say which of this key's wallets pays for storage from now on, on this account rather than on
 * this machine.
 *
 * Nothing is deleted and nothing is created: every number a key can derive already exists, and
 * this says which of them the next payment comes out of. The account's count of wallets comes up
 * with it, never down, so every screen lists the wallet it just named.
 */
export async function setActiveWallet(opened: Opened, index: number): Promise<ActiveWallet> {
  // ⛔ BEFORE THE NETWORK. A number that is not one is a call to fix, and a run that opened the
  //    account first — a business's sealed store, for a managed root — would refuse for the wrong
  //    reason after having opened it for nothing.
  const wanted = requireWalletIndex(index);
  return withAccount(opened, async (held) => {
    const before = await readFileList(held.server, held.apiKey, held.code, held.accountId);
    // The setting lives IN the list, so an account with no list has nowhere to put it — the same
    // refusal `nmts wallet use` gives, with the same way out.
    if (before.manifest === null) {
      throw new NmtsError(
        "This account has no file list yet; which wallet pays lives in the list, and there is nothing to write it into.",
        { exitCode: 4, nextStep: "Upload once with `put()` and set the wallet after." },
      );
    }
    const result = await applyManyToList(held, () => [], { activeWallet: wanted });
    return { index: wanted, address: await walletAddress(held.code, wanted), changed: result.changed };
  });
}
