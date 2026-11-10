// The public surface is what the README promises, no more and no less.
//
// ⛔ A METHOD THE README NAMES AND THE PACKAGE LACKS is the failure a coding agent hits first: it
//    reads the document, writes the call, and the call is not there. The list below is read from
//    the README's own code block, so the two cannot drift apart without this going red.

import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as sdk from "../src/index.ts";

const here = join(import.meta.dirname, "..");

/** Every code file under `examples/`, however deep. */
function recipes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(mjs|js|jsx|ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("the package exports one class, and its methods are the ones the README shows", () => {
  // ⛔ THE RECIPES ARE HELD TO THE SAME PROMISE. A file under `examples/` is what a developer
  //    copies first, so a method it calls that the class lacks is the README failure with a worse
  //    first impression.
  const shown = new Set<string>();
  const sources = [join(here, "README.md"), join(here, "AGENTS.md"), ...recipes(join(here, "examples"))];
  for (const file of sources) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bnmts\.(\w+)\(/g)) shown.add(m[1]);
  }
  assert.ok(shown.size >= 3, "the README shows no calls");
  const proto = Object.getOwnPropertyNames(sdk.Nmts.prototype).filter((n) => n !== "constructor");
  for (const name of shown) assert.ok(proto.includes(name), `README calls nmts.${name}() and the class has no such method`);
  assert.deepEqual(proto.sort(), [
    "account",
    "allLinks",
    "erase",
    "extend",
    "get",
    "getTo",
    "list",
    "listLinks",
    "makeLink",
    "mergeStorage",
    "mkdir",
    "move",
    // ⚠ A GETTER RATHER THAN A METHOD, and it is on this list for the same reason the methods are:
    //   `nmts.openers` is part of what the README promises, and a promise nothing checks drifts.
    "openers",
    // ⚠ A getter too, for the same reason: the README shows `nmts.publicCodes.list()` and its three siblings.
    "publicCodes",
    "put",
    "recoveryCopy",
    "recoveryList",
    "remove",
    "rename",
    "restore",
    "revokeAllLinks",
    "revokeLink",
    "setActiveWallet",
    "setRecoveryCopy",
    "splitStorage",
    "storage",
    "transferStorage",
    "walletAddress",
    "wallets",
  ]);
  // The three ways to say who holds the key. `fromEnv` is `device` with the credentials read for you.
  for (const maker of ["device", "managed", "fromEnv"]) {
    assert.equal(typeof Reflect.get(sdk.Nmts, maker), "function", `Nmts.${maker}() is not there`);
  }
  assert.equal(typeof sdk.deviceRoot, "function");
  assert.equal(typeof sdk.managedRoot, "function");
});

/** An English number word, as AGENTS.md writes a count. */
function numberWord(n: number): string {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (n < 20) return ones[n] ?? String(n);
  const t = tens[Math.floor(n / 10)] ?? String(n);
  return n % 10 === 0 ? t : `${t}-${ones[n % 10] ?? ""}`;
}

test("AGENTS.md lists every method and getter the class has, under the count it says", () => {
  // ⛔ THE LIST IN PROSE IS A PROMISE TOO. It said "nineteen", then "twenty-two", while links,
  //    openers and public codes had shipped beside it: a coding agent reading it was told those
  //    did not exist. Nothing compared the sentence with the class, so it drifted with every verb.
  const text = readFileSync(join(here, "AGENTS.md"), "utf8");
  const m = /There are ([a-z-]+) methods: ([^;]+); two getters, ([^;]+);/.exec(text);
  assert.ok(m !== null, "AGENTS.md lost the sentence that lists the methods");
  const names = (part: string): string[] => [...part.matchAll(/`(\w+)`/g)].map((x) => x[1] ?? "");
  const methods = names(m[2] ?? "");
  const listed = [...methods, ...names(m[3] ?? "")].sort();
  const proto = Object.getOwnPropertyNames(sdk.Nmts.prototype).filter((n) => n !== "constructor").sort();
  assert.deepEqual(listed, proto);
  assert.equal(m[1], numberWord(methods.length), "the count in the sentence is not the number of methods it lists");
});

/**
 * ⛔ A VERB THAT IS NOT WALKED THROUGH EVERY ROOT IS THE DEFECT THE KEY-HOLDER LAW IS ABOUT. Every
 *    feature has to work the same whether a person holds the account's key or a business holds it
 *    for them, and the only way a machine can hold that is to run each verb through each root. So
 *    the rule is read off the FILES: a verb file in `src/` whose test does not call
 *    `rootsUnderTest()` fails this, by name, on the day it is written rather than on the day
 *    somebody tries it the other way.
 *
 * ⚠ THE EXEMPT LIST IS THE PLUMBING, AND IT IS SHORT ON PURPOSE. Anything not named here is a
 *   verb, so a new file joins the rule by default — forgetting is red, not silent. `index` is the
 *   surface, `nmts` is the client that holds the verbs and does none of them (each one it calls is
 *   judged below), `root` and `session` are where the key and the address live, `env` reads the
 *   environment and `product` is four constants.
 */
const NOT_VERBS = new Set([
  "index",
  "nmts",
  "root",
  "session",
  "env",
  "product",
  // ⛔ `business` IS NOT A VERB ON AN ACCOUNT, so there is no root to walk it through: it is a
  //    business speaking for ITSELF with its own signing key, which opens no file and holds no
  //    account code. The axis it does have — which credential a call carries — is walked by every
  //    verb through the registry's third row, and `business.test.ts` judges the doors themselves.
  "business",
  // The browser entry and what it registers. `browser` is the second surface, `host-browser`,
  // `host-options`, `state-idb` and `state-memory` are the host behind it, and `node-seams` is the
  // register the Node entry fills. None of them is a verb, and each is judged by its own test.
  "browser",
  "host-browser",
  "host-options",
  "node-seams",
  "state-idb",
  "state-memory",
  // ⛔ `pay` IS NOT A VERB EITHER: it is WHO PAYS — the shape of a wallet a caller holds, the address
  //    judged before anything opens, and the three seams a signature travels through. It touches no
  //    account and no root, and the verbs that use it are walked through every root by
  //    `put-wallet.test.ts`, `put-external-signer.test.ts` and `storage.test.ts`.
  "pay",
]);

test("every verb file has a test that walks it through every root", () => {
  const verbs = readdirSync(join(here, "src"))
    // ⚠ A `.d.ts` is declarations, not a module: there is nothing in it to walk through a root.
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => f.slice(0, -".ts".length))
    .filter((n) => !NOT_VERBS.has(n));
  assert.ok(verbs.length >= 4, `only ${verbs.length} verb files were found, so nothing was judged`);
  for (const verb of verbs) {
    const spec = join(here, "test", `${verb}.test.ts`);
    assert.ok(existsSync(spec), `src/${verb}.ts is a verb and test/${verb}.test.ts does not exist`);
    assert.match(
      readFileSync(spec, "utf8"),
      /rootsUnderTest\(\)/,
      `test/${verb}.test.ts does not run ${verb} through rootsUnderTest(), so one key holder is untested`,
    );
  }
});

test("the version the code says is the version the manifest says", () => {
  const manifest: unknown = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null);
  assert.equal(Reflect.get(manifest, "version"), sdk.VERSION);
  assert.equal(Reflect.get(manifest, "name"), sdk.SDK_NAME);
});

test("the errors are the command-line package's own, so a program can tell them apart", () => {
  const error = new sdk.NmtsError("x", { exitCode: 4, nextStep: "y" });
  assert.equal(error.exitCode, 4);
  assert.equal(error.nextStep, "y");
  assert.ok(sdk.ServerError.prototype instanceof sdk.NmtsError);
  assert.ok(sdk.UploadError.prototype instanceof sdk.NmtsError);
});
