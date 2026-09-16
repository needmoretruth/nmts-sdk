// The one place this package reads the environment — and only when `Nmts.fromEnv()` asks.
//
// ⛔ THE SAME VARIABLE NAMES AS THE COMMAND-LINE TOOL, in the same order of preference, so a
//    machine set up for `nmts` is set up for this package, and a container recipe written for one
//    works for the other. A file named by `*_FILE` wins over a value in the variable itself,
//    because a variable holding a path shows a reader a filename and a variable holding the value
//    shows them the value (`docker inspect` prints the whole environment).
//
// ⚠ THE COMMAND-LINE TOOL STOPS ONCE FOR AN AGREEMENT before it will read the account code out of
//   `NMTS_ACCOUNT_CODE`; this package does not, because it cannot: there is no terminal and no
//   person on the other end of a library call. Choosing `fromEnv()` is that agreement. The README
//   says so where the variables are explained, and says why the file form is the better one.

import {
  API_KEY_ENV_VAR,
  API_KEY_FILE_ENV_VAR,
  CODE_ENV_VAR,
  CODE_FILE_ENV_VAR,
  NmtsError,
  readSecretFile,
} from "@needmoretruth/nmts-cli";

import type { Credentials } from "./root.ts";

/** Where each credential was found. Reported, never the value. */
export type FoundIn = "file" | "variable";

export interface FromEnvironment {
  credentials: Credentials;
  accountCodeFrom: FoundIn;
  apiKeyFrom: FoundIn;
}

function fromFileOrVariable(
  fileVariable: string,
  valueVariable: string,
  what: string,
): { value: string; from: FoundIn } {
  const fromFile = readSecretFile(fileVariable);
  if (fromFile !== null) return { value: fromFile, from: "file" };
  const fromVariable = process.env[valueVariable];
  if (fromVariable !== undefined && fromVariable.length > 0) {
    return { value: fromVariable, from: "variable" };
  }
  throw new NmtsError(`No ${what} in the environment.`, {
    exitCode: 3,
    nextStep:
      `Set ${fileVariable} to a file holding it (preferred), or ${valueVariable} to the value. ` +
      `Or pass it to the constructor and do not use fromEnv().`,
  });
}

/**
 * The two credentials from the environment, or a refusal naming the variable that was missing.
 *
 * ⛔ THE REFUSAL NEVER CONTAINS A VALUE. It names variables; the caller's log is not a place a
 *    credential should be able to reach.
 */
export function credentialsFromEnvironment(): FromEnvironment {
  const code = fromFileOrVariable(CODE_FILE_ENV_VAR, CODE_ENV_VAR, "account code");
  const key = fromFileOrVariable(API_KEY_FILE_ENV_VAR, API_KEY_ENV_VAR, "API key");
  return {
    credentials: { accountCode: code.value, apiKey: key.value },
    accountCodeFrom: code.from,
    apiKeyFrom: key.from,
  };
}
