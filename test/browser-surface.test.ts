// The two entry points export the same names, and the list of what only Node has is short and
// written down.
//
// ⛔ THE FAILURE THIS CATCHES IS THE ONE A DEVELOPER HITS FIRST: a program written against the
//    package, moved into a page, and an import that is suddenly not there. A verb that exists on
//    one side and not the other would be the key-holder law broken by the runtime instead of by
//    the key — the same defect, one layer down.
//
// ⛔ THE ALLOW LIST IS ONE-SIDED AND IT IS THE POINT. A name the browser entry lacks has to be
//    named here, with a reason; a name the browser entry has and Node does not would be a second
//    surface growing quietly, so there is no list for that at all.
//
// ⚠ IMPORTING `../src/browser.ts` REGISTERS A BROWSER HOST IN THIS PROCESS, which is why this file
//   does its own account work through neither. It reads export names and nothing else.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import * as node from "../src/index.ts";

/**
 * Names the Node entry has and the browser entry does not.
 *
 * ⛔ EMPTY, AND THAT IS THE RESULT RATHER THAN AN OVERSIGHT. What a page cannot do is not a set of
 *    missing exports — it is four CALLS, each of them on the class and each refusing by name (the
 *    test below): three that need files, and `business`, which needs a machine a business's
 *    signing key belongs on. Keeping the two surfaces identical is what lets a program written on
 *    a server move into a page without an import changing.
 *
 * ⚠ `blobSource` is on BOTH sides: Node has had `Blob` since 18, so a program on a server that
 *   already holds one hands it over the same way.
 */
const NODE_ONLY: readonly string[] = [];

test("the browser entry exports every name the Node entry does", async () => {
  const browser: Record<string, unknown> = await import("../src/browser.ts");
  const missing = Object.keys(node).filter((name) => !(name in browser) && !NODE_ONLY.includes(name));
  assert.deepEqual(missing, [], "the browser entry is missing names the Node entry exports");
  const extra = Object.keys(browser).filter((name) => !(name in node));
  assert.deepEqual(extra, [], "the browser entry exports a name the Node entry does not");
});

test("both entries hand out the same class, with the same three verbs and the same makers", async () => {
  const browser: Record<string, unknown> = await import("../src/browser.ts");
  assert.equal(browser["Nmts"], node.Nmts, "the two entries are two classes, so a check on one says nothing");
  for (const maker of ["device", "managed", "fromEnv"]) {
    assert.equal(typeof Reflect.get(node.Nmts, maker), "function", `Nmts.${maker}() is not there`);
  }
});

test("⛔ the four things a page may not do refuse by name, rather than failing deeper", async () => {
  const { forgetNodeSeams } = await import("../src/node-seams.ts");
  const { Nmts } = await import("../src/browser.ts");
  const client = Nmts.device({ accountCode: "x", apiKey: "y", server: "https://nmts.me" });
  forgetNodeSeams();
  try {
    for (const [what, run] of [
      ["PUT_PATH_UNAVAILABLE", () => client.put("/tmp/report.pdf")],
      ["GET_TO_UNAVAILABLE", () => client.getTo("report.pdf", "/tmp/report.pdf")],
      ["FROM_ENV_UNAVAILABLE", () => Nmts.fromEnv()],
      // ⛔ NOT ABOUT FILES. A business's signing key in a page is that key handed to everyone who
      //    opens the page; what a page holds is a delegation token somebody else signed.
      ["BUSINESS_IN_A_PAGE", () => Nmts.business({ accountId: "a", privateKey: "b" })],
    ] as const) {
      await assert.rejects(async () => run(), new RegExp(what), `${what} was not the refusal`);
    }
  } finally {
    // The Node seams belong to whatever runs next in this process.
    const { useNodeSeams } = await import("../src/node-seams.ts");
    const { fileSink, fileSource, measureLocal } = await import("@needmoretruth/nmts-cli");
    const { credentialsFromEnvironment } = await import("../src/env.ts");
    useNodeSeams({
      source: (path: string) => fileSource(path, measureLocal(path)),
      sink: fileSink,
      environment: credentialsFromEnvironment,
    });
  }
});
