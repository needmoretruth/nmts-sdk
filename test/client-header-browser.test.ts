// The browser entry says the same thing the Node entry does: `x-nmts-client: sdk/<version>`.
// ⚠ Its own file because importing an entry is what sets the value — in one process with the Node
//   entry this would pass whichever of the two did the work.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { clientHeaderValue } from "@needmoretruth/nmts-cli/portable";

import "../src/browser.ts";
import { VERSION } from "../src/product.ts";

test("loading the browser entry makes every request say `sdk` and the SDK's version", () => {
  assert.equal(clientHeaderValue(), `sdk/${VERSION}`);
});
