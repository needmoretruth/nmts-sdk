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
    "get",
    "getTo",
    "list",
    "put",
    "setActiveWallet",
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
