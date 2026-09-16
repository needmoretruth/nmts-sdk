// The wallets one NMTS key opens: what `wallets()` finds, what `setActiveWallet()` moves, and
// which of them a wallet-paid `put()` signs with.
//
// ⛔ WHAT THESE ARE WRITTEN TO CATCH, AND ALL THREE FAIL QUIETLY. A walk that stops one wallet too
//    early reports a funded wallet as one that does not exist. A number written to the wrong place
//    pays from one address on one device and another on the next. And an upload that priced one
//    wallet and signed with another spends from a balance nobody was shown. Nothing throws in any
//    of the three — a number is simply wrong — so each is driven here with a chain that answers
//    from a table and a sealed list this test wrote itself.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT. Which wallet pays is the ACCOUNT's, so it must read and
//    write the same whether the key is in this process or in a business's sealed store; the
//    registry in `roots.ts` runs each one both ways and counts how often the key is taken out.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { NmtsError, walletAddress, type ChainReader, type Network } from "@needmoretruth/nmts-cli";

import { SUI_COIN_TYPE } from "../../cli/src/wallet.ts";
import { Nmts } from "../src/index.ts";
import { bytesSource } from "../src/put.ts";
import { putSourceWithWallet } from "../src/put-wallet.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { setActiveWallet, wallets, type WalletReads } from "../src/wallets.ts";
import { generateCode, KEY, startFakeDrive, walletSeams, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

/** Ten bytes — the one file the wallet rail sends here. */
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/**
 * A chain that holds SUI at these addresses and answers zero everywhere else, and remembers every
 * address it was opened for — which is how far the walk went.
 */
function chainOf(held: Readonly<Record<string, bigint>>): {
  opened: string[];
  reads: WalletReads;
} {
  const opened: string[] = [];
  return {
    opened,
    reads: {
      openChain(_network: Network, address: string): ChainReader {
        opened.push(address);
        return {
          async totalOf(coinType: string): Promise<bigint> {
            return coinType === SUI_COIN_TYPE ? (held[address] ?? 0n) : 0n;
          },
          // Both coin types are real on this chain, so a zero here is a zero (`wallet.ts`).
          async knowsCoinType(): Promise<boolean> {
            return true;
          },
        };
      },
      // A wallet with no balance and no transaction is one nobody has used.
      hasHistory: async (): Promise<boolean> => false,
    },
  };
}

for (const { name, root, opens } of rootsUnderTest()) {
  /** This sandbox's account, opened with the key wherever this root keeps it. Resets the count. */
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
  const client = (code: string): Nmts =>
    new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] wallets() lists the ones this account made, plus a funded one past them, and marks the payer`, async () => {
    await withSandbox(drive, `sdk-wallets-list-${name}`, async (code) => {
      await drive.serve(code, []);
      await setActiveWallet(account(code), 1);
      const far = await walletAddress(code, 4);
      const chain = chainOf({ [far]: 7n });

      const opened = account(code);
      const rows = await wallets(opened, chain.reads);

      // Wallets 0 and 1 because the account has made two; wallet 4 because it holds coins. None of
      // the empty ones between or beyond, which nobody has asked for.
      assert.deepEqual(
        rows.map((row) => row.index),
        [0, 1, 4],
      );
      assert.equal(rows[2]?.address, far);
      assert.equal(rows[0]?.address, await walletAddress(code, 0));
      assert.deepEqual(
        rows.filter((row) => row.active).map((row) => row.index),
        [1],
        "the wallets screen has to say which one pays, and say it about exactly one of them",
      );
      // The walk went twenty past the last wallet it found, and then stopped.
      assert.equal(chain.opened.length, 25, "the walk did not stop where the gap says it stops");
      assert.equal(opens(), 1, "one reading of the wallets took the key out more than once");
    });
  });

  test(`[${name}] setActiveWallet moves which wallet pays, takes the count up with it, and says so twice`, async () => {
    await withSandbox(drive, `sdk-wallets-use-${name}`, async (code) => {
      await drive.serve(code, []);
      const nmts = client(code);

      const moved = await nmts.setActiveWallet(2);
      assert.deepEqual([moved.index, moved.changed], [2, true]);
      assert.equal(moved.address, await walletAddress(code, 2));

      // ⛔ AND THE NEXT READ AGREES. The number went into the sealed list, so asking the account
      //    which address pays now answers the wallet that was just named — on any device.
      assert.equal(await nmts.walletAddress(), await walletAddress(code, 2));
      assert.equal(await nmts.walletAddress({ index: 0 }), await walletAddress(code, 0));

      // The count came up to hold it: three wallets are listed where one was.
      const rows = await wallets(account(code), chainOf({}).reads);
      assert.deepEqual(
        rows.map((row) => row.index),
        [0, 1, 2],
      );
      // ⛔ SAYING IT AGAIN WRITES NOTHING. A version bump every other device downloads is not free.
      assert.equal((await nmts.setActiveWallet(2)).changed, false, "an unchanged choice was written again");
    });
  });

  test(`[${name}] ⛔ a wallet-paid put signs with the wallet the account pays from`, async () => {
    await withSandbox(drive, `sdk-wallets-put-${name}`, async (code) => {
      await drive.serve(code, []);
      await setActiveWallet(account(code), 1);
      const paying = await walletAddress(code, 1);

      // The review names the address that will sign, before anything is signed.
      const dry = walletSeams();
      const review = await putSourceWithWallet(
        account(code),
        bytesSource(BYTES),
        "notes.txt",
        { pay: "wallet", dryRun: true },
        dry.seams,
      );
      assert.equal(review.dryRun, true);
      if (!review.dryRun) return;
      assert.equal(review.wallet.address, paying, "the review priced a wallet the account does not pay from");

      // And the run itself signs with that number, for every part of the file.
      const run = walletSeams();
      const result = await putSourceWithWallet(
        account(code),
        bytesSource(BYTES),
        "notes.txt",
        { pay: "wallet", partSize: 4 },
        run.seams,
      );
      assert.equal(result.dryRun, false);
      assert.ok(run.sign.registered.length > 1, "one part cannot show that every part signs the same way");
      assert.deepEqual(
        [...new Set(run.sign.registered.map((asked) => asked.wallet))],
        [1],
        "a part was signed by a wallet the account does not pay from",
      );
    });
  });

  test(`[${name}] ⛔ a number that is not a wallet number, and an account with no list, are refused`, async () => {
    await withSandbox(drive, `sdk-wallets-refuse-${name}`, async (code) => {
      const opened = account(code);
      for (const asked of [1.5, -1, 2 ** 31]) {
        const failure = await setActiveWallet(opened, asked).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof NmtsError, `wallet ${asked} was accepted`);
        assert.equal(failure.exitCode, 2);
      }
      // ⛔ REFUSED BEFORE ANYTHING WAS OPENED: a business's sealed store is not unsealed for a call
      //    that was never going to run.
      assert.equal(opens(), 0, "a number that is not a wallet number took the key out");

      // The setting lives inside the list, so an account that has none has nowhere to put it.
      const failure = await setActiveWallet(account(code), 1).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof NmtsError);
      assert.equal(failure.exitCode, 4);
      assert.match(String(failure.nextStep), /Upload once/);
      assert.deepEqual(drive.written, [], "an account with no list had one written for it");
    });
  });

  test(`[${name}] ⛔ a list that cannot be read refuses rather than answering the first wallet`, async () => {
    await withSandbox(drive, `sdk-wallets-unread-${name}`, async (code) => {
      // The server is holding a list this account's key does not open, so the number that says
      // which wallet pays cannot be read at all.
      await drive.serve(await generateCode(), []);
      const nmts = client(code);
      const failure = await nmts.walletAddress().then(
        () => null,
        (error: unknown) => error,
      );
      // ⛔ AN ADDRESS NOBODY CHOSE IS WHERE COINS GO MISSING. "Wallet 0" is not an answer to "which
      //    wallet does this account pay from" when nobody could read the answer.
      assert.ok(failure instanceof NmtsError, "an unreadable list produced an address anyway");
      // Naming a wallet still works: numbers come from the key, and that one asks nobody anything.
      assert.equal(await nmts.walletAddress({ index: 0 }), await walletAddress(code, 0));
    });
  });
}
