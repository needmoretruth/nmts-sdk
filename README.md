# nmts-sdk

Put, get and list files in an [NMTS](https://nmts.me) account from your own program — end-to-end
encrypted storage on the Walrus network, with the keys on your machine.

> **If you are an AI agent, read [AGENTS.md](AGENTS.md) instead.** It has the cost of each
> method and the refusal codes.
>
> **Status: early.** The interface may still change before 1.0. A method added after this file
> was written is in `dist/index.d.ts`.

## Quickstart

```sh
npm install @needmoretruth/nmts-sdk
```

```js
import { Nmts } from "@needmoretruth/nmts-sdk";

const nmts = Nmts.device({ accountCode: process.env.NMTS_ACCOUNT_CODE, apiKey: process.env.NMTS_API_KEY });
await nmts.put("./report.pdf");                 // spends credits — see "What put() costs"
const bytes = await nmts.get("report.pdf");     // a Uint8Array, checked before it is handed over
console.log(await nmts.list());                 // [{ path: "report.pdf", kind: "file", size: 1234, ... }]
```

Node 22 or newer. Nothing is compiled at install time: the encryption engine is a WebAssembly
module carried by the package this one is built on.

Two things have to exist before the first call, and both are made once, by a person, at
[nmts.me](https://nmts.me): an **account** (its NMTS key is printed once and never again) and an
**API key** for it (on the account screen). Nothing here can make either — see
[What only a person can do](#what-only-a-person-can-do).

## What NMTS is

Storage where **the encryption happens in your process and the keys never leave it.** The server
receives sealed bytes it cannot open. File contents, names and folders all live inside a sealed
list that only the NMTS key opens — which is why `list()` needs it and not just the API key.

The bytes live on **Walrus**, a public storage network, paid for on the **Sui** chain.

- **Storage is bought for a period, not forever.** A file has a lease. It can be extended, and
  NMTS warns before one runs out.
- **There is no password reset.** The NMTS key *is* the account. It cannot be recovered or
  changed while keeping the files.
- **NMTS charges nothing.** Storage is bought from the Walrus network; nothing is paid to NMTS.
  An upload through this package spends **credits** — storage a donation pool has already paid the
  network for, which are not sold and cannot be bought, resold or transferred — or WAL and SUI from
  a wallet: the account's own (`pay: "wallet"`) or one you hold the key to (`pay: { signer }`).

NMTS is built and run by one developer. This package, the command-line tool it is built on, the
encryption engine and the recovery program are open source under Apache-2.0; the server and the
web app are not published.

## Who holds the key

An account is its **NMTS key** (the `accountCode` in this library's calls): the file keys, the wallet and the public code are all derived
from it. Where you make the client, you choose which process holds that key.

| The NMTS key is held by | The client you make | Who can read the files |
|---|---|---|
| the person, on their own machine | `Nmts.device({ accountCode, apiKey })` | only them — not you, not NMTS |
| your service, sealed in a store of your own | `Nmts.managed({ openCode, apiKey })` | your service, and whoever it lets in — not NMTS |
| the person, in a page of yours | `Nmts.device({ accountCode, apiKey })` from `@needmoretruth/nmts-sdk/browser` | only them — but the page's code is yours, so they are as safe as their trust in you |

Every method works the same on a device client and a managed client. A managed client calls `openCode()` once per call on the account and keeps nothing between
calls, so your store stays the one place the NMTS key rests; how you seal it — a cloud key service, a
master key, a hardware module — is yours to decide and nothing here reaches into it.

```js
const nmts = Nmts.managed({ openCode: () => myVault.open(customerId), apiKey: process.env.NMTS_API_KEY });
```

The browser row is the same client as the first: the NMTS key is typed into your page and stays
in the tab's memory, and NMTS never sees it. The difference from the managed row is where the key
passes through, not whether you *could* read the files — a page you serve can do what its code
says. Tell your users that your page's code can read their files.

Which row a product is on is that product's own statement. NMTS does not inspect or certify what
is built with this library, and the server cannot tell the rows apart: the NMTS key never reaches
it. The library comes as the [licence](#licence) says, without warranty.

## Recipes

Runnable files in [`examples/`](examples/), one per shape:

| Shape | File | What it shows |
|---|---|---|
| Node, device | `quickstart.mjs` | put, get and list from a shell with the two credentials in the environment |
| Node, device, wallet-paid | `pay-from-wallet.mjs` | the price with `dryRun`, then an upload paid in WAL and SUI from the account's own wallet, no credits |
| Browser, device | `next-embedded/UploadButton.jsx` | a Next.js client component: a file picker, `put({ name, blob })`, the key never leaves the page |
| Node, managed | `node-managed/server.mjs` | a service holding its customers' keys in a store of its own, `openCode` once per call |
| Node, S3 gateway | `gateway/server.mjs` | a bucket and a key pair per customer, so a Django or Rails storage adapter, rclone or a backup tool stores into that customer's account |

Products one person or a small team could build on this, each with the calls it uses and what is not
in the library yet: [IDEAS.md](IDEAS.md).

## The two credentials

| | What it does | Where it comes from |
|---|---|---|
| **NMTS key** | Opens the files. Derives the wallet. Never leaves the process that holds it. | Printed once when the account is made |
| **API key** | Makes the server answer. Opens nothing. Can be revoked; expires on its own. | The account screen at nmts.me |

The API key is the cheap, revocable thing you hand to a program; the NMTS key is the account. Keep
them apart: a leaked API key is revoked in one click and opens no file, a leaked NMTS key is the
account, for good.

The NMTS key can also be written as a 15-word recovery phrase, from the BIP-39 English or Korean
word list. It is the same key in another form: every call that takes an NMTS key takes the phrase,
and `phraseOf(accountCode, "en" | "ko")` returns the words (new in 0.11.0). The phrase opens the
account exactly as the key does, so it is kept the same way.

### `Nmts.fromEnv()`

A device client whose two credentials come from the same variables the command-line tool reads, in
the same order:

| Variable | Holds | |
|---|---|---|
| `NMTS_ACCOUNT_CODE_FILE` | a **path** to a file holding the NMTS key | preferred |
| `NMTS_ACCOUNT_CODE` | the NMTS key itself | |
| `NMTS_API_KEY_FILE` | a **path** to a file holding the key | preferred |
| `NMTS_API_KEY` | the key itself | |
| `NMTS_SERVER`, `NMTS_NETWORK` | another server; `mainnet` or `testnet` | read by every call |

A variable holding a **path** shows anyone who can read the environment a filename; a variable
holding the **value** shows them the value (`docker inspect` prints the whole environment, and so
do most CI logs). That is why the file form is preferred and why the command-line tool stops once
for an agreement before reading the NMTS key from `NMTS_ACCOUNT_CODE`. This package does not stop —
a library has nobody to ask — so calling `fromEnv()` is that agreement.

```js
const nmts = Nmts.fromEnv();
```

## What `put()` costs

`put()` is the one method that spends.

**Credits, by default** — **one credit per started MiB of sealed bytes**, for the storage period
the account buys uploads for. Credits do not come back.

**The account's own wallet, with `pay: "wallet"`** — WAL buys the storage on the Walrus network and
SUI pays the relay's tip and the chain fees, out of the wallet this account pays from.
`walletAddress()` is where to send coins to fund it, and `wallet: n` pays from another of this key's
wallets for one upload. No credits are touched, and the term is yours:
`epochs` buys that many of the storage network's epochs (two by default), and
`storage: "fit" | "whole" | "<object id>"` uses a storage resource the wallet already holds instead
of buying new storage. Nothing is paid to NMTS on either rail.

**A wallet you hold the key to, with `pay: { signer }`** (new in 0.10.0) — the same WAL and SUI, out
of a wallet this package holds no key to: your user's browser extension, a hardware wallet, a keypair
your service keeps. `signer` is an address and a function that signs transaction bytes; `epochs` and
`storage` work exactly as above, and `wallet: n` is refused, because that names a wallet of the NMTS
key and a call has one payer.

Three things come with it, and they are why it is not the default:

- **Every transaction asks that wallet to sign.** Nothing is approved silently or automatically, and
  nothing can be batched: one part of a file is two signatures — registering the blob, then
  certifying it — so a four-part file asks eight times. The parts are **not** uploaded in parallel
  either; the wallet is asked one transaction at a time, in order. The account's own wallet signs
  without asking anybody, which is why large files are faster on that rail.
- **A file paid for this way is not found from the NMTS key alone.** The storage belongs to the
  signer's address, so the recovery program needs **that address** as well as the key to list what
  was stored. Storage the account's own wallet paid for is derived from the key itself.
- **What that wallet paid for, that wallet extends and reshapes.** `extend()` has to be signed by the
  address that bought the storage — the chain lets nobody else touch it — so pass it the same
  `pay: { signer }`, and the same for `storage`, `splitStorage`, `mergeStorage` and
  `transferStorage`. `erase({ releaseStorage: true })` destroys only storage **credits** bought:
  storage a wallet bought is never touched by it and stays on Walrus until its term ends, whichever
  wallet paid.

In a page, the wallet the person already uses pays — with `@mysten/dapp-kit`, the wiring is the
signer object:

```jsx
import { useCurrentAccount, useSignTransaction } from "@mysten/dapp-kit";
import { toBase64 } from "@mysten/sui/utils";
import { Nmts } from "@needmoretruth/nmts-sdk/browser";

function Upload({ accountCode, apiKey }) {
  const account = useCurrentAccount();
  const { mutateAsync: sign } = useSignTransaction();
  async function upload(file) {
    if (!account) return;                       // nothing is connected: nothing can pay
    const signer = {
      address: account.address,
      // `sign` answers { bytes, signature }, which is what this package takes.
      signTransaction: ({ bytes, chain }) => sign({ transaction: toBase64(bytes), chain }),
    };
    const nmts = Nmts.device({ accountCode, apiKey });
    const price = await nmts.put({ name: file.name, blob: file }, { pay: { signer }, dryRun: true });
    console.log(price.wal, price.sui, price.parts);   // what the wallet will be asked for, and how often
    await nmts.put({ name: file.name, blob: file }, { pay: { signer } });
  }
  return <input type="file" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />;
}
```

On Node, anything that signs fits the same object — a `@mysten/sui` keypair already answers
`{ bytes, signature }`:

```js
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Nmts } from "@needmoretruth/nmts-sdk";

const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);
const signer = {
  address: keypair.toSuiAddress(),
  signTransaction: ({ bytes }) => keypair.signTransaction(bytes),
};

const nmts = Nmts.fromEnv();
await nmts.put("/tmp/report.pdf", { pay: { signer }, epochs: 4 });
```

A wallet that declines — somebody pressed cancel, it is on the other network, it cannot sign this
shape — comes back as a refusal whose message starts with `WALLET_REFUSED`, before anything is
submitted. This package submits the signed transaction itself and reads the chain's effects: a digest
is not a success.

There is no confirmation step on any of the three: calling `put()` is the agreement. `dryRun: true`
answers with the price and spends nothing — on a wallet rail it also reports the address, what the
wallet holds, and a `shortfall` sentence when that is not enough.

A wallet-paid `put()` reads the price, the chain fee and both balances of **the wallet that will
sign** — whichever rail it is — **before the first signature**, and a wallet that is short is refused
there, with both numbers, having signed nothing.

An upload that is interrupted after the storage was bought is finished by the next `put()` of the
same file to the same place, **without spending again**: what was bought is written down on this
machine before the money moves (in the same config directory the command-line tool uses).

## Many wallets from one key

The NMTS key derives a wallet at every number from 0 upwards, and each is a real wallet with an
address of its own. **One of them pays**: `setActiveWallet(n)` says which, and that number rides
inside the account's sealed file list, so the browser, the command-line tool and this package all
pay from the same address afterwards.

`wallets()` asks the chain which of them have been used — the wallets the account has made, plus any
further out holding coins or with a transaction behind them — and stops after twenty unused ones in a
row, where every other wallet's scan stops. A wallet funded past that is not lost: numbers come from
the key, so `walletAddress({ index })` and `put(…, { wallet })` reach any of them directly. Nothing
creates or deletes a wallet, because every wallet a key can derive already exists.

## Methods

```ts
Nmts.device({ accountCode, apiKey, ...options })   // the NMTS key is in this process
Nmts.managed({ openCode, apiKey, ...options })     // the NMTS key is in your store
Nmts.fromEnv(options)                              // device, from the environment — Node only
new Nmts(root, options)                            // a root you built yourself

// options: { server?, network?, aggregators?, relay?, suiRpc?, fetch?, onProgress?, wasmUrl? }
//          — where each one points and what `fetch` is for: "Where it connects" below

await nmts.account()          // { accountId, server, network } — offline
await nmts.walletAddress()    // the Sui address of the wallet this account pays from
await nmts.walletAddress({ index: 2 })   // the address of a wallet you name — offline
await nmts.wallets()          // WalletInfo[]: { index, address, active } — asks the chain
await nmts.setActiveWallet(2) // which of this key's wallets pays, from now on, on this account
await nmts.list()             // Entry[]: { id, path, kind, size, createdAt, updatedAt }, trash left out
await nmts.list({ trash: true })   // the same, with what is in the trash; those entries carry trashedAt
await nmts.mkdir("photos/2026")            // { path, created } — makes missing folders above it too
await nmts.move(["a.pdf", "b.pdf"], "archive")   // { moved: [{ from, to }] } — "/" is the top
await nmts.rename("archive/a.pdf", "first.pdf")  // { from, to }
await nmts.remove("archive/b.pdf")         // { removed } — to the trash, restorable for 30 days
await nmts.restore("archive/b.pdf")        // { restored }
await nmts.erase("old.pdf", { confirm: ERASE_CONFIRM })   // { erased, storage } — for good; nothing undoes it
await nmts.put(file, { name?, to?, partSize?, pay?, wallet?, epochs?, storage?, dryRun?, onStep?, onProgress? })
await nmts.get(path, { maxBytes? })                 // Uint8Array; 256 MiB ceiling unless raised
await nmts.getTo(path, destination, { force? })     // streams to disk, no ceiling — Node only
await nmts.storage({ pay? })                        // [{ id, sizeBytes, startEpoch, endEpoch, status }] — asks the chain
await nmts.extend(path, { epochs?, dryRun?, force?, pay? }) // more storage time for one file — signs and spends WAL
await nmts.splitStorage(id, { sizeBytes, dryRun?, pay? })   // one storage resource into two
await nmts.mergeStorage(idA, idB, { dryRun?, pay? })        // two into one
await nmts.transferStorage(id, toAddress, { dryRun?, pay? }) // to another wallet — cannot be undone

blobSource(blob, name)        // a Blob as an upload's bytes, for a file picker, a drag or a fetch
```

- **Storage control: `storage`, `extend`, `splitStorage`, `mergeStorage`, `transferStorage`.** Storage
  on Walrus is an object a wallet holds, with a size and a period. `storage()` lists the ones the
  account's own wallet holds that are not bound inside a file, and the other four sign with that
  wallet — `pay: { signer }` points all five at a wallet you hold instead, which is the wallet that
  can act on what it paid for. With
  `dryRun: true` each returns a review and signs nothing: `{ wal, sui, wallet: { address, wal, sui },
  shortfall }` in the units `put()` uses, plus what the act would produce. `sui` is `null` when the
  fee could not be measured, never 0. Without `dryRun` the call is the agreement, as with `put()`,
  and it returns the transaction's `digest`. `extend()` spends WAL; splitting, merging and
  transferring pay the chain fee only, so their reviews leave the balances and `shortfall` `null`.
  `extend()` refuses a file that is nowhere near its end unless `force: true`. If the purchase
  succeeds and the server then fails to record the new end, it throws `EXTEND_RECORDED_LATE`: do
  not call it again, the storage is already bought. With a delegation token `extend()` needs
  `storage_spend`, and the client reads the token's scope before anything is signed.
  `transferStorage()` cannot be undone and moves no file: what goes is size and remaining time.

- **`mkdir`, `move`, `rename`, `remove` and `restore` spend nothing.** With a delegation token
  they need the `files_write` scope. `move`, `remove` and `restore` take one path or an array.
- **A name already in use refuses a move, a rename or a restore** with `code: "NAME_TAKEN"`; nothing
  is numbered and nothing is replaced. The other codes are `NOT_FOUND` (nothing at that path, or the
  path names two things), `BAD_NAME` (empty, or a `/` in a name), `NOT_IN_TRASH` and `INTO_ITSELF`
  (a folder moved inside itself).
- **`remove()` is the trash, not erasure.** A folder takes everything under it, and a removed file
  keeps its storage.
- **`erase(paths, { confirm: ERASE_CONFIRM })` erases files for good**, and nothing undoes it: the
  server's record of each file, this account's key to it, and its entry in the file list. A folder
  erases every file under it. `confirm` has to be the exported sentence `ERASE_CONFIRM`
  ("I UNDERSTAND THIS IS PERMANENT") word for word — there is no `true` that stands for it, so the
  code that erases somebody's files says so where it is written. Without it nothing is sent and the
  call refuses with `ERASE_NOT_CONFIRMED`. With `releaseStorage: true` the storage under files paid
  for with credits is destroyed first, and `storage` reports each file; a file whose release failed
  is left whole. Storage bought from the wallet stays on Walrus until its term ends. It returns
  `{ erased, storage }`.

- **`put()` takes** a path (`"./report.pdf"`, Node only), bytes (`{ name, bytes }`), or a `Blob`
  (`{ name, blob }`). A bare `Uint8Array` works too, with `name` in the options.
- **In a browser, import `@needmoretruth/nmts-sdk/browser`.** It exports the same names and the
  same class; what it leaves out is the three things a page has no files for — a path in `put()`,
  `getTo()` and `Nmts.fromEnv()` — and each of those refuses by name rather than failing deeper.
  The account's key stays in the page, the sealed file list is kept in IndexedDB, and `wasmUrl`
  says where the engine's WebAssembly is when a bundler has moved it.

- **Paths** are as `list()` prints them: `photos/2026/cat.jpg`. `to: "photos/2026"` puts a file in
  that folder, which must already exist (`mkdir()` makes it).
- **A name already in use** is numbered — `report (2).pdf` — rather than replacing what is there.
  NMTS keeps no previous versions, so replacing would be permanent loss. The command-line tool's
  `nmts on-collision` setting on this machine can change that to overwrite (the old file goes to
  the trash, restorable for 30 days).
- **What `put()` answers** says `paid: "credits" | "wallet"`. A credit-paid upload reports
  `credits`; a wallet-paid one reports `credits: 0` with `wal` and `sui` — the chains' smallest
  units, FROST and MIST, as decimal strings — and the `endEpoch` its storage runs to. `dryRun: true`
  answers the same shape with `dryRun: true` and no `id`.
- **`get()` refuses rather than returns a half-right file.** A wrong key, a part that will not
  open, a whole-file hash that does not match — none of them produce bytes. `getTo()` writes under
  a temporary name and renames only after the whole file is checked.
- **`network`** must be stated for any server but the public one. The wrong network does not
  error; it finds nothing. `mainnet` and `testnet` are different places.

Every failure is an `NmtsError` with a `nextStep` sentence and an `exitCode` that means the same
as the command-line tool's; a refusal from the server is a `ServerError` carrying the server's own
code. A refusal is not a transient error and must not be retried in a loop.

## Wallet login

```js
const nmts = await Nmts.fromWallet({ sign, address, apiKey });   // or `delegation` in place of apiKey
```

Opens an account with a Sui wallet instead of a typed NMTS key. The wallet signs one fixed message;
that signature finds and opens a copy of the account's NMTS key that the NMTS server keeps locked.
NMTS cannot open the copy and does not learn which wallet it belongs to. What comes back is an
ordinary device client: every method works.

`sign(messageBytes)` answers what the wallet standard answers — `{ signature, bytes }`, or the
serialized signature alone. In a page that is dapp-kit's `useSignPersonalMessage()`. `account`
(default 1) picks which of that wallet's accounts, and `app` makes a key for your product only; both
are inside the signed message. Without `app`, one wallet opens the same account in every product
that asks — say which you chose to your users.

With a delegation token, `delegation` may also be a function. A token is signed for one account id,
and a device that has never seen the account cannot know that id until the wallet has opened it; the
function receives the opened account's public id and answers the token:

```js
const nmts = await Nmts.fromWallet({
  sign, address, app: "your-product",
  delegation: (user) => fetch(`/nmts-token?user=${user}`).then((r) => r.text()),
});
```

| Call | What it does |
|---|---|
| `nmts.openers.list()` | `{ locator, kind, createdAt }[]` — the wallets that open this account |
| `nmts.openers.addWallet({ sign, address, account?, app? })` | attaches a wallet. It is asked to sign **twice**, and the call refuses with `WALLET_NOT_REPEATABLE` unless the two signatures are the same bytes |
| `nmts.openers.remove(locator)` | that wallet stops opening the account from then on. A wallet that opened it before has held the NMTS key |
| `nmts.openers.exportSlot(locator)` | the 62 locked bytes, as a `Uint8Array` — the wallet recovery file the NMTS recovery program opens with a signature, with no server |

A new account is made as before (`Nmts.newAccountCode()`, then `registerWithDelegation`), and the
wallet is attached with `addWallet`. A wallet that signs the same message differently each time is
refused by name: `WALLET_ZKLOGIN`, `WALLET_MULTISIG`, `WALLET_PASSKEY`, `WALLET_UNKNOWN_SCHEME`. A
signature over other bytes than the ones this library built is refused with
`WALLET_SIGNED_OTHER_BYTES`. On a managed client `openers` refuses with `NOT_FOR_MANAGED_ROOT`: your
own store is what opens that account. An account can have up to eight openers (`OPENER_CAP`), and a
wallet that already opens this account or another one at the same account number is refused with
`WALLET_ALREADY_ATTACHED` or `WALLET_OPENS_ANOTHER_ACCOUNT`.

The signature opens the account. This library hands it to the encryption engine and keeps no copy;
do the same in your `sign`.

## What only a person can do

| Step | Who | Where | How often |
|---|---|---|---|
| Make the account | a person | nmts.me | once |
| Make an API key | a person | the account screen at nmts.me | once, and again if it is revoked |
| Pass the check that says a person is here | a person | nmts.me, one short code | every twelve weeks, and only for making further accounts, credits and sharing |
| Get credits into the account | a person | nmts.me — the free trial | once, then as they run out |

## Accounts for your own users (NMTS Platform)

A business registers once, in a browser: **Settings › Developer › Platform** at nmts.me, with the
public half of a key pair made by `nmts platform keygen`. After that its server opens NMTS accounts
for the users of its own product — they never visit nmts.me — up to a daily limit that `info()`
reports. [Terms 3.7](https://nmts.me/terms) applies: before you open an account for a person you
show them the NMTS Privacy Policy and obtain the consent its section 5.6 describes, and your
product is not directed to children.

```js
import { Nmts } from "@needmoretruth/nmts-sdk";

// On your server. The private key signs every request and never leaves this process.
const business = Nmts.business({ accountId, privateKey });

// Managed — you hold the user's NMTS key. It comes back once; seal it in your own store.
const { accountId: user, accountCode } = await business.registerUser();

// Embedded — the user's device holds the key. The device makes it and tells you only its id:
//   const accountCode = await Nmts.newAccountCode();
//   const user = await Nmts.accountIdOf(accountCode);
const token = await business.delegate({
  user,
  scope: ["register", "files_read", "files_write"],
  ttlSecs: 3600,
});
// ...and the device opens its own account and works with the token in place of an API key:
//   await Nmts.registerWithDelegation({ accountCode, delegation: token });
//   const nmts = Nmts.device({ accountCode, delegation: token });
```

| Call | Where it runs | What it does |
|---|---|---|
| `Nmts.business({ accountId, privateKey })` | your server — it refuses in a page (`BUSINESS_IN_A_PAGE`) | the client below; nothing is sent until a method is called |
| `business.info()` | your server | the registered public key, the name, accounts opened today, the daily limit, and `keyChangedAt` — when the key was last replaced, or null |
| `business.registerUser()` | your server | opens an account and returns its new NMTS key, once |
| `business.registerUser({ accountCode })` | your server | opens the account of a code you already hold |
| `business.delegate({ user, scope, ttlSecs })` | your server | signs a delegation token for one of your users; nothing is sent. `ttlSecs` is at most 30 days |
| `business.rotateKey(newPrivateKey)` | your server | replaces the registered key; every token the old key signed stops working at once |
| `Nmts.newAccountCode()` · `Nmts.accountIdOf(code)` | the device | a new NMTS key, and its public id; nothing is sent |
| `Nmts.registerWithDelegation({ accountCode, delegation })` | the device | opens the device's own account with a token that carries `register` |

Scopes are `files_read`, `files_write`, `storage_spend`, `register` and `files_erase`. `erase()` needs
`files_erase`; `files_write` alone is refused. The server also asks for the NMTS key's own proof on
that request, which the client makes from the key it holds — so erasing through a token takes the
business's permission and the key holder's act together. A delegation token takes the
place of `apiKey` in `Nmts.device()` and `Nmts.managed()`, and every method works with it. It
cannot delete the account, make API keys, or reach the key that opens the files; the server refuses
those with `DELEGATION_SCOPE`.

## An S3 gateway you run yourself

`@needmoretruth/nmts-sdk/gateway` is the S3 server behind `nmts s3`, as a function your own server
calls. A storage adapter in Django, Rails or Laravel, a backup tool or an image pipeline that speaks
S3 then reads and writes NMTS accounts with its usual endpoint setting. Node only.

```js
import { createS3Gateway } from "@needmoretruth/nmts-sdk/gateway";

const gateway = createS3Gateway({
  credentials: [{ accessKeyId, secretAccessKey, buckets: ["acme-user-17"] }],
  bucket: async (name) => clientFor(name),   // an Nmts client on any root, or null
  write: true,
});
await gateway.listen(9000);                  // 127.0.0.1 unless you pass a host
// or mount it in a server of your own: https.createServer(tls, gateway.handler)
```

- **A bucket is an account.** `bucket(name)` answers the `Nmts` client for that name, or `null` for
  `NoSuchBucket`. The answer is remembered for a minute (a `null` for five seconds), for at most 256
  names, so taking a user's access away takes up to a minute to show here.
- **`buckets` on a key pair is the wall between your users.** A pair held to named buckets gets
  `AccessDenied` for any other name, with the same answer whether or not that bucket exists. There
  are 1 to 16 pairs; `accessKeyId` is 16 to 128 characters and `secretAccessKey` at least 32, and a
  weaker pair throws `GATEWAY_CREDENTIALS` when the gateway is made.
- **`write` is off unless you turn it on**, and then an upload spends what `put()` spends. A delete
  is `remove()`: the trash, restorable for 30 days. A key that already holds a different file is
  refused with `409`; the same file again is a `200` that sends and spends nothing.
- **Between the S3 client and the gateway the files are not encrypted.** That is what S3 clients
  send. Keep the gateway on loopback or a private network, or mount `handler` behind your own TLS.
- An upload in pieces is kept in `stagingDir` until it completes: by default a folder of the
  gateway's own under the system's temporary directory, readable by your user alone, which `close()`
  removes. `log` gets one line per answered request — method, bucket and status, never a file name.

## Where it connects, and through what

| It talks to | For | Without an option | Option |
|---|---|---|---|
| The NMTS server | the account's records: the file list, credits, keys that wrap keys | `https://nmts.me` | `server` |
| Walrus aggregators | reading stored bytes | the network's public aggregators | `aggregators` — a list |
| The Walrus upload relay | writing stored bytes | the network's relay | `relay` — one host |
| Sui nodes (JSON-RPC) | the chain: paying, extending, storage resources | public nodes, tried in order | `suiRpc` — one host or a list |

A list you give replaces the network's own: nothing you did not name is tried. `relay` and `suiRpc`
take effect on Node and in a page alike (before 0.9.0 they were read only in a page).

`fetch` is the function every one of those requests goes through, including the ones the Walrus and
Sui client libraries make. It is where a proxy goes. This package carries no proxy code of its own:

```js
// npm install undici — an HTTP proxy, or Tor's own HTTP tunnel (`HTTPTunnelPort 9080` in torrc)
import { fetch as undiciFetch, ProxyAgent } from "undici";

const dispatcher = new ProxyAgent("http://127.0.0.1:9080");
const nmts = Nmts.device({
  accountCode, apiKey,
  fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }),
});
```

Checked on 2026-09-20 with Tor 0.4.9 and undici 8 on Node 24: with the runtime's own `fetch`
replaced by a function that throws, a wallet sign-in reached nmts.me through the tunnel and nothing
else was called. Whether the public Walrus relay and the public Sui nodes accept a Tor exit is theirs
to decide — name your own with `relay` and `suiRpc` if they refuse.

Two things to know before relying on it:

- **These choices are one per process, not one per client.** The last client that names an option
  sets it for every client in the process, so two clients cannot use two different proxies.
- **In a page, two one-time downloads do not go through `fetch`:** the engine's WebAssembly file
  (`wasmUrl`) and the zstd encoder's. They are static files and carry nothing about an account.
  On Node neither is downloaded.

## Limits

- **A business may build its own product on NMTS.** [Terms 3.7](https://nmts.me/terms) covers it:
  the business registers its account, opens accounts for the people who use its product, and
  answers to NMTS for what its product does in them. Read that section before you ship.
- **Credits are not for resale.** They cannot be bought, sold, transferred or exchanged for anything.
  A product built on NMTS pays for its own storage with `pay: "wallet"` — your coins, on the Sui
  chain, with NMTS never in the money path.
- **Nothing here puts coins into the wallet.** `walletAddress()` says where they go; sending them,
  and exchanging SUI for WAL, are the browser's and the command-line tool's.
- **A gift to the developer is never automated.** Sending one is a person's act, every time.
- **One account, one list.** Everything in an account is one sealed list, and every edit rewrites
  it. The ceiling is 16 MiB sealed — about 60,000 files. Past that, use more accounts.
- **Rate and spend ceilings** exist on the server: one account may spend 4,096 credits (4 GiB) a
  day, and a person must pass the human check every twelve weeks for the things it gates.
- **Sharing and the recovery list** are in the
  [command-line tool](https://github.com/needmoretruth/nmts-cli) as commands (`nmts share`,
  `nmts recovery-list`), not in this package, and that tool does not export them as library calls
  yet. Both are planned for this package.


## Building from source

```sh
git clone https://github.com/needmoretruth/nmts-sdk && cd nmts-sdk
npm install
npm test
npm run compile   # dist/, with type declarations
```

Inside the NMTS source tree the dependency on the command-line package is the sibling `cli/`
checkout; the published package pins a released version instead.

## Built on this?

If you built something on this — a service, an app, a port — you owe us nothing: Apache-2.0 asks
for the notices and nothing more. We would still like to know. Write to **nmts@nmts.me**.

## Licence

Apache-2.0 — the full text is in [LICENSE](LICENSE). If you need different terms, write to **nmts@nmts.me** and say why — see
[LICENSING.md](LICENSING.md).

Copyright © 2026 needmoretruth.
