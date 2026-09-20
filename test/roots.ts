// The registry every verb is tested through: one row per answer to "who holds the account's key".
//
// ⛔ A VERB THAT ONLY WORKS FOR ONE KEY HOLDER IS A DEFECT, and the only way a machine catches one
//    is to run every verb through every root. Each verb's test file walks this list, and
//    `surface.test.ts` counts that every verb file has a test that does — so the day a third root
//    arrives, every verb starts running through it without a verb test being touched.
//
// ⛔ THE MANAGED STORE COUNTS HOW OFTEN IT IS OPENED. One call must open it exactly once: twice
//    means the package asked again partway through something it was already holding, and a later
//    call that opens it none would mean the package kept the code between calls. Both are things
//    a business running this for other people has to be able to rely on, and neither shows up in
//    an answer that is otherwise correct.
//
// ⚠ THE FAKE STORE IS A CLOSURE, NOT A CIPHER. How a business seals a code — a cloud key service,
//   a master key, a hardware module — is its own decision and changes nothing here: what these
//   tests hold is how often the package asks and what it keeps, and neither depends on the sealing.
//
// ⚠ `root` IS A FUNCTION, NOT A `Root`. Every test makes its own account in its own sandbox, and a
//   root is the thing that holds one account's key, so it cannot exist before the account does.

import { generateBusinessKeys, mintDelegation, registerHost, toBase64Url, type Host } from "@needmoretruth/nmts-cli/portable";
import { nodeHost } from "@needmoretruth/nmts-cli";

import { deviceRoot, managedRoot, type Credentials, type Root } from "../src/root.ts";
import { memoryState } from "../src/state-memory.ts";

/**
 * Every test runs against the Node host with its state in MEMORY.
 *
 * ⛔ THE ENGINE IS REAL AND THE STORE IS NOT. What these tests prove is what the verbs answer, and
 *    that comes out of the real WebAssembly; what they must not do is leave a kept file list or an
 *    unfinished upload in whoever's home directory ran them, or read one left by the last run.
 *
 * ⛔ REGISTERED HERE, AT IMPORT, because every verb test imports this file for the registry below.
 *    A host registered inside a test would apply to whatever ran after it in the same process.
 */
const withMemory: Host = { ...nodeHost(), state: memoryState() };
registerHost(withMemory);

export interface NamedRoot {
  /** What a failing assertion prints: `device`, `managed` or `delegation`. */
  readonly name: string;
  /** This kind of root over one sandbox's credentials. Starts the opening count again. */
  readonly root: (credentials: Credentials) => Root;
  /**
   * How many times the root last built was asked to produce the code: for `managed`, calls to
   * `openCode` — a business's store being opened; for `device`, calls to `withCode`, since the code
   * was handed in and there is no store to open. One call on the account must make it exactly one.
   */
  readonly opens: () => number;
}

/**
 * A token of the shape a business mints, made once, from a key pair nobody owns.
 *
 * ⚠ THE FAKE SERVER DOES NOT VERIFY IT, and that is right rather than a gap: whether a signature
 *   holds is the server's judgement and is tested where the verifier is. What the registry below
 *   proves is the other half — that every verb carries whichever credential it was given, and that
 *   none of them was written for one kind and left broken for the other.
 */
const BUSINESS = generateBusinessKeys();
const DELEGATION_TOKEN = mintDelegation({
  business: toBase64Url(new Uint8Array(16).fill(1)),
  user: toBase64Url(new Uint8Array(16).fill(2)),
  privateKey: BUSINESS.privateKey,
  // ⛔ EVERY SCOPE A VERB IN THIS PACKAGE NEEDS — `files_erase` and `storage_spend` included, the
  //    second because recording an extension is the one storage-control verb that reaches the
  //    server. The registry's job is to prove a verb works through this root, and a token that
  //    could not reach one of them would make that verb's delegation row a test of the scope
  //    rather than of the verb. What a token WITHOUT `storage_spend` does is `storage.test.ts`'s
  //    own question, and it mints one of its own to ask it.
  scope: ["files_read", "files_write", "storage_spend", "files_erase"],
  ttlSecs: 3_600,
});

/** Count a `withCode` without changing what it does. */
function counting(root: Root, count: () => void): Root {
  return {
    mode: root.mode,
    identity: root.identity,
    withCode: <T>(use: (code: string) => Promise<T>): Promise<T> => {
      count();
      return root.withCode(use);
    },
  };
}

/** The roots under test. Three today; the gateway root joins them when there is one. */
export function rootsUnderTest(): readonly NamedRoot[] {
  let deviceOpens = 0;
  let managedOpens = 0;
  let delegatedOpens = 0;
  return [
    {
      name: "device",
      root: (credentials: Credentials): Root => {
        deviceOpens = 0;
        return counting(deviceRoot(credentials), () => (deviceOpens += 1));
      },
      opens: () => deviceOpens,
    },
    {
      name: "managed",
      root: (credentials: Credentials): Root => {
        managedOpens = 0;
        const sealed = credentials.accountCode;
        const openCode = async (): Promise<string> => {
          managedOpens += 1;
          return sealed;
        };
        return credentials.delegation === undefined
          ? managedRoot({ openCode, apiKey: credentials.apiKey })
          : managedRoot({ openCode, delegation: credentials.delegation });
      },
      opens: () => managedOpens,
    },
    {
      // ⛔ THE SAME KEY HOLDER, THE OTHER CREDENTIAL. A business's user holds their own code and
      //    speaks with a token their business signed, so what this row varies is the identity and
      //    not the root — which is exactly the axis a verb written for an API key would break on.
      name: "delegation",
      root: (credentials: Credentials): Root => {
        delegatedOpens = 0;
        // ⚠ A blank credential stays blank, so the test that proves a verb refuses before it makes
        //   a request proves it for this identity too rather than quietly skipping it.
        const given = credentials.delegation ?? credentials.apiKey ?? "";
        const delegation = given.trim() === "" ? given : DELEGATION_TOKEN;
        return counting(deviceRoot({ accountCode: credentials.accountCode, delegation }), () => (delegatedOpens += 1));
      },
      opens: () => delegatedOpens,
    },
  ];
}

/**
 * Whether `needle` can be reached from `value` by walking own enumerable properties, arrays, maps
 * and sets.
 *
 * ⛔ WHAT IT CANNOT SEE, AND SO WHAT IT DOES NOT PROVE: a `#private` class field or a closure
 *    variable, neither of which any reflection reaches. It is the proof for the plain objects the
 *    verbs pass around — `Opened` above all, which every verb is handed. The proof for `Nmts` is
 *    the opening count: a second call that had to open the store again cannot have been served out
 *    of something the first one kept.
 */
export function reaches(value: unknown, needle: string): boolean {
  const seen = new Set<object>();
  const walk = (node: unknown): boolean => {
    if (typeof node === "string") return node.includes(needle);
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (node instanceof Map) return [...node.keys()].some(walk) || [...node.values()].some(walk);
    if (node instanceof Set) return [...node].some(walk);
    const values: unknown[] = Object.keys(node).map((key) => Reflect.get(node, key));
    return values.some(walk);
  };
  return walk(value);
}
