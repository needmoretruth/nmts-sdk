// An S3 gateway a service runs for its customers: every customer gets a bucket and a key pair of
// their own, and whatever already speaks S3 — a Django or Rails storage adapter, rclone, a backup
// tool — stores into that customer's NMTS account.
//
// Run it with the API key and one customer's secrets in the environment — NMTS_API_KEY,
// ALICE_ACCOUNT_CODE, ALICE_S3_KEY_ID and ALICE_S3_SECRET:
//   node examples/gateway/server.mjs
//
// Then point an S3 client at it. Buckets are addressed by path, and any region name is accepted:
//   rclone    [nmts]  type = s3 · provider = Other · endpoint = http://127.0.0.1:9000 ·
//                     force_path_style = true · access_key_id / secret_access_key = the pair below
//   Django    (django-storages)  AWS_S3_ENDPOINT_URL = "http://127.0.0.1:9000" ·
//                     AWS_S3_ADDRESSING_STYLE = "path" · AWS_STORAGE_BUCKET_NAME = "alice"
//   Rails     (config/storage.yml)  service: S3 · endpoint: http://127.0.0.1:9000 ·
//                     force_path_style: true · bucket: alice · region: us-east-1
//
// What this shape means: this process holds the customers' NMTS keys, so it can read what it
// stores; NMTS cannot. Between the S3 client and this gateway the files are NOT encrypted — that
// is what S3 clients send — so it listens on loopback. Put it on a private network, or mount
// `gateway.handler` in an HTTPS server of your own, before anything reaches it from another machine.
//
// An upload spends what `put()` spends, which is why `write` is something you turn on. A delete is
// the trash, restorable for 30 days. A key that already holds a different file answers 409, and the
// same file again answers 200 without sending or spending anything.
import { Nmts } from "@needmoretruth/nmts-sdk";
import { createS3Gateway } from "@needmoretruth/nmts-sdk/gateway";

// bucket name → that customer's NMTS key and S3 key pair. A stand-in: keep the NMTS keys in a store
// of your own (a cloud key service, a master key, a hardware module), as in `node-managed/`.
const customers = new Map([
  [
    "alice",
    {
      accountCode: process.env.ALICE_ACCOUNT_CODE ?? "",
      accessKeyId: process.env.ALICE_S3_KEY_ID ?? "", // 16 to 128 characters
      secretAccessKey: process.env.ALICE_S3_SECRET ?? "", // at least 32 characters
    },
  ],
]);

const gateway = createS3Gateway({
  // ⛔ `buckets` is the wall between customers: Alice's pair is refused for every bucket but hers,
  //    with the same answer whether or not the other bucket exists.
  credentials: [...customers].map(([bucket, c]) => ({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    buckets: [bucket],
  })),
  // Asked at most once a minute per bucket name. Answering null is NoSuchBucket — and is how a
  // customer's access ends: within a minute the gateway stops serving the bucket.
  bucket: async (name) => {
    const customer = customers.get(name);
    if (!customer) return null;
    return Nmts.managed({
      openCode: async () => customer.accountCode,
      apiKey: process.env.NMTS_API_KEY ?? "",
    });
  },
  write: true,
  log: (line) => console.log(line), // method, bucket and status — never a file name
});

const { host, port } = await gateway.listen(9000);
console.log(`S3 gateway on http://${host}:${port} — buckets: ${[...customers.keys()].join(", ")}`);

process.on("SIGINT", async () => {
  await gateway.close(); // also removes the folder half-finished uploads were staged in
  process.exit(0);
});
