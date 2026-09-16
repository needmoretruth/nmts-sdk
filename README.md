# nmts-sdk

Put, get and list files in an [NMTS](https://nmts.me) account from your own program — end-to-end
encrypted storage on the Walrus network, with the keys on your machine.

> **If you are an AI agent, read [AGENTS.md](AGENTS.md) instead.** It says the same things in the
> order a program needs them.
>
> **Status: early.** The interface may still change before 1.0. The types are the current truth
> about what exists.

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
[nmts.me](https://nmts.me): an **account** (its code is printed once and never again) and an
**API key** for it (on the account screen). Nothing here can make either — see
[What only a person can do](#what-only-a-person-can-do).

## What NMTS is

Storage where **the encryption happens in your process and the keys never leave it.** The server
receives sealed bytes it cannot open. File contents, names and folders all live inside a sealed
list that only the account code opens — which is why `list()` needs the code and not just the key.

The bytes live on **Walrus**, a public storage network, paid for on the **Sui** chain. Three
things to know:

- **Storage is bought for a period, not forever.** A file has a lease. It can be extended, and
  NMTS warns before one runs out.
- **There is no password reset.** The account code *is* the account. It cannot be recovered or
  changed while keeping the files.
- **NMTS charges nothing.** Storage is bought from the Walrus network; nothing is paid to NMTS.
  An upload through this package spends **credits** — storage a donation pool has already paid the
  network for, which are not sold and cannot be bought, resold or transferred — or, with
  `pay: "wallet"`, WAL and SUI from the account's own wallet.

NMTS is built and run by one developer. This package, the command-line tool it is built on, the
encryption engine and the recovery program are open source under Apache-2.0; the server and the
web app are not published.

## Who holds the key

An account is its **account code**: the file keys, the wallet and the public code are all derived
from it. So there is one question to answer, and you answer it once, where you make the client —
which process holds that code.

| The code is held by | The client you make | Who can read the files |
|---|---|---|
| the person, on their own machine | `Nmts.device({ accountCode, apiKey })` | only them — not you, not NMTS |
| your service, sealed in a store of your own | `Nmts.managed({ openCode, apiKey })` | your service, and whoever it lets in — not NMTS |

Every method works the same on both, and this package has no method that works on one and not the
other. A managed client calls `openCode()` once per call on the account and keeps nothing between
calls, so your store stays the one place the code rests; how you seal it — a cloud key service, a
master key, a hardware module — is yours to decide and nothing here reaches into it.

```js
const nmts = Nmts.managed({ openCode: () => myVault.open(customerId), apiKey: process.env.NMTS_API_KEY });
```

## The two credentials

| | What it does | Where it comes from |
|---|---|---|
| **account code** | Opens the files. Derives the wallet. Never leaves the process that holds it. | Printed once when the account is made |
| **API key** | Makes the server answer. Opens nothing. Can be revoked; expires on its own. | The account screen at nmts.me |

They are two on purpose. The key is the cheap, revocable thing you hand to a program; the code is
the account. Keep them apart: a leaked key is revoked in one click and opens no file, a leaked code
is the account, for good.

### `Nmts.fromEnv()`

A device client whose two credentials come from the same variables the command-line tool reads, in
the same order:

| Variable | Holds | |
|---|---|---|
| `NMTS_ACCOUNT_CODE_FILE` | a **path** to a file holding the code | preferred |
| `NMTS_ACCOUNT_CODE` | the code itself | |
| `NMTS_API_KEY_FILE` | a **path** to a file holding the key | preferred |
| `NMTS_API_KEY` | the key itself | |
| `NMTS_SERVER`, `NMTS_NETWORK` | another server; `mainnet` or `testnet` | read by every call |

A variable holding a **path** shows anyone who can read the environment a filename; a variable
holding the **value** shows them the value (`docker inspect` prints the whole environment, and so
do most CI logs). That is why the file form is preferred and why the command-line tool stops once
for an agreement before reading the code from `NMTS_ACCOUNT_CODE`. This package does not stop —
a library has nobody to ask — so calling `fromEnv()` is that agreement.

```js
const nmts = Nmts.fromEnv();
```

## What `put()` costs

`put()` is the one method that spends, and there are two things it can spend.

**Credits, by default** — **one credit per started MiB of sealed bytes**, for the storage period
the account buys uploads for. Credits do not come back.

**The account's own wallet, with `pay: "wallet"`** — WAL buys the storage on the Walrus network and
SUI pays the relay's tip and the chain fees, out of the wallet this account pays from.
`walletAddress()` is where to send coins to fund it, and `wallet: n` pays from another of this key's
wallets for one upload. No credits are touched, and the term is yours:
`epochs` buys that many of the storage network's epochs (two by default), and
`storage: "fit" | "whole" | "<object id>"` uses a storage resource the wallet already holds instead
of buying new storage. Nothing is paid to NMTS on either rail.

There is no confirmation step on either: calling `put()` is the agreement. `dryRun: true` answers
with the price and spends nothing — on the wallet rail it also reports the address, what the wallet
holds, and a `shortfall` sentence when that is not enough.

A wallet-paid `put()` reads the price, the chain fee and both balances **before the first
signature**, and a wallet that is short is refused there, with both numbers, having signed nothing.

An upload that is interrupted after the storage was bought is finished by the next `put()` of the
same file to the same place, **without spending again**: what was bought is written down on this
machine before the money moves (in the same config directory the command-line tool uses).

## Many wallets from one key

The account code derives a wallet at every number from 0 upwards, and each is a real wallet with an
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
Nmts.device({ accountCode, apiKey, server?, network?, aggregators? })   // the code is in this process
Nmts.managed({ openCode, apiKey, server?, network?, aggregators? })     // the code is in your store
Nmts.fromEnv({ server?, network?, aggregators? })                       // device, from the environment
new Nmts(root, { server?, network?, aggregators? })                     // a root you built yourself

await nmts.account()          // { accountId, server, network } — offline
await nmts.walletAddress()    // the Sui address of the wallet this account pays from
await nmts.walletAddress({ index: 2 })   // the address of a wallet you name — offline
await nmts.wallets()          // WalletInfo[]: { index, address, active } — asks the chain
await nmts.setActiveWallet(2) // which of this key's wallets pays, from now on, on this account
await nmts.list()             // Entry[]: { id, path, kind, size, createdAt, updatedAt }, trash left out
await nmts.put(file, { name?, to?, partSize?, pay?, wallet?, epochs?, storage?, dryRun?, onStep?, onProgress? })
await nmts.get(path, { maxBytes? })                 // Uint8Array; 256 MiB ceiling unless raised
await nmts.getTo(path, destination, { force? })     // streams to disk, no ceiling, will not overwrite
```

- **Paths** are as `list()` prints them: `photos/2026/cat.jpg`. `to: "photos/2026"` puts a file in
  that folder, which must already exist (make folders in the browser or with `nmts mkdir`).
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

## What only a person can do

| Step | Who | Where | How often |
|---|---|---|---|
| Make the account | a person | nmts.me | once |
| Make an API key | a person | the account screen at nmts.me | once, and again if it is revoked |
| Pass the check that says a person is here | a person | nmts.me, one short code | every four weeks, and only for making further accounts, credits and sharing |
| Get credits into the account | a person | nmts.me — the free trial | once, then as they run out |

## Limits, honestly

- **Organisations may use NMTS through a person who holds the account code, from terms version 13.**
  Until that version is in force, the terms offer the service to individuals for personal use. Read
  the [terms](https://nmts.me/terms) before building a product on this.
- **Credits are not for resale.** They cannot be bought, sold, transferred or exchanged for anything.
  A product built on NMTS pays for its own storage with `pay: "wallet"` — your coins, on the Sui
  chain, with NMTS never in the money path.
- **Nothing here puts coins into the wallet.** `walletAddress()` says where they go; sending them,
  and exchanging SUI for WAL, are the browser's and the command-line tool's.
- **A gift to the developer is never automated.** Sending one is a person's act, every time.
- **One account, one list.** Everything in an account is one sealed list, and every edit rewrites
  it. The ceiling is 16 MiB sealed — about 60,000 files. Past that, use more accounts.
- **Rate and spend ceilings** exist on the server: one account may spend 4,096 credits (4 GiB) a
  day, and a person must pass the human check every four weeks for the things it gates.
- **Sharing, folders, renaming, the trash, extension and the recovery list** are not in this
  package yet. The [command-line tool](https://github.com/needmoretruth/nmts-cli) has them all, and
  this package is built on its library surface (`@needmoretruth/nmts-cli`), so they can be reached
  from there today.

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

Apache-2.0 — the full text is in [LICENSE](LICENSE). Build on it, ship it, sell what you build
with it. If you need different terms, write to **nmts@nmts.me** and say why — see
[LICENSING.md](LICENSING.md).

Copyright © 2026 needmoretruth.
