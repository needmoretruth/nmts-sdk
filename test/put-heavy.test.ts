// `put(file, { tier: "heavy" })`: which options reach which payer, and that every payer works
// whoever holds the NMTS key.
//
// ⛔ EVERY TEST RUNS THROUGH EVERY ROOT, as `put.test.ts` does: a Heavy payer that worked for the key
//    in this process and not for a business's sealed store would be a feature one key holder lacks.
//
// ⚠ WHAT THEY DO NOT PROVE. No order opens and no storage company is reached: dry runs stop before
//   either, and the one real run pays through a fake Synapse SDK. What the order runner and the
//   Synapse road do with real answers is held in the command-line package's `put-heavy.test.ts`.

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { evmAccountFor, evmAddressFor, NmtsError, walletAddress } from "@needmoretruth/nmts-cli/portable";

import { Nmts } from "../src/nmts.ts";
import { bytesSource } from "../src/put.ts";
import { putHeavy } from "../src/put-heavy.ts";
import { openAccount, type Opened } from "../src/session.ts";
import { KEY, startFakeDrive, withSandbox, type FakeDrive } from "./helpers.ts";
import { rootsUnderTest } from "./roots.ts";

let drive: FakeDrive;
before(async () => {
  drive = await startFakeDrive();
});
after(() => drive.close());

const BYTES = new TextEncoder().encode("heavy bytes");
const PIECE = "bafkzcibcaapc5vqvdtwpobrgygptm2qoktlo7ms6vmt3pjxfbrryptvhvvqwlly";

function refused(pattern: RegExp) {
  return (e: unknown) => e instanceof NmtsError && e.exitCode === 2 && pattern.test(e.message);
}

for (const { name, root } of rootsUnderTest()) {
  const account = (code: string): Opened =>
    openAccount(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });
  const client = (code: string): Nmts => new Nmts(root({ accountCode: code, apiKey: KEY }), { server: drive.base, network: "testnet" });

  test(`[${name}] a dry run on each payer names what it would spend and who pays, and opens nothing`, async () => {
    await withSandbox(drive, `sdk-heavy-dry-${name}`, async (code) => {
      const bytes = { name: "h.txt", bytes: BYTES };
      const credits = await client(code).put(bytes, { tier: "heavy", dryRun: true });
      assert.deepEqual([credits.tier, credits.paid, credits.dryRun], ["heavy", "credits", true]);
      assert.ok(credits.credits > 0 && credits.sealedBytes >= 127);
      const wallet = await client(code).put(bytes, { tier: "heavy", pay: "wallet", days: 90, dryRun: true });
      assert.deepEqual([wallet.paid, wallet.credits, wallet.payer, wallet.days], ["wallet", 0, await walletAddress(code, 0), 90]);
      const evm = await client(code).put(bytes, { tier: "heavy", pay: "evm", evmWallet: 2, copies: 3, dryRun: true });
      assert.deepEqual([evm.paid, evm.payer, evm.copies], ["evm", await evmAddressFor(code, 2), 3]);
    });
  });

  test(`[${name}] a business's own EVM account pays through Synapse, and the file is named in the list`, async () => {
    await withSandbox(drive, `sdk-heavy-signer-${name}`, async (code) => {
      // Any viem account that signs is a business's own; this one is derived only to have one.
      const signer = await evmAccountFor(code, 7);
      const asked: { copies: number; providerIds?: bigint[] }[] = [];
      const committed: { paidBy?: string | undefined }[] = [];
      const result = await putHeavy(
        account(code),
        bytesSource(BYTES),
        "h.txt",
        { tier: "heavy", pay: { signer }, copies: 3, providers: [4, 9] },
        {
          synapse: {
            async upload(_bytes, options) {
              asked.push({ copies: options.copies, ...(options.providerIds === undefined ? {} : { providerIds: options.providerIds }) });
              return { pieceCid: PIECE, copies: [{ providerId: 4n, dataSetId: 1n, pieceId: 2n, retrievalUrl: `https://a.example/piece/${PIECE}` }] };
            },
            async runway() {
              return { epoch: 1_000n, runwayInEpochs: 2_000n };
            },
          },
          commit: async (input) => {
            committed.push({ paidBy: input.paidBy });
            return "item-h";
          },
        },
      );
      assert.deepEqual(asked, [{ copies: 3, providerIds: [4n, 9n] }]);
      assert.deepEqual(committed, [{ paidBy: signer.address }]);
      assert.equal(result.dryRun, false);
      assert.ok(!result.dryRun);
      assert.deepEqual([result.id, result.paid, result.paidBy, result.expiryEpoch, result.orderId], ["item-h", "evm", signer.address, 1_000 + 2_000 + 86_400, null]);
      const written = await drive.lastWritten(code);
      assert.equal(written.find((e) => e.name === "h.txt")?.id, "item-h");
    });
  });

  test(`[${name}] ⛔ an option the tier or payer would ignore is refused before the key is opened`, async () => {
    await withSandbox(drive, `sdk-heavy-refuse-${name}`, async (code) => {
      const bytes = { name: "h.txt", bytes: BYTES };
      const nmts = client(code);
      const evmAccount = await evmAccountFor(code, 7);
      const suiSigner = { address: `0x${"7".repeat(64)}`, signTransaction: async () => ({ bytes: "", signature: "" }) };
      const standardWithCopies = { name: "h.txt", copies: 3 };
      // A Sui signer's shape carrying an EVM account's address and typed-data signer: what Standard refuses.
      const standardWithEvm = { pay: { signer: { ...suiSigner, address: evmAccount.address, signTypedData: evmAccount.signTypedData } } };
      const heavyWithEpochs = { tier: "heavy" as const, epochs: 3 };
      await assert.rejects(nmts.put(bytes, standardWithCopies), refused(/copies/));
      await assert.rejects(nmts.put(bytes, heavyWithEpochs), refused(/epochs/));
      const heavyWithThumbnail = { tier: "heavy" as const, thumbnail: BYTES };
      await assert.rejects(nmts.put(bytes, heavyWithThumbnail), refused(/thumbnail/));
      await assert.rejects(nmts.put(bytes, { tier: "heavy", pay: "wallet", copies: 3 }), refused(/copies/));
      await assert.rejects(nmts.put(bytes, { tier: "heavy", evmWallet: 1 }), refused(/evmWallet/));
      // ⚠ The two casts below are a JavaScript caller's values, which the types refuse at compile
      //   time; what is tested is that the running code refuses them too.
      await assert.rejects(nmts.put(bytes, { tier: "fast" as "heavy" }), refused(/"standard" or "heavy"/));
      await assert.rejects(nmts.put(bytes, standardWithEvm), refused(/EVM account/));
      await assert.rejects(nmts.put(bytes, { tier: "heavy", pay: { signer: suiSigner } } as { tier: "heavy" }), refused(/EVM account/));
    });
  });
}
