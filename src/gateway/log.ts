// The one line a gateway logs per request.
//
// ⚠ MOVED OUT OF `gateway.ts` UNCHANGED, which had reached the length limit.

import type { IncomingMessage, ServerResponse } from "node:http";

import { failureReasonOf } from "@needmoretruth/nmts-cli/s3-gateway";

/**
 * What a gateway's handlers call first: one line for this request when it closes, or nothing when
 * there is no `log`. `close` rather than `finish`, so a request whose caller hung up is one line
 * too. The reason a request failed is the gateway's own, with every part of the path masked out.
 */
export function logEach(
  log: ((line: string) => void) | undefined,
  virtualHostBase: string | undefined,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (log === undefined) return;
    res.once("close", () => {
      const why = failureReasonOf(res);
      log(`${logLine(req, res, virtualHostBase)}${why === undefined ? "" : ` (${why})`}`);
    });
  };
}

/**
 * What a log line may carry: the verb, the bucket, and what was answered.
 *
 * ⛔ NOT THE OBJECT KEY, AND NOT THE SIGNATURE. A key is a file's path and a path is a file name,
 *    which is exactly the thing this product keeps from the server it stores on; written to a log
 *    on the way past it would be that name in plaintext, on disk, for as long as logs are kept.
 *    The bucket is already the business's own label for an account, so it is the one it can look up.
 *
 * ⛔ A VIRTUAL-HOSTED REQUEST'S BUCKET IS IN ITS HOST, AND ITS PATH IS ALL KEY. Reading the first
 *    path segment there would log the top folder of somebody's file. The host is compared without
 *    regard to case, so a host that differs only in case is still read as a bucket, never as a path.
 */
export function logLine(req: IncomingMessage, res: ServerResponse, virtualHostBase: string | undefined): string {
  const bucket = bucketNamed(req, virtualHostBase);
  return `${req.method ?? "?"} ${bucket === "" ? "-" : bucket} ${res.statusCode}`;
}

function bucketNamed(req: IncomingMessage, virtualHostBase: string | undefined): string {
  if (virtualHostBase !== undefined) {
    // ⚠ Read as the gateway reads it: lower case, no port, no leading dots on the base.
    const hostOnly = (host: string): string => host.trim().toLowerCase().replace(/:\d*$/, "");
    const host = hostOnly(req.headers.host ?? "");
    const under = `.${hostOnly(virtualHostBase).replace(/^\.+/, "")}`;
    if (under !== "." && host.length > under.length && host.endsWith(under)) return host.slice(0, -under.length);
  }
  const url = req.url ?? "/";
  const at = url.indexOf("?");
  const path = at < 0 ? url : url.slice(0, at);
  return path.replace(/^\//, "").split("/")[0] ?? "";
}
