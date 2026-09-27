// The access key pairs an S3 gateway answers to, and every rule about them.
//
// ⚠ MOVED OUT OF `gateway.ts` UNCHANGED, which had reached the length limit. `gateway.ts` still
//   exports all of it, so nothing a caller imports moved.

import type { GatewayCredential } from "@needmoretruth/nmts-cli/s3-gateway";
import { NmtsError } from "@needmoretruth/nmts-cli/portable";

/** An access key id shorter than this is a guessable one. */
export const MIN_ACCESS_KEY_ID = 16;
/** And longer than this is not a key, it is a payload. */
export const MAX_ACCESS_KEY_ID = 128;
/** A secret shorter than this is worth guessing at. */
export const MIN_SECRET_ACCESS_KEY = 32;
/** More pairs than this is a sign that the pairs are being used as a user table. */
export const MAX_CREDENTIALS = 16;

/** One pair a caller may sign with, and what it is allowed to reach. */
export interface GatewayPair {
  /** 16 to 128 characters. Not a secret: it travels in the clear in every request. */
  accessKeyId: string;
  /** At least 32 characters. Never leaves this process and is never logged. */
  secretAccessKey: string;
  /**
   * The only buckets this pair may touch. Absent means every bucket `bucket()` will answer for.
   *
   * ⛔ THIS IS WHAT KEEPS ONE OF YOUR USERS OUT OF ANOTHER'S ACCOUNT. A pair given to a user's
   *    device, with no list here, opens every account your resolver knows.
   */
  buckets?: readonly string[] | undefined;
}

function refuseCredentials(rule: string): NmtsError {
  return new NmtsError(`GATEWAY_CREDENTIALS: ${rule}`, {
    exitCode: 2,
    nextStep: "Nothing is listening and nothing was opened. Fix the pair and make the gateway again.",
  });
}

/**
 * Every rule about the pairs, answered before anything listens.
 *
 * ⛔ AT CONSTRUCTION AND NOT AT THE FIRST REQUEST. A gateway that accepted a four-character secret
 *    and refused requests later would be a gateway that came up, passed a smoke test with the one
 *    client that had the right pair, and was brute-forced by the time anybody read a log.
 */
export function checkedCredentials(given: readonly GatewayPair[]): readonly GatewayCredential[] {
  if (given.length === 0) {
    throw refuseCredentials("`credentials` is empty, so no request could ever be answered.");
  }
  if (given.length > MAX_CREDENTIALS) {
    throw refuseCredentials(
      `\`credentials\` holds ${given.length} pairs and the most this gateway takes is ${MAX_CREDENTIALS}.`,
    );
  }
  const seen = new Set<string>();
  const checked: GatewayCredential[] = [];
  for (const pair of given) {
    const id = pair.accessKeyId;
    if (id.length < MIN_ACCESS_KEY_ID || id.length > MAX_ACCESS_KEY_ID) {
      throw refuseCredentials(
        `an \`accessKeyId\` is ${id.length} characters and it has to be ${MIN_ACCESS_KEY_ID} to ${MAX_ACCESS_KEY_ID}.`,
      );
    }
    if (pair.secretAccessKey.length < MIN_SECRET_ACCESS_KEY) {
      throw refuseCredentials(
        `a \`secretAccessKey\` is ${pair.secretAccessKey.length} characters and it has to be at least ${MIN_SECRET_ACCESS_KEY}.`,
      );
    }
    if (seen.has(id)) {
      throw refuseCredentials("two pairs have the same `accessKeyId`, so which one signs is undecidable.");
    }
    seen.add(id);
    checked.push({
      accessKeyId: id,
      secretAccessKey: pair.secretAccessKey,
      ...(pair.buckets === undefined ? {} : { buckets: pair.buckets }),
    });
  }
  return checked;
}
