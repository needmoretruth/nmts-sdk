#!/usr/bin/env node
// Before the tests: make sure the command-line package this one is built on is reachable and built.
//
// This package depends on `@needmoretruth/nmts-cli`. Inside the source tree that dependency is the
// sibling `../cli` checkout, and its library surface lives in `cli/dist`, which is a build output.
// A test run that found no `dist` would fail with "cannot find module" three imports deep, which
// says nothing about what is actually missing; this script says it, and fixes the two cases it
// can: a missing link (made) and a missing build (compiled, using the sibling's own compiler).
//
// It does nothing when the dependency resolves and is built — which is every run after the first.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, "..");
const linkDir = join(sdk, "node_modules", "@needmoretruth");
const link = join(linkDir, "nmts-cli");
const sibling = join(sdk, "..", "cli");

if (!existsSync(link)) {
  if (!existsSync(join(sibling, "package.json"))) {
    console.error("ensure-cli: @needmoretruth/nmts-cli is not installed and there is no sibling cli/ to link. Run `npm install`.");
    process.exit(1);
  }
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(relative(linkDir, sibling), link, "dir");
  console.log(`ensure-cli: linked ${relative(sdk, link)} -> ../cli`);
}

if (!existsSync(join(link, "dist", "index.js"))) {
  console.log("ensure-cli: the command-line package has no build yet; compiling it");
  execFileSync("npm", ["run", "compile"], { cwd: link, stdio: "inherit" });
}
