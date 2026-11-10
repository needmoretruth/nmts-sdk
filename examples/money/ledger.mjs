// The operator's ledger: what each customer has paid for and what has been spent on their behalf.
// Node built-ins only. A business keeps this in its own database; a JSON file is enough to show it.
//
// The unit a customer buys is the MiB-epoch: one mebibyte stored for one storage-network epoch.
// A payment adds MiB-epochs and a SUI allowance for chain fees and relay tips. Every transaction
// the operator signs for that customer is charged here first, and refused when either runs out.
// That is the usage limit: one customer cannot spend what another paid for.
//
// ⚠ Turning a customer's payment into WAL and SUI is the business's own treasury work. NMTS
//   neither converts nor holds anybody's coins.
//
//   node examples/money/ledger.mjs status <customer>      what is left
//   node examples/money/ledger.mjs unpaid <customer>      stop signing for them (extensions stop too)
//   node examples/money/ledger.mjs paid <customer>        sign for them again
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const MIB = 1024 * 1024;

/** MiB-epochs one signed transaction uses: what it registers or extends, rounded up per MiB. */
export function mibEpochsOf(spends) {
  if (spends.bytes === 0 || spends.epochs === 0) return 0;
  return Math.ceil(spends.bytes / MIB) * spends.epochs;
}

/**
 * What a payment buys, from the rates the business sets: `{ usd: { mibEpochsPerUnit, suiMistPerUnit } }`.
 * `amount` is in the currency's smallest unit (cents, satoshis, piconero), as the providers send it.
 */
export function allowanceFor(amount, currency, rates) {
  const rate = rates[currency.toLowerCase()];
  if (rate === undefined) throw new Error(`no rate for ${currency}`);
  const units = BigInt(amount);
  return {
    mibEpochs: Number((units * BigInt(rate.mibEpochsPerUnit[0])) / BigInt(rate.mibEpochsPerUnit[1])),
    suiMist: (units * BigInt(rate.suiMistPerUnit[0])) / BigInt(rate.suiMistPerUnit[1]),
  };
}

export class Ledger {
  constructor(state = { customers: {}, events: {} }, file = null) {
    this.state = state;
    this.file = file;
  }

  static open(file) {
    const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    return new Ledger(state, file);
  }

  save() {
    if (this.file === null) return;
    // Written whole and renamed, so a crash leaves the old ledger rather than half a new one.
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  // The file is read again before every use: `ledger.mjs unpaid` runs in another process while the
  // server is up, and the server must see it at the next request.
  #reload() {
    if (this.file !== null && existsSync(this.file)) this.state = JSON.parse(readFileSync(this.file, "utf8"));
  }

  #customer(id) {
    this.state.customers[id] ??= { mibEpochs: 0, suiMist: "0", spentMibEpochs: 0, spentSuiMist: "0", unpaid: false };
    return this.state.customers[id];
  }

  /** Add a payment. ⛔ Idempotent on `eventId`: a provider that retries a webhook does not pay twice. */
  credit({ eventId, customer, mibEpochs, suiMist }) {
    this.#reload();
    if (this.state.events[eventId] !== undefined) return { credited: false, why: "already credited" };
    const c = this.#customer(customer);
    c.mibEpochs += mibEpochs;
    c.suiMist = (BigInt(c.suiMist) + BigInt(suiMist)).toString();
    c.unpaid = false;
    this.state.events[eventId] = { customer, mibEpochs, suiMist: suiMist.toString(), at: new Date().toISOString() };
    this.save();
    return { credited: true };
  }

  status(customer) {
    this.#reload();
    const c = this.#customer(customer);
    return {
      customer,
      mibEpochsLeft: c.mibEpochs - c.spentMibEpochs,
      suiMistLeft: (BigInt(c.suiMist) - BigInt(c.spentSuiMist)).toString(),
      unpaid: c.unpaid,
    };
  }

  /** Whether `spends` (what the check measured) fits what is left. Nothing changes. */
  judge(customer, spends) {
    this.#reload();
    const c = this.#customer(customer);
    if (c.unpaid) return { ok: false, reason: `${customer} is marked unpaid` };
    const need = mibEpochsOf(spends);
    const left = c.mibEpochs - c.spentMibEpochs;
    if (need > left) return { ok: false, reason: `needs ${need} MiB-epochs and ${customer} has ${left} left` };
    const sui = BigInt(spends.suiMist);
    const suiLeft = BigInt(c.suiMist) - BigInt(c.spentSuiMist);
    if (sui > suiLeft) return { ok: false, reason: `needs up to ${sui} MIST of SUI and ${customer} has ${suiLeft} left` };
    return { ok: true, need };
  }

  /** Charge what was signed. ⚠ Charged at signing, the most it can cost: an unsubmitted signature is not refunded. */
  charge(customer, spends) {
    const verdict = this.judge(customer, spends);
    if (!verdict.ok) return verdict;
    const c = this.#customer(customer);
    c.spentMibEpochs += verdict.need;
    c.spentSuiMist = (BigInt(c.spentSuiMist) + BigInt(spends.suiMist)).toString();
    this.save();
    return verdict;
  }

  setUnpaid(customer, unpaid) {
    this.#reload();
    this.#customer(customer).unpaid = unpaid;
    this.save();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, customer] = process.argv.slice(2);
  const ledger = Ledger.open(process.env.LEDGER_FILE ?? "./ledger.json");
  if (command === "unpaid" || command === "paid") ledger.setUnpaid(customer, command === "unpaid");
  console.log(JSON.stringify(ledger.status(customer)));
}
