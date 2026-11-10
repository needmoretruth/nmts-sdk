// Monero received directly by `monero-wallet-rpc`, with no payment processor: one subaddress per
// invoice, paid once the transfers into it have enough confirmations. Node built-ins only.
//
// Calls (https://docs.getmonero.org/rpc-library/wallet-rpc/):
//   create_address { account_index, label }            → { address, address_index }
//   get_transfers  { in, account_index, subaddr_indices } → { in: [{ amount, confirmations, txid }] }
// Amounts are piconero (1 XMR = 10¹² piconero). Run the wallet RPC with `--rpc-login` on localhost;
// the HTTP digest login is answered below. A view-only wallet is enough to receive.
//
// Environment: MONERO_RPC_URL (e.g. http://127.0.0.1:18083/json_rpc), MONERO_RPC_LOGIN (user:pass),
// MONERO_CONFIRMATIONS (default 10).
import { createHash, randomBytes } from "node:crypto";

const md5 = (text) => createHash("md5").update(text).digest("hex");

/** The `Authorization` header answering one HTTP digest challenge (RFC 7616, MD5, qop=auth). */
export function digestAuthorization(challenge, { user, pass, method, uri, cnonce = randomBytes(8).toString("hex"), nc = "00000001" }) {
  const field = (name) => new RegExp(`${name}="?([^",]+)"?`, "i").exec(challenge)?.[1];
  const realm = field("realm");
  const nonce = field("nonce");
  const qop = field("qop")?.split(",")[0]?.trim();
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(", ")}`;
}

export class MoneroWallet {
  constructor({ url, login = null, fetch: get = fetch }) {
    this.url = url;
    this.login = login;
    this.get = get;
  }

  async call(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: "0", method, params });
    const send = (authorization) =>
      this.get(this.url, { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body });
    let res = await send(null);
    if (res.status === 401 && this.login !== null) {
      const [user, pass] = this.login.split(":");
      const uri = new URL(this.url).pathname;
      res = await send(digestAuthorization(res.headers.get("www-authenticate") ?? "", { user, pass, method: "POST", uri }));
    }
    const answer = await res.json();
    if (answer.error) throw new Error(`monero-wallet-rpc ${method}: ${answer.error.message}`);
    return answer.result;
  }

  /** A fresh subaddress for one invoice. Keep `index` with the invoice. */
  async newInvoice(label) {
    const { address, address_index } = await this.call("create_address", { account_index: 0, label });
    return { address, index: address_index };
  }

  /** Piconero received at subaddress `index` with at least `confirmations` confirmations. */
  async received(index, confirmations) {
    const result = await this.call("get_transfers", { in: true, account_index: 0, subaddr_indices: [index] });
    return confirmedTotal(result.in ?? [], confirmations);
  }
}

/** The sum of transfers with enough confirmations. Pure, so it is tested without a wallet. */
export function confirmedTotal(transfers, confirmations) {
  return transfers.filter((t) => (t.confirmations ?? 0) >= confirmations).reduce((sum, t) => sum + BigInt(t.amount), 0n);
}
