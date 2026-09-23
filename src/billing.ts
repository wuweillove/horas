import {
  formatDayKey,
  isBillable,
  trackedMs,
  uniqueIds,
  type Entry,
  type Invoice,
  type InvoiceLine,
  type Store,
} from "./model.ts";

export function formatInvoiceNumber(n: number): string {
  const value = Math.max(1, Math.floor(n) || 1);
  return `H-${String(value).padStart(4, "0")}`;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function billedHours(entry: Pick<Entry, "clockIn" | "clockOut">, now = Date.now()): number {
  const minutes = trackedMs(entry, now) / 60_000;
  return Number((minutes / 60).toFixed(2));
}

export function rateForEntry(store: Store, entry: Entry): number {
  const job = store.jobs.find((item) => item.id === entry.jobId);
  if (job && typeof job.hourlyRate === "number") return job.hourlyRate;
  const client = store.clients.find((item) => item.id === job?.clientId);
  return client?.hourlyRate ?? 0;
}

export function amountForEntry(store: Store, entry: Entry, now = Date.now()): number {
  if (!isBillable(entry) || entry.clockOut === null) return 0;
  return roundMoney(billedHours(entry, now) * rateForEntry(store, entry));
}

export function formatMoney(amount: number, currency: string): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

export function invoicedIds(store: Store): Set<string> {
  return new Set(store.invoices.flatMap((invoice) => invoice.entryIds));
}

export function unbilledEntries(store: Store, clientId: string): Entry[] {
  const jobs = new Set(store.jobs.filter((job) => job.clientId === clientId).map((job) => job.id));
  const used = invoicedIds(store);
  return store.entries
    .filter((entry) => entry.clockOut !== null && isBillable(entry) && jobs.has(entry.jobId ?? "") && !used.has(entry.id))
    .sort((a, b) => a.clockIn - b.clockIn);
}

export type InvoiceTotals = { subtotal: number; tax: number; total: number; currency: string };

export function totalsFor(invoice: Invoice): InvoiceTotals {
  const subtotal = roundMoney(invoice.lines.reduce((sum, line) => sum + line.amount, 0));
  const tax = roundMoney(subtotal * (invoice.taxPercent / 100));
  return {
    subtotal,
    tax,
    total: roundMoney(subtotal + tax),
    currency: invoice.currency || "USD",
  };
}

export function createInvoice(
  store: Store,
  clientId: string,
  entryIds: string[],
  now = Date.now(),
): Store | { ok: false; error: string } {
  const client = store.clients.find((item) => item.id === clientId);
  if (!client) return { ok: false, error: "Pick a client." };
  const open = new Set(unbilledEntries(store, clientId).map((entry) => entry.id));
  const ids = uniqueIds(entryIds).filter((id) => open.has(id));
  if (ids.length === 0) return { ok: false, error: "Choose closed billable hours that are not on an invoice yet." };
  const lines: InvoiceLine[] = ids.map((id) => {
    const entry = store.entries.find((item) => item.id === id);
    const job = store.jobs.find((item) => item.id === entry?.jobId);
    const rate = entry ? rateForEntry(store, entry) : 0;
    const hours = entry ? billedHours(entry, now) : 0;
    return {
      entryId: id,
      date: entry ? formatDayKey(entry.clockIn) : "",
      job: job?.name ?? "",
      hours,
      rate,
      amount: roundMoney(hours * rate),
      comment: entry?.comment ?? "",
    };
  });
  if (roundMoney(lines.reduce((sum, line) => sum + line.amount, 0)) <= 0) {
    return { ok: false, error: "Set an hourly rate on the job or the client." };
  }
  const used = new Set(store.invoices.map((invoice) => invoice.number));
  let next = store.settings.nextNumber || 1;
  let number = formatInvoiceNumber(next);
  while (used.has(number)) {
    next += 1;
    number = formatInvoiceNumber(next);
  }
  const invoice: Invoice = {
    id: crypto.randomUUID(),
    number,
    clientId,
    clientName: client.name,
    clientEmail: client.email,
    clientAddress: client.address,
    entryIds: ids,
    lines,
    issuedAt: now,
    status: "draft",
    taxPercent: store.settings.taxPercent,
    notes: "",
    currency: store.settings.currency || "USD",
  };
  return {
    ...store,
    invoices: [invoice, ...store.invoices],
    settings: { ...store.settings, nextNumber: next + 1 },
  };
}
