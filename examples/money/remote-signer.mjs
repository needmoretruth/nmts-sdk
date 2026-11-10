// The customer's side of a sponsored upload: a signer whose address is the OPERATOR's, and whose
// signature comes from the operator's server (`sponsor-server.mjs`). Hand it to `put` or `extend`
// as `pay: { signer }` and the operator's wallet pays; nothing moves from the operator to the
// customer. No Node built-ins, so the same code runs in a page.
//
//   SPONSOR_URL      the operator's server, e.g. http://127.0.0.1:8787
//   CUSTOMER         your customer id at the operator
//   CUSTOMER_TOKEN   the token the operator's login gave you

/** A wallet-standard signer that forwards each transaction to the operator's server. */
export async function remoteSigner({ url, customer, token, fetch: post = fetch }) {
  const res = await post(new URL("/operator", url));
  if (!res.ok) throw new Error(`the operator's server answered ${res.status}`);
  const { address } = await res.json();
  return {
    address,
    async signTransaction({ bytes }) {
      const answer = await post(new URL("/sign", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customer, token, bytes: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")) }),
      });
      const body = await answer.json();
      // A refusal reaches put() as WALLET_REFUSED, with the operator's reason in it.
      if (!answer.ok) throw new Error(`the operator refused: ${body.error}${body.reason ? ` (${body.reason})` : ""}`);
      return { bytes: body.bytes, signature: body.signature };
    },
  };
}

export function signerFromEnv(env = process.env) {
  return remoteSigner({ url: env.SPONSOR_URL ?? "http://127.0.0.1:8787", customer: env.CUSTOMER, token: env.CUSTOMER_TOKEN });
}
