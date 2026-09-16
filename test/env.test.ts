// `Nmts.fromEnv()`: the same variables as the command-line tool, a file winning over a value.

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { testConfigDir } from "../../cli/src/credentials.ts";
import { credentialsFromEnvironment } from "../src/env.ts";
import { Nmts, NmtsError } from "../src/index.ts";

const NAMES = ["NMTS_ACCOUNT_CODE", "NMTS_ACCOUNT_CODE_FILE", "NMTS_API_KEY", "NMTS_API_KEY_FILE"] as const;

async function withEnv(values: Partial<Record<(typeof NAMES)[number], string>>, body: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  for (const [n, v] of Object.entries(values)) process.env[n] = v;
  try {
    await body();
  } finally {
    for (const n of NAMES) {
      const v = before[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

test("a file named by *_FILE wins over the value in the variable, and the reading says which", async () => {
  const dir = testConfigDir("sdk-env-files");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code"), "from-file\n");
  writeFileSync(join(dir, "key"), "key-from-file\n");
  try {
    await withEnv(
      { NMTS_ACCOUNT_CODE: "from-variable", NMTS_ACCOUNT_CODE_FILE: join(dir, "code"), NMTS_API_KEY_FILE: join(dir, "key") },
      async () => {
        const found = credentialsFromEnvironment();
        assert.equal(found.credentials.accountCode, "from-file", "the trailing newline is removed too");
        assert.equal(found.credentials.apiKey, "key-from-file");
        assert.equal(found.accountCodeFrom, "file");
        assert.equal(found.apiKeyFrom, "file");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("values in the variables themselves are read when no file is named", async () => {
  await withEnv({ NMTS_ACCOUNT_CODE: "c", NMTS_API_KEY: "k" }, async () => {
    const found = credentialsFromEnvironment();
    assert.deepEqual([found.accountCodeFrom, found.apiKeyFrom], ["variable", "variable"]);
    assert.ok(Nmts.fromEnv() instanceof Nmts, "the constructor does no work, so a bad code is not refused here");
  });
});

test("⛔ a missing credential names the variables and never a value", async () => {
  await withEnv({ NMTS_ACCOUNT_CODE: "secret-code-value" }, async () => {
    assert.throws(
      () => Nmts.fromEnv(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /No API key/);
        assert.ok(!error.message.includes("secret-code-value"));
        return true;
      },
    );
  });
  await withEnv({}, async () => {
    assert.throws(
      () => Nmts.fromEnv(),
      (error: unknown) => {
        assert.ok(error instanceof NmtsError);
        assert.match(error.message, /No account code/);
        assert.match(error.nextStep ?? "", /NMTS_ACCOUNT_CODE_FILE/, "the next step names the preferred variable");
        return true;
      },
    );
  });
});

test("a *_FILE variable that names nothing readable is a refusal, not a fall-through", async () => {
  await withEnv({ NMTS_ACCOUNT_CODE_FILE: "/nonexistent/nmts-code", NMTS_ACCOUNT_CODE: "c", NMTS_API_KEY: "k" }, async () => {
    assert.throws(() => credentialsFromEnvironment(), /could not be read/);
  });
});
