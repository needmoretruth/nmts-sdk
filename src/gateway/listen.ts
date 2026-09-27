// The server a gateway listens on when it is asked to listen on its own.
//
// ⛔ THE COMMAND-LINE GATEWAY'S OWN SETTINGS, IMPORTED, NOT RETYPED. No limit on how long a whole
//    request takes (Node's 300 s `requestTimeout` cut every upload a client could not send in five
//    minutes), Node's limit on headers kept, and a body that stops arriving for `RECEIVE_IDLE_MS`
//    dropped — the handler watches that itself, so a server of the caller's own gets it too.
//
// ⛔ `Expect: 100-continue` IS ANSWERED AFTER THE SIGNATURE IS CHECKED. Node sends `100 Continue`
//    by itself unless a server asks first; then an upload whose signature does not hold sends its
//    whole body to be refused at the end.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BODY_IDLE_MS, GATEWAY_SERVER_OPTIONS } from "@needmoretruth/nmts-cli/s3-gateway";

/** How long a request's body may stop arriving before the connection is dropped. */
export const RECEIVE_IDLE_MS = BODY_IDLE_MS;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A server for `handler` with the limits above; `checkContinue` answers `Expect: 100-continue`. */
export function gatewayServer(handler: Handler, checkContinue: Handler): Server {
  const server = createServer(GATEWAY_SERVER_OPTIONS, handler);
  server.on("checkContinue", checkContinue);
  return server;
}
