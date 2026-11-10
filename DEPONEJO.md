# Deponejo — a storage service that keeps the minimum about its users, built on NMTS

Second edition, 2026-11-11. A specification, not a program, meant to be complete enough to build from.
A section marked **GAP** names something NMTS does not do yet, and this document changes when it ships.

*Deponejo* is Esperanto for a place where things are deposited.

## 0. From the author of the idea

This is my idea, and I did not build it. Running it means taking payment and exchanging coins, and I could
not be sure of meeting the rules for either, so I am giving the idea away: build it, run it, change it,
sell it. None of that needs my permission. I wrote it on the premise that nmts.me is the backend, so every
storage step below is a call to the NMTS SDK (`@needmoretruth/nmts-sdk`, Apache-2.0). That is a fact about
this document, not a condition on you.

The text is under CC BY 4.0: if you copy or adapt the text, credit needmoretruth, link to nmts.me, and say
what you changed. Building the service is not copying the text, and the licence asks nothing of it.

Whoever runs a service like this answers for it under the law of the places where they and their users
are. Taking payment for a service, holding customer balances and exchanging one coin for another are each
regulated differently from country to country, and nothing here says that running it is lawful where you
are. NMTS does not inspect, certify or vouch for anything built on it (NMTS Terms 3.7).

— needmoretruth

## 1. What the service is

A web service where a person stores files that are encrypted on their own device, pays in Monero, and
reaches the service over Tor if they choose. The operator cannot open the files, and does not ask for an
e-mail address, a name or a phone number.

| The operator sees | The operator never sees |
|---|---|
| an account id (a public value derived from the user's key) | the user's NMTS key, or anything derived from it that opens files |
| how many bytes the account has stored and paid for, and when | file contents, names, folders |
| Monero payments arriving at addresses it issued | who sent them |
| the network address of a request: a Tor exit or onion circuit when the user comes over Tor | |

Tell users exactly this. Do not describe the service as "anonymous": what it does is collect little, and
that is the claim that stays true.

## 2. Parts

1. **The page**: static HTML and JavaScript served by the operator, also as an onion service. It bundles
   the SDK's browser entry (`@needmoretruth/nmts-sdk/browser`). Encryption and every NMTS call that needs
   the user's key happen here.
2. **The operator's server**: holds the business registration with NMTS, signs delegation tokens, keeps
   the payment ledger, runs the Monero wallet, and signs the storage transactions the operator pays for.
3. **The operator's NMTS account**: an ordinary account whose wallet holds WAL (storage) and SUI (chain
   fees). This wallet is the *float*. It pays for every user's storage, so no user ever holds WAL or SUI.
4. **NMTS**: each user's account, its sealed file list, and the bookkeeping of what is stored where.
5. **Walrus and Sui**: where the encrypted bytes live and where storage is paid for.

## 3. One-time setup by the operator

1. Make an NMTS account at nmts.me and register it as a business: `nmts platform keygen`, then
   **Settings › Developer › Platform**. Read NMTS Terms 3.7 first; it says what the operator answers for.
2. On the server: `const business = Nmts.business({ accountId, privateKey })` for tokens, and
   `const ops = Nmts.device({ accountCode, apiKey })` for the operator's own account. Keep that account's
   NMTS key on the server only.
3. Fund the float: send WAL and SUI to `await ops.walletAddress()`. Watch it with
   `Nmts.balances(address)` from a scheduled job and refill it before it runs low
   (`examples/money/balance-alert.mjs`).
4. Run `monero-wallet-rpc` against a wallet whose view key and spend key stay on the operator's machine.
5. Publish the page at a normal address and at an onion address. Publish the hash of each release of the
   page, so that a user who cares can check that the code they were served is the code that was published.

## 4. Flows

### 4.1 A user starts
On the device:
```js
const accountCode = await Nmts.newAccountCode();   // the user's NMTS key; shown once, and the user writes it down
const user = await Nmts.accountIdOf(accountCode);  // the public id; this is all the operator learns
```
The page sends `user` to the operator's server, which answers with a delegation token and a customer token
for its own ledger (`examples/money/sponsor-server.mjs` signs one with an HMAC):
```js
const token = await business.delegate({ user, scope: ["register", "files_read", "files_write", "storage_spend"], ttlSecs: 3600 });
```
The device opens its own account and its client:
```js
await Nmts.registerWithDelegation({ accountCode, delegation: token });
const nmts = Nmts.device({ accountCode, delegation: token });
```
Before this step the page shows the NMTS Privacy Policy and obtains the consent its section 5.6 describes
(NMTS Terms 3.7). The service is not directed to children.

**Signing in with a wallet the user already has.** A user who has a Sui wallet does not have to type the
NMTS key on every visit. Once, after the account is open:
```js
await nmts.openers.addWallet({ sign, address, app: "deponejo" });   // the wallet is asked to sign twice
```
and on later visits, on any device, one signature opens the account:
```js
const nmts = await Nmts.fromWallet({
  sign, address, app: "deponejo",
  delegation: (user) => fetch(`/token?user=${user}`).then((r) => r.text()),   // the operator's own endpoint
});
```
A delegation token is signed for one account id, and a device that has never seen the account cannot
know that id until the wallet has opened it. So `delegation` is a function here: the library opens the
account first, hands the function its public id, and the function asks the operator's server for the
token (the `business.delegate` call above, without `register`).

`sign(messageBytes)` is the wallet standard's personal-message signing. The wallet signs one fixed
message, and the signature opens a copy of the user's NMTS key that the NMTS server keeps locked and
cannot open. The `app` line is inside the signed message, so a wallet attached for Deponejo opens
Deponejo's account and nothing else. The NMTS key stays the root of the account and is still shown once
and written down: it opens the account if the wallet is lost or starts signing differently. A zkLogin,
multi-signature or passkey account is refused by name, because it does not sign the same message the same
way twice.

**GAP A: no server copy at all.** NMTS plans a second road, under "advanced", where the NMTS key is
computed from the wallet's signature and nothing is stored on any server. Its message and its derivation
are frozen forever on the day it ships, so it is not out yet.

### 4.2 Paying
1. The page asks the server for an invoice: how many bytes, for how long. The server prices the storage
   with `Nmts.price({ bytes, epochs })`, which needs no account and no file, adds its own margin, and
   converts to XMR at its own rate.
2. The server creates a fresh Monero **subaddress** for this invoice (`create_address` on
   `monero-wallet-rpc`) and stores `{ invoice, user, bytes, epochs, xmr, subaddress }`.
3. The user pays from any Monero wallet. The server watches `get_transfers` for that subaddress and, after
   the number of confirmations it has chosen (ten is the network's own unlock time), marks the invoice paid
   and adds the bought allowance to the ledger row of `user` (`examples/money/monero.mjs`, `ledger.mjs`).
4. The ledger is the only link between a payment and an account, and it is the operator's to protect:
   keep amounts and dates, not addresses of origin (Monero does not give one anyway).

Payment is not converted per invoice. The operator keeps the float funded and converts Monero to WAL and
SUI in batches, however is lawful for them. That conversion is the operator's treasury work; NMTS neither
converts nor holds anybody's coins.

An operator who also takes cards or Bitcoin adds those to the same ledger (`examples/money/stripe.mjs`,
`btcpay.mjs`; BTCPay Server takes Monero and Zcash too, through its plugins).

### 4.3 Uploading
The user's device encrypts and uploads into the user's own account, and the float pays:

1. The page builds a signer whose address is the float and whose `signTransaction` posts the transaction
   to the operator's server with the customer token (`examples/money/remote-signer.mjs`, which runs in a
   page).
2. The page uploads: `await nmts.put({ name, blob }, { pay: { signer } })`. The device builds each
   transaction, and the operator's server signs it.
3. Before it signs, the server checks the ledger (has this user paid for this much?) and then calls
   `ops.sponsor(bytes, limits)`. `sponsor` reads the transaction and signs only if the float is the sender
   and gas owner, every call is a Walrus reservation, registration, certification or extension of the
   network's own package and system object, every coin that leaves has an amount written in the
   transaction and goes to the float or as a tip to an upload relay, and the size, term, WAL and SUI are
   within `limits`. Anything else is refused with a code and a reason, unsigned. The server charges the
   ledger with what `sponsor` measured (`spends`).

On the chain, the float registers and pays for every user's blobs, and nothing moves from the float to a
user's wallet. The operator never sees the file or the key: it signs transactions about encrypted blobs
whose names it cannot read.

The storage belongs to the float's address. The recovery program still opens the user's files from the
NMTS key and a recovery list file (4.5); its own search for a list from the key alone looks only in
wallets the key makes, so it does not find these.

### 4.4 Keeping files alive
Storage on Walrus is bought for a period, and the float owns what it paid for, so the operator keeps it
alive. A daily job on the server mints a token for each paying user with `files_read` and
`storage_spend` and runs `ops.extendFor(token)`: it extends from the float every file near its end whose
storage the float holds, and writes the new end into the user's account, with no user key and no visit
(`examples/money/auto-extend.mjs`). `dryRun: true` prices the run first. The page can also extend on a
visit with `nmts.extend(path, { epochs, pay: { signer } })`, signed through the same check; that token
needs `storage_spend`.

When a user stops paying, mark the ledger row unpaid: the job skips them and the server refuses their
extensions, so their files leave the storage network when the paid term ends. Say so at the moment of
sale, not in the terms alone.

### 4.5 Getting files back, and losing everything
`nmts.list()` and `nmts.get(path)` on the device. A user who loses the NMTS key loses the files: nobody can
reset it, including the operator and NMTS. Say this on the screen that shows the key.

If the operator disappears, the user still holds the key, and the bytes are still on Walrus until their term
ends. What the user needs besides the key is the account's recovery list. The page offers it as a file to
keep: `await nmts.recoveryList()` answers `{ filename, content }`, the same file the NMTS command-line tool
writes, and the standalone NMTS recovery program restores the account from the key and that file, with
neither the operator nor NMTS online.

### 4.6 Deleting
`nmts.erase(paths, { confirm: ERASE_CONFIRM })` on the device, with a token carrying `files_erase`. It is
permanent: the file leaves the account's list for good. Bytes whose storage a wallet bought stay on Walrus,
unreadable without the key, until the term that was bought for them ends.

### 4.7 Sending a file to another user
`nmts.share(path, publicCode)` gives one other NMTS account the key to one file, and `nmts.shares.received()`
and `nmts.shares.get(id)` read what came in. A token needs `share` to send. `nmts.unshare(id)` stops new
downloads and cannot recall a copy already taken.

A share is sent from the account's public code, and the device publishes its own: the first `share()` or
`put(file, { shareWith })` does it, or `nmts.publicCodes.create()`. On a token this takes `share` and the
key's proof, which the device sends to NMTS itself, so the operator, holding only the token, cannot publish,
replace or revoke a user's code.

## 5. Tor
- The operator serves the page and its own API as an onion service; nothing about that involves NMTS.
- The device talks to three other places: NMTS, a Walrus upload relay or the storage nodes, and a Sui node.
  Measured on 2026-09-20 from six Tor circuits: the NMTS API answered every one of them and the Walrus
  mainnet aggregator answered; the default Walrus upload relay and the default Sui full node refused a Tor
  exit (one circuit each).
- In a browser, Tor Browser is the proxy. In Node, pass a `fetch` that goes through Tor (a SOCKS tunnel or a
  proxy agent) in the client's options; every request the SDK and its chain libraries make uses it. `relay`
  and `suiRpc` (one address or a list) name a relay and Sui nodes that accept Tor.

## 6. Threats, and what answers each
| Threat | Answer |
|---|---|
| The operator's server is seized or breached | It holds no key that opens users' files. It holds the ledger, the business key and the float's account: rotate the business key with `business.rotateKey()` (every token the old key signed stops working) and move the float's coins |
| A user's device sends the server a transaction that takes the float's coins | `sponsor` signs only Walrus storage work within the limits, and only coins of written amounts leave |
| The operator serves a page that steals keys | Nothing in the design prevents it: a page can do what its code says. Published release hashes and an open-source page let users check. Say this to users |
| Payments are linked to accounts | Only through the ledger. Keep it small, keep it off the public web server, delete invoices when they are settled |
| Storage payments on the chain are linked to users | The chain shows the float paying for blobs that the float owns. It does not show which account a blob belongs to |
| A user's network address | Tor, by the user's choice. The operator should not log addresses; NMTS stores none in a form that can be reversed |
| Abuse reports and lawful orders | The operator can stop serving an account and stop extending it. It cannot open files. Decide and publish what you do with each before you launch |

## 7. What NMTS still has to gain for this to be built as written
| Gap | What is missing |
|---|---|
| A | an NMTS key computed from a Sui wallet signature with nothing stored on a server (wallet login through a locked server copy works today) |

Shipped since the first edition (2026-09-20): a price with no account (`Nmts.price`), buying storage with
no file (`buyStorage`), the float paying for a user's upload after checking it (`sponsor`) and extending
what it holds without the user's device (`extendFor`), the recovery list in the SDK (`recoveryList`,
`setRecoveryCopy`), a `fetch` option and choosable addresses for Tor, and sharing (`share`), with each
device publishing its own public code.

Copyright © 2026 needmoretruth. This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
