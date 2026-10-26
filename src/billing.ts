import {
  entriesInRange,
  formatDayKey,
  isBillable,
  rangeBounds,
  totalMs,
  trackedMs,
  uniqueIds,
  type Entry,
  type Invoice,
  type InvoiceAdjustment,
  type InvoiceLine,
  type InvoiceStatus,
  type RangeKey,
  type Store,
  type WeekStart,
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

export type WeekJobLine = { id: string; name: string; ms: number; amount: number };

export function periodAcrossJobs(
  store: Store,
  key: RangeKey,
  now = Date.now(),
): { ms: number; amount: number; jobs: WeekJobLine[] } {
  const known = new Set(store.jobs.map((job) => job.id));
  const fallback = store.jobs[0]?.id ?? "";
  const period = entriesInRange(store.entries, key, new Date(now), store.settings.weekStart);
  const jobs = store.jobs.map((job) => {
    const entries = period.filter((entry) => {
      const id = entry.jobId;
      return (id && known.has(id) ? id : fallback) === job.id;
    });
    return {
      id: job.id,
      name: job.name,
      ms: totalMs(entries, now),
      amount: roundMoney(entries.reduce((sum, entry) => sum + amountForEntry(store, entry, now), 0)),
    };
  });
  return {
    ms: jobs.reduce((sum, job) => sum + job.ms, 0),
    amount: roundMoney(jobs.reduce((sum, job) => sum + job.amount, 0)),
    jobs: jobs.filter((job) => job.ms > 0 || job.amount > 0),
  };
}

export function weekAcrossJobs(store: Store, now = Date.now()): { ms: number; amount: number; jobs: WeekJobLine[] } {
  return periodAcrossJobs(store, "week", now);
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

export type LooseJob = {
  id: string;
  name: string;
  closedMs: number;
  closedCount: number;
  amount: number;
  open: boolean;
};

export function jobsWithoutClient(store: Store, clientId: string): LooseJob[] {
  const used = invoicedIds(store);
  const clientRate = store.clients.find((item) => item.id === clientId)?.hourlyRate ?? 0;
  return store.jobs.flatMap((job) => {
    if (job.clientId) return [];
    const mine = store.entries.filter(
      (entry) => (entry.jobId ?? "") === job.id && isBillable(entry) && !used.has(entry.id),
    );
    const closed = mine.filter((entry) => entry.clockOut !== null);
    const open = mine.some((entry) => entry.clockOut === null);
    if (closed.length === 0 && !open) return [];
    const rate = typeof job.hourlyRate === "number" ? job.hourlyRate : clientRate;
    const amount = roundMoney(closed.reduce((sum, entry) => sum + roundMoney(billedHours(entry) * rate), 0));
    return [
      {
        id: job.id,
        name: job.name,
        closedMs: totalMs(closed),
        closedCount: closed.length,
        amount,
        open,
      },
    ];
  });
}

export type InvoiceTotals = { subtotal: number; adjustment: number; tax: number; total: number; currency: string };

export function totalsFor(invoice: Invoice): InvoiceTotals {
  const subtotal = roundMoney(invoice.lines.reduce((sum, line) => sum + line.amount, 0));
  const adjustment = roundMoney((invoice.adjustments ?? []).reduce((sum, item) => sum + item.amount, 0));
  const adjusted = roundMoney(subtotal + adjustment);
  const tax = roundMoney(Math.max(0, adjusted) * (invoice.taxPercent / 100));
  return {
    subtotal,
    adjustment,
    tax,
    total: roundMoney(adjusted + tax),
    currency: invoice.currency || "USD",
  };
}

export type BillPeriod = "all" | "week" | "lastWeek" | "month" | "lastMonth";

export function billPeriodBounds(
  period: BillPeriod,
  now = new Date(),
  weekStart: WeekStart = "monday",
): { start: number | null; end: number | null } {
  if (period === "all") return { start: null, end: null };
  if (period === "week" || period === "month") return rangeBounds(period, now, weekStart);
  if (period === "lastWeek") {
    const current = rangeBounds("week", now, weekStart);
    if (current.start === null) return { start: null, end: null };
    const start = new Date(current.start);
    start.setDate(start.getDate() - 7);
    return { start: start.getTime(), end: current.start - 1 };
  }
  const current = rangeBounds("month", now, weekStart);
  if (current.start === null) return { start: null, end: null };
  const first = new Date(current.start);
  first.setDate(0);
  first.setHours(0, 0, 0, 0);
  first.setDate(1);
  return { start: first.getTime(), end: current.start - 1 };
}

export function entryInPeriod(entry: Pick<Entry, "clockIn" | "clockOut">, bounds: { start: number | null; end: number | null }): boolean {
  if (bounds.start === null || bounds.end === null) return true;
  const from = entry.clockIn;
  const to = entry.clockOut ?? from;
  return from <= bounds.end && to >= bounds.start;
}

export type LedgerState = "unbilled" | InvoiceStatus;

export type LedgerRow = {
  entry: Entry;
  state: LedgerState;
  invoiceNumber: string;
  amount: number;
};

export function clientLedger(store: Store, clientId: string): LedgerRow[] {
  const jobs = new Set(store.jobs.filter((job) => job.clientId === clientId).map((job) => job.id));
  const byEntry = new Map<string, Invoice>();
  for (const invoice of store.invoices) {
    for (const id of invoice.entryIds) {
      if (!byEntry.has(id)) byEntry.set(id, invoice);
    }
  }
  return store.entries
    .filter((entry) => entry.clockOut !== null && isBillable(entry) && jobs.has(entry.jobId ?? ""))
    .sort((a, b) => b.clockIn - a.clockIn)
    .map((entry) => {
      const invoice = byEntry.get(entry.id);
      return {
        entry,
        state: invoice?.status ?? "unbilled",
        invoiceNumber: invoice?.number ?? "",
        amount: amountForEntry(store, entry),
      };
    });
}

export function formatWorkSpan(start?: number, end?: number): string {
  if (typeof start !== "number" || typeof end !== "number" || Number.isNaN(start) || Number.isNaN(end)) return "";
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const left = new Date(start).toLocaleDateString("en-US", options);
  const right = new Date(end).toLocaleDateString("en-US", options);
  return left === right ? left : `${left} – ${right}`;
}

export function updateInvoice(
  store: Store,
  id: string,
  patch: { showWork?: boolean; adjustments?: InvoiceAdjustment[] },
): Store | { ok: false; error: string } {
  const current = store.invoices.find((invoice) => invoice.id === id);
  if (!current) return { ok: false, error: "That invoice is missing." };
  let adjustments = current.adjustments ?? [];
  if (patch.adjustments) {
    if (patch.adjustments.length > 12) return { ok: false, error: "Keep adjustments to a dozen." };
    const next: InvoiceAdjustment[] = [];
    for (const item of patch.adjustments) {
      if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) return { ok: false, error: "Enter an amount." };
      const label = item.label.trim().replace(/\s+/g, " ").slice(0, 40) || (item.amount < 0 ? "Discount" : "Charge");
      next.push({ id: item.id || crypto.randomUUID(), label, amount: roundMoney(item.amount) });
    }
    adjustments = next;
  }
  const invoice: Invoice = {
    ...current,
    adjustments,
    showWork: patch.showWork ?? current.showWork !== false,
  };
  return { ...store, invoices: store.invoices.map((item) => (item.id === id ? invoice : item)) };
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
  const chosen = ids
    .map((id) => store.entries.find((item) => item.id === id))
    .filter((entry): entry is Entry => Boolean(entry));
  const periodStart = chosen.length ? Math.min(...chosen.map((entry) => entry.clockIn)) : now;
  const periodEnd = chosen.length ? Math.max(...chosen.map((entry) => entry.clockOut ?? entry.clockIn)) : now;
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
    adjustments: [],
    showWork: true,
    periodStart,
    periodEnd,
  };
  return {
    ...store,
    invoices: [invoice, ...store.invoices],
    settings: { ...store.settings, nextNumber: next + 1 },
  };
}
