#!/usr/bin/env node
// Before the tests: make sure the command-line package this one is built on is reachable and built.
//
// This package depends on `@needmoretruth/nmts-cli`. Inside the source tree that dependency is the
// sibling `../cli` checkout, and its library surface lives in `cli/dist`, which is a build output.
// A test run that found no `dist` would fail with "cannot find module" three imports deep, which
// says nothing about what is actually missing; this script says it, and fixes the two cases it
// can: a missing link (made) and a missing build (compiled, using the sibling's own compiler).
//
// It does nothing when the dependency resolves and its build is newer than its source.
// ⛔ 2026-09-23: "is built" was not enough. A merge added an export to `cli/src/portable.ts`, the old
//    `dist` stayed, and every SDK test failed with "does not provide an export named 'classify'" —
//    a stale build reads exactly like a broken library. So the build is also redone when any source
//    file is newer than it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
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

/**
 * The newest modification time of any file under `dir`, or 0 when there is none. A CLI installed
 * from npm ships its build without `src/`, so a missing folder is 0, not an error.
 */
function newest(dir) {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

const built = join(link, "dist", "index.js");
if (!existsSync(built)) {
  console.log("ensure-cli: the command-line package has no build yet; compiling it");
  execFileSync("npm", ["run", "compile"], { cwd: link, stdio: "inherit" });
} else if (newest(join(link, "src")) > statSync(built).mtimeMs) {
  console.log("ensure-cli: the command-line package's source is newer than its build; compiling it");
  execFileSync("npm", ["run", "compile"], { cwd: link, stdio: "inherit" });
}
