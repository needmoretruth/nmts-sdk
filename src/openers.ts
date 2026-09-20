// Wallet sign-in: opening an account with a wallet, and the wallets that may open one.
//
// ⛔ WHY IT EXISTS. An NMTS account is one secret, and until now there was one way to present it:
//    hand the account code over. A program whose users hold Sui wallets — a game, a page, an agent
//    — had to ask them for that code, which is the worst thing to ask anybody for. An opener is a
//    second road to the same key: the account's own code, sealed under a key expanded from one
//    signature, filed under a name derived from that same signature. The server keeps a lump it
//    cannot open, under a name it cannot trace to a wallet.
//
// ⛔ THE ACTS ARE THE COMMAND-LINE PACKAGE'S `openers`, NOT A COPY OF THEM. Which bytes are signed,
//    what the two signatures are compared against, when the account's 20 key bytes exist and when
//    they are wiped — written once, over there, and `nmts openers` and these four verbs are the
//    same functions with a different caller.
//
// ⛔ AND THE SERVER ASKS FOR THE ACCOUNT CODE'S OWN PROOF ON ALL THREE ACCOUNT DOORS, whichever
//    credential the client speaks with. A delegation token is its business's permission; the proof
//    is an act only whoever holds the code can perform, and every verb here has the code in hand.
//
// ⛔ THE MANAGED ROOT IS REFUSED BY NAME, and that is the key-holder law rather than an exception
//    to it. An opener is a way for a PERSON'S own wallet to reach a key; where the business holds
//    the key, the business's own sealed store is already that road, and a slot beside it would be
//    a second copy of somebody else's account key that nobody asked for. The methods exist, they
//    are the same names, and they say which thing does the job on this root.

import {
  addWallet,
  listOpeners,
  removeWallet,
  signInWithWallet,
  walletSlot,
  type AttachedWallet,
  type OpenerAccess,
  type OpenerInfo,
  type SignWallet,
  type WalletOpener,
} from "@needmoretruth/nmts-cli/openers";
import { NmtsError, registrationProofOf, resolveServer } from "@needmoretruth/nmts-cli/portable";

import type { Credentials } from "./root.ts";
import { withAccount, type Held, type Opened } from "./session.ts";

export type { AttachedWallet, OpenerInfo, SignWallet } from "@needmoretruth/nmts-cli/openers";

/** Which wallet, and which of its accounts. */
export interface WalletInput {
  /**
   * Whatever holds the wallet's key, asked for a signature over the bytes this package builds.
   *
   * It takes the message and answers what the wallet standard answers — `{ signature, bytes }`, or
   * the serialized signature on its own. In a page that is `useSignPersonalMessage()`; on a server
   * it is whatever signs for the person whose account this is.
   */
  sign: SignWallet;
  /** The wallet's Sui address, `0x` and 64 LOWERCASE hex. It is inside what is signed. */
  address: string;
  /**
   * Which of this wallet's NMTS accounts. Default 1.
   *
   * ⚠ IT IS INSIDE THE SIGNED BYTES, so nothing can look for the others: asking about a different
   *   number means asking the wallet for a different signature.
   */
  account?: number | undefined;
  /**
   * Scope this wallet's signature to one product.
   *
   * ⚠ THE PRICE OF LEAVING IT OUT, SAID HERE BECAUSE THIS IS WHERE IT IS CHOSEN: without it, one
   *   wallet opens the SAME account everywhere — which is usually what somebody wants, and means
   *   every product that gets this signature opens the same files. With it, this wallet opens an
   *   account that exists for this product alone.
   */
  app?: string | undefined;
}

/** What `Nmts.fromWallet()` takes: a wallet, and the credential the server answers to. */
export interface WalletCredentials extends WalletInput {
  apiKey?: string | undefined;
  delegation?: string | undefined;
  server?: string | undefined;
  network?: string | undefined;
}

/** The wallets that open one account. `nmts.openers` is this. */
export interface Openers {
  /** Every wallet and passkey that opens this account, oldest name first. Nothing is signed. */
  list(): Promise<OpenerInfo[]>;
  /**
   * Attach a wallet, so it opens this account from then on.
   *
   * ⛔ THE WALLET IS ASKED TO SIGN TWICE AND BOTH ANSWERS MUST MATCH. A wallet that signs
   *    differently each time — multisig, zkLogin, a passkey, a hedging signer — would seal
   *    something it could never open, and the account would be unreachable at the next sign-in.
   *
   * ⛔ AND WHOEVER HOLDS THAT WALLET CAN THEN OPEN EVERY FILE IN THIS ACCOUNT, from any machine,
   *    until it is removed.
   */
  addWallet(input: WalletInput): Promise<AttachedWallet>;
  /**
   * Take one opener off this account, by the locator `list()` gives.
   *
   * ⛔ IT IS "FROM NOW ON", NOT "AS IF IT NEVER KNEW". A wallet that opened this account once has
   *    held the account's key; the only answer to that is a new account.
   */
  remove(locator: string): Promise<void>;
  /**
   * The sealed 62 bytes of one opener — the file the recovery tool opens with a signature.
   *
   * ⚠ IT IS WORTH NOTHING WITHOUT THE WALLET, and it needs no credential to fetch: the name it is
   *   filed under comes from the same secret the key does. What it buys is that somebody can keep
   *   their own copy and reach their account with their wallet alone, with this server gone.
   */
  exportSlot(locator: string): Promise<Uint8Array>;
}

/**
 * Open an account with a wallet: sign once, ask for the slot that signature names, open it.
 *
 * ⛔ WHAT COMES BACK IS THE ACCOUNT. It goes straight into a device client and nowhere else — this
 *    package neither sends it anywhere nor writes it down.
 */
export async function credentialsFromWallet(input: WalletCredentials): Promise<Credentials> {
  const { accountCode } = await signInWithWallet(resolveServer(input.server), openerOf(input));
  // ⚠ A blank credential stays blank rather than becoming the other kind: the refusal a later call
  //   makes should name the credential that was asked for, not the one that was not.
  return input.delegation === undefined
    ? { accountCode, apiKey: input.apiKey ?? "" }
    : { accountCode, delegation: input.delegation };
}

/** The four verbs, over one opened account. */
export function openersOn(opened: Opened): Openers {
  return {
    list: () => onAccount(opened, async (_held, access) => (await listOpeners(access)).openers),
    addWallet: (input: WalletInput) => onAccount(opened, (held, access) => addWallet(access, held.code, openerOf(input))),
    remove: (locator: string) => onAccount(opened, (_held, access) => removeWallet(access, locator)),
    // ⚠ NO CODE IS BORROWED AND NO CREDENTIAL IS SENT: the locator is the whole of what this door
    //   takes. It is still refused on a managed root, because what it exports is one road into
    //   somebody's account and a business's store is not where that decision belongs.
    exportSlot: async (locator: string) => {
      refuseManaged(opened);
      return walletSlot(opened.server, locator);
    },
  };
}

/**
 * One verb: refused, then the code borrowed once, then the proof built for that one run.
 *
 * ⛔ THE REFUSAL COMES BEFORE THE BORROW. A managed root opened and only then told "not here" would
 *    have had a business's sealed store opened for nothing — the one cost this package counts.
 */
async function onAccount<T>(opened: Opened, body: (held: Held, access: OpenerAccess) => Promise<T>): Promise<T> {
  refuseManaged(opened);
  return withAccount(opened, async (held) => body(held, await reach(held)));
}

/** One `WalletInput` as the library underneath takes it. */
function openerOf(input: WalletInput): WalletOpener {
  return {
    address: input.address,
    sign: input.sign,
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(input.app === undefined ? {} : { app: input.app }),
  };
}

/** Where to talk, the credential, and the account code's proof for this one run. */
async function reach(held: Held): Promise<OpenerAccess> {
  // ⚠ `registrationProofOf` IS WHERE THIS VALUE IS DERIVED, and it is not only about registering:
  //   `authSecret` is the 32 bytes every sign-in sends and the same bytes the proof header carries.
  return { server: held.server, apiKey: held.bearer, accountProof: (await registrationProofOf(held.code)).authSecret };
}

/** A managed root is told what does this job there, rather than being handed a second way in. */
function refuseManaged(opened: Opened): void {
  if (opened.root.mode !== "managed") return;
  throw new NmtsError(
    "NOT_FOR_MANAGED_ROOT: openers are a way for a person's own wallet to reach a key this root does not hold that way.",
    {
      exitCode: 2,
      nextStep:
        "Nothing was sent. On this root the business's own sealed store IS the opener: it holds the " +
        "account code and opens it per call. A device root — `Nmts.device()` or `Nmts.fromWallet()` — " +
        "is where a wallet is attached.",
    },
  );
}
