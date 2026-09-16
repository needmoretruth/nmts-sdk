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

import { deviceRoot, managedRoot, type Credentials, type Root } from "../src/root.ts";

export interface NamedRoot {
  /** What a failing assertion prints: `device` or `managed`. */
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

/** The roots under test. Two today; the gateway root joins them when there is one. */
export function rootsUnderTest(): readonly NamedRoot[] {
  let deviceOpens = 0;
  let managedOpens = 0;
  return [
    {
      name: "device",
      root: (credentials: Credentials): Root => {
        deviceOpens = 0;
        const root = deviceRoot(credentials);
        return {
          mode: root.mode,
          identity: root.identity,
          withCode: <T>(use: (code: string) => Promise<T>): Promise<T> => {
            deviceOpens += 1;
            return root.withCode(use);
          },
        };
      },
      opens: () => deviceOpens,
    },
    {
      name: "managed",
      root: ({ accountCode, apiKey }: Credentials): Root => {
        managedOpens = 0;
        const sealed = accountCode;
        return managedRoot({
          openCode: async () => {
            managedOpens += 1;
            return sealed;
          },
          apiKey,
        });
      },
      opens: () => managedOpens,
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
