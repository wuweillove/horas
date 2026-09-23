export type Origin = "clock" | "manual";

export type Job = {
  id: string;
  name: string;
  clientId?: string;
  hourlyRate?: number;
};

export type BreakSpan = {
  start: number;
  end: number | null;
};

export type Entry = {
  id: string;
  clockIn: number;
  clockOut: number | null;
  comment: string;
  origin?: Origin;
  jobId?: string;
  billable?: boolean;
  breaks?: BreakSpan[];
};

export type Client = {
  id: string;
  name: string;
  email: string;
  address: string;
  hourlyRate: number;
};

export type InvoiceStatus = "draft" | "sent" | "paid";

export type InvoiceLine = {
  entryId: string;
  date: string;
  job: string;
  hours: number;
  rate: number;
  amount: number;
  comment: string;
};

export type Invoice = {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  clientAddress: string;
  entryIds: string[];
  lines: InvoiceLine[];
  issuedAt: number;
  status: InvoiceStatus;
  taxPercent: number;
  notes: string;
  currency: string;
};

export type PaletteId = "salvia" | "tiza" | "oxido";
export type WeekStart = "monday" | "sunday";

export type Settings = {
  businessName: string;
  email: string;
  address: string;
  currency: string;
  taxPercent: number;
  nextNumber: number;
  palette: PaletteId;
  weekStart: WeekStart;
  nightHour: number;
};

export type Store = {
  version: 3;
  jobs: Job[];
  activeJobId: string;
  entries: Entry[];
  clients: Client[];
  invoices: Invoice[];
  settings: Settings;
  vaultId: string;
  savedAt: number;
  deletedIds: string[];
};

export type RangeKey = "today" | "week" | "month" | "all";

export type PlaceResult = { ok: true; entries: Entry[] } | { ok: false; error: string };

export const STORAGE_KEY = "horas.v1";
export const VAULT_HEX_LENGTH = 20;

function isOrigin(value: unknown): value is Origin {
  return value === "clock" || value === "manual";
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<Job>;
  return typeof job.id === "string" && typeof job.name === "string" && job.name.trim() !== "";
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Entry>;
  const originOk = entry.origin === undefined || isOrigin(entry.origin);
  const jobOk = entry.jobId === undefined || typeof entry.jobId === "string";
  const billOk = entry.billable === undefined || typeof entry.billable === "boolean";
  return (
    typeof entry.id === "string" &&
    typeof entry.clockIn === "number" &&
    (entry.clockOut === null || typeof entry.clockOut === "number") &&
    typeof entry.comment === "string" &&
    originOk &&
    jobOk &&
    billOk
  );
}

export function isBillable(entry: Pick<Entry, "billable">): boolean {
  return entry.billable !== false;
}

function isBreakSpan(value: unknown): value is BreakSpan {
  if (!value || typeof value !== "object") return false;
  const span = value as Partial<BreakSpan>;
  return typeof span.start === "number" && (span.end === null || typeof span.end === "number");
}

export function sealBreaks(value: unknown): BreakSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const breaks = value.filter(isBreakSpan).map((span) => ({
    start: span.start,
    end: span.end === null ? null : Math.max(span.end, span.start),
  }));
  return breaks.length > 0 ? breaks : undefined;
}

export function onBreak(entry: Pick<Entry, "breaks">): boolean {
  return (entry.breaks ?? []).some((span) => span.end === null);
}

function withBreaks(entry: Entry): Entry {
  const breaks = sealBreaks(entry.breaks);
  const next = { ...entry };
  if (breaks) next.breaks = breaks;
  else delete next.breaks;
  return next;
}

export function defaultSettings(): Settings {
  return {
    businessName: "",
    email: "",
    address: "",
    currency: "USD",
    taxPercent: 0,
    nextNumber: 1,
    palette: "salvia",
    weekStart: "monday",
    nightHour: 19,
  };
}

export function dayHour(nightHour: number): number {
  return (Math.floor(nightHour) + 12) % 24;
}

const PALETTE_TONE = {
  salvia: {
    day: { wall: "#3e4a46", running: "#25408f", paused: "#5f6c67" },
    night: { wall: "#161c1b", running: "#24356b", paused: "#3a4440" },
  },
  tiza: {
    day: { wall: "#6a7872", running: "#25408f", paused: "#8a9691" },
    night: { wall: "#1c2421", running: "#24356b", paused: "#3d4944" },
  },
  oxido: {
    day: { wall: "#5c463c", running: "#9c3b24", paused: "#7a655c" },
    night: { wall: "#1a1411", running: "#8f4a38", paused: "#4a3b34" },
  },
} as const;

export function paletteTone(palette: PaletteId, night: boolean): { wall: string; running: string; paused: string } {
  return PALETTE_TONE[palette][night ? "night" : "day"];
}

function clientsOf(store: { clients?: Client[] }): Client[] {
  return Array.isArray(store.clients) ? store.clients : [];
}

function invoicesOf(store: { invoices?: Invoice[] }): Invoice[] {
  return Array.isArray(store.invoices) ? store.invoices : [];
}

function settingsOf(store: { settings?: Settings }): Settings {
  return { ...defaultSettings(), ...readSettings(store.settings) };
}

export function jobIdOf(entry: Entry, fallback = ""): string {
  return entry.jobId ?? fallback;
}

export function sameJob(a: Pick<Entry, "jobId">, b: Pick<Entry, "jobId">): boolean {
  return (a.jobId ?? "") === (b.jobId ?? "");
}

export function jobNameOf(jobs: Job[], jobId: string | undefined): string {
  if (!jobId) return "";
  return jobs.find((job) => job.id === jobId)?.name ?? "";
}

export function entriesForJob(entries: Entry[], jobId: string): Entry[] {
  return entries.filter((entry) => jobIdOf(entry, jobId) === jobId);
}

export function nextJobName(jobs: Job[]): string {
  let n = jobs.length + 1;
  const taken = new Set(jobs.map((job) => job.name.trim().toLowerCase()));
  while (taken.has(`job ${n}`)) n += 1;
  return `Job ${n}`;
}

export function normalizeJobName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.slice(0, 40);
}

export function jobSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "job";
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

export function newVaultId(): string {
  const bytes = new Uint8Array(VAULT_HEX_LENGTH / 2);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeVaultId(raw: string): string | null {
  const id = raw.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  return id.length === VAULT_HEX_LENGTH ? id : null;
}

export function formatVaultId(id: string): string {
  const normalized = normalizeVaultId(id);
  if (!normalized) return "";
  return normalized.replace(/(.{4})(?=.)/g, "$1-");
}

export function isBlankStore(store: Store): boolean {
  return (
    store.entries.length === 0 &&
    (store.deletedIds?.length ?? 0) === 0 &&
    clientsOf(store).length === 0 &&
    invoicesOf(store).length === 0
  );
}

let bootVaultId = "";

export function ensureVault(store: Store): Store {
  const vaultId = normalizeVaultId(store.vaultId) ?? "";
  const deletedIds = uniqueIds(store.deletedIds ?? []);
  if (vaultId) {
    if (!bootVaultId) bootVaultId = vaultId;
    return { ...store, vaultId, deletedIds };
  }
  if (!bootVaultId) bootVaultId = newVaultId();
  return { ...store, vaultId: bootVaultId, deletedIds };
}

export function stampStore(store: Store, at = Date.now()): Store {
  return ensureVault({ ...store, savedAt: at });
}

export function emptyStore(): Store {
  const job: Job = { id: crypto.randomUUID(), name: "Job 1" };
  return {
    version: 3,
    jobs: [job],
    activeJobId: job.id,
    entries: [],
    clients: [],
    invoices: [],
    settings: defaultSettings(),
    vaultId: "",
    savedAt: 0,
    deletedIds: [],
  };
}

export function storeFromEntries(entries: Entry[], jobName = "Job 1"): Store {
  const job: Job = { id: crypto.randomUUID(), name: jobName };
  return {
    version: 3,
    jobs: [job],
    activeJobId: job.id,
    entries: entries.filter(isEntry).map((entry) => withBreaks({ ...entry, jobId: entry.jobId ?? job.id, billable: entry.billable !== false })),
    clients: [],
    invoices: [],
    settings: defaultSettings(),
    vaultId: "",
    savedAt: 0,
    deletedIds: [],
  };
}

function readDeletedIds(value: { deletedIds?: unknown }): string[] {
  if (!Array.isArray(value.deletedIds)) return [];
  return uniqueIds(value.deletedIds.filter((id): id is string => typeof id === "string"));
}

function readSavedAt(value: { savedAt?: unknown }): number {
  return typeof value.savedAt === "number" && Number.isFinite(value.savedAt) && value.savedAt >= 0 ? value.savedAt : 0;
}

function readVaultId(value: { vaultId?: unknown }): string {
  return typeof value.vaultId === "string" ? (normalizeVaultId(value.vaultId) ?? "") : "";
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function cleanRate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100) / 100;
}

function sealJob(job: Job): Job {
  const next: Job = { id: job.id, name: job.name.trim().slice(0, 40) };
  if (typeof job.clientId === "string" && job.clientId) next.clientId = job.clientId;
  const rate = cleanRate(job.hourlyRate);
  if (rate !== undefined) next.hourlyRate = rate;
  return next;
}

function isClient(value: unknown): value is Client {
  if (!value || typeof value !== "object") return false;
  const client = value as Partial<Client>;
  return typeof client.id === "string" && typeof client.name === "string" && client.name.trim() !== "";
}

function sealClient(client: Client): Client {
  return {
    id: client.id,
    name: cleanText(client.name, 80),
    email: cleanText(client.email, 120),
    address: cleanText(client.address, 240),
    hourlyRate: cleanRate(client.hourlyRate) ?? 0,
  };
}

function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return value === "draft" || value === "sent" || value === "paid";
}

function isInvoiceLine(value: unknown): value is InvoiceLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<InvoiceLine>;
  return (
    typeof line.entryId === "string" &&
    typeof line.date === "string" &&
    typeof line.job === "string" &&
    typeof line.hours === "number" &&
    typeof line.rate === "number" &&
    typeof line.amount === "number" &&
    typeof line.comment === "string"
  );
}

function isInvoice(value: unknown): value is Invoice {
  if (!value || typeof value !== "object") return false;
  const invoice = value as Partial<Invoice>;
  return (
    typeof invoice.id === "string" &&
    typeof invoice.number === "string" &&
    typeof invoice.clientId === "string" &&
    typeof invoice.issuedAt === "number" &&
    isInvoiceStatus(invoice.status)
  );
}

function sealInvoice(invoice: Invoice): Invoice {
  const lines = Array.isArray(invoice.lines) ? invoice.lines.filter(isInvoiceLine) : [];
  const entryIds = uniqueIds(
    (Array.isArray(invoice.entryIds) ? invoice.entryIds.filter((id) => typeof id === "string") : lines.map((line) => line.entryId)),
  );
  const tax = cleanRate(invoice.taxPercent) ?? 0;
  return {
    id: invoice.id,
    number: cleanText(invoice.number, 20) || "H-0001",
    clientId: invoice.clientId,
    clientName: cleanText(invoice.clientName, 80),
    clientEmail: cleanText(invoice.clientEmail, 120),
    clientAddress: cleanText(invoice.clientAddress, 240),
    entryIds,
    lines,
    issuedAt: invoice.issuedAt,
    status: invoice.status,
    taxPercent: Math.min(100, tax),
    notes: typeof invoice.notes === "string" ? invoice.notes.trim().slice(0, 500) : "",
    currency: /^[A-Za-z]{3}$/.test(invoice.currency ?? "") ? invoice.currency.toUpperCase() : "USD",
  };
}

function readSettings(value: unknown): Settings {
  const base = defaultSettings();
  if (!value || typeof value !== "object") return base;
  const raw = value as Partial<Settings>;
  const currency = typeof raw.currency === "string" && /^[A-Za-z]{3}$/.test(raw.currency) ? raw.currency.toUpperCase() : base.currency;
  const tax = typeof raw.taxPercent === "number" && Number.isFinite(raw.taxPercent) ? Math.min(100, Math.max(0, raw.taxPercent)) : 0;
  const nextNumber = typeof raw.nextNumber === "number" && raw.nextNumber >= 1 ? Math.floor(raw.nextNumber) : 1;
  const palette: PaletteId = raw.palette === "tiza" || raw.palette === "oxido" ? raw.palette : "salvia";
  const weekStart: WeekStart = raw.weekStart === "sunday" ? "sunday" : "monday";
  const nightHour =
    typeof raw.nightHour === "number" && raw.nightHour >= 0 && raw.nightHour <= 23 ? Math.floor(raw.nightHour) : base.nightHour;
  return {
    businessName: cleanText(raw.businessName, 80),
    email: cleanText(raw.email, 120),
    address: cleanText(raw.address, 240),
    currency,
    taxPercent: Math.round(tax * 100) / 100,
    nextNumber,
    palette,
    weekStart,
    nightHour,
  };
}

function readClients(value: unknown, deleted: Set<string>): Client[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isClient).map(sealClient).filter((client) => client.name && !deleted.has(client.id));
}

function readInvoices(value: unknown, deleted: Set<string>): Invoice[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isInvoice).map(sealInvoice).filter((invoice) => !deleted.has(invoice.id));
}

export function normalizeStore(data: unknown): Store | null {
  if (Array.isArray(data)) return storeFromEntries(data.filter(isEntry));
  if (!data || typeof data !== "object") return null;
  const value = data as {
    version?: unknown;
    jobs?: unknown;
    activeJobId?: unknown;
    entries?: unknown;
    clients?: unknown;
    invoices?: unknown;
    settings?: unknown;
    vaultId?: unknown;
    savedAt?: unknown;
    deletedIds?: unknown;
  };
  if (value.version === 1 && Array.isArray(value.entries)) {
    const migrated = storeFromEntries(value.entries.filter(isEntry));
    return { ...migrated, vaultId: readVaultId(value), savedAt: readSavedAt(value), deletedIds: readDeletedIds(value) };
  }
  if ((value.version !== 2 && value.version !== 3) || !Array.isArray(value.jobs) || !Array.isArray(value.entries)) return null;
  const jobs = value.jobs.filter(isJob).map(sealJob);
  if (jobs.length === 0) {
    const migrated = storeFromEntries(value.entries.filter(isEntry));
    return {
      ...migrated,
      clients: readClients(value.clients, new Set()),
      invoices: readInvoices(value.invoices, new Set()),
      settings: readSettings(value.settings),
      vaultId: readVaultId(value),
      savedAt: readSavedAt(value),
      deletedIds: readDeletedIds(value),
    };
  }
  const deletedIds = readDeletedIds(value);
  const deleted = new Set(deletedIds);
  const liveJobs = jobs.filter((job) => !deleted.has(job.id));
  const sealedJobs = liveJobs.length > 0 ? liveJobs : [{ id: crypto.randomUUID(), name: "Job 1" }];
  const jobFallback = sealedJobs[0].id;
  const entries = value.entries
    .filter(isEntry)
    .filter((entry) => !deleted.has(entry.id))
    .map((entry) =>
      withBreaks({
        ...entry,
        billable: entry.billable !== false,
        jobId: sealedJobs.some((job) => job.id === entry.jobId) ? entry.jobId : jobFallback,
      }),
    );
  const activeJobId = sealedJobs.some((job) => job.id === value.activeJobId)
    ? (value.activeJobId as string)
    : jobFallback;
  return {
    version: 3,
    jobs: sealedJobs,
    activeJobId,
    entries,
    clients: readClients(value.clients, deleted),
    invoices: readInvoices(value.invoices, deleted),
    settings: readSettings(value.settings),
    vaultId: readVaultId(value),
    savedAt: readSavedAt(value),
    deletedIds,
  };
}

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as unknown;
    const store = normalizeStore(parsed);
    if (!store) return emptyStore();
    const alreadyV3 =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === 3;
    if (!alreadyV3) saveStore(store);
    return store;
  } catch {
    return emptyStore();
  }
}

export function saveStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function loadEntries(): Entry[] {
  return loadStore().entries;
}

export function saveEntries(entries: Entry[]): void {
  const current = loadStore();
  saveStore({ ...current, entries });
}

export function addJob(store: Store, name: string): Store | { ok: false; error: string } {
  const normalized = normalizeJobName(name);
  if (!normalized) return { ok: false, error: "Give the job a name." };
  const job: Job = { id: crypto.randomUUID(), name: normalized };
  return { ...store, jobs: [...store.jobs, job], activeJobId: job.id };
}

export function renameJob(store: Store, id: string, name: string): Store | { ok: false; error: string } {
  const normalized = normalizeJobName(name);
  if (!normalized) return { ok: false, error: "Give the job a name." };
  if (!store.jobs.some((job) => job.id === id)) return { ok: false, error: "That job is missing." };
  return { ...store, jobs: store.jobs.map((job) => (job.id === id ? { ...job, name: normalized } : job)) };
}

export function deleteJob(store: Store, id: string): Store | { ok: false; error: string } {
  if (store.jobs.length < 2) return { ok: false, error: "Keep at least one job." };
  if (!store.jobs.some((job) => job.id === id)) return { ok: false, error: "That job is missing." };
  const gone = store.entries.filter((entry) => entry.jobId === id).map((entry) => entry.id);
  const jobs = store.jobs.filter((job) => job.id !== id);
  const activeJobId = store.activeJobId === id ? jobs[0].id : store.activeJobId;
  return {
    ...store,
    jobs,
    activeJobId,
    entries: store.entries.filter((entry) => entry.jobId !== id),
    deletedIds: uniqueIds([...store.deletedIds, id, ...gone]),
  };
}

export function setActiveJob(store: Store, id: string): Store | { ok: false; error: string } {
  if (!store.jobs.some((job) => job.id === id)) return { ok: false, error: "That job is missing." };
  return { ...store, activeJobId: id };
}

export function setJobBilling(
  store: Store,
  id: string,
  patch: { clientId?: string | null; hourlyRate?: number | null },
): Store | { ok: false; error: string } {
  const job = store.jobs.find((item) => item.id === id);
  if (!job) return { ok: false, error: "That job is missing." };
  const next: Job = { ...job };
  if (patch.clientId === null || patch.clientId === "") delete next.clientId;
  else if (typeof patch.clientId === "string") {
    if (!store.clients.some((client) => client.id === patch.clientId)) return { ok: false, error: "That client is missing." };
    next.clientId = patch.clientId;
  }
  if (patch.hourlyRate === null) delete next.hourlyRate;
  else if (patch.hourlyRate !== undefined) {
    const rate = cleanRate(patch.hourlyRate);
    if (rate === undefined) return { ok: false, error: "Enter a rate of zero or more." };
    next.hourlyRate = rate;
  }
  return { ...store, jobs: store.jobs.map((item) => (item.id === id ? next : item)) };
}

export function addClient(
  store: Store,
  draft: { name: string; email?: string; address?: string; hourlyRate?: number },
): Store | { ok: false; error: string } {
  const name = cleanText(draft.name, 80);
  if (!name) return { ok: false, error: "Give the client a name." };
  const client: Client = {
    id: crypto.randomUUID(),
    name,
    email: cleanText(draft.email, 120),
    address: cleanText(draft.address, 240),
    hourlyRate: cleanRate(draft.hourlyRate) ?? 0,
  };
  return { ...store, clients: [...clientsOf(store), client] };
}

export function updateClient(
  store: Store,
  id: string,
  draft: { name: string; email?: string; address?: string; hourlyRate?: number },
): Store | { ok: false; error: string } {
  if (!clientsOf(store).some((client) => client.id === id)) return { ok: false, error: "That client is missing." };
  const name = cleanText(draft.name, 80);
  if (!name) return { ok: false, error: "Give the client a name." };
  const next: Client = {
    id,
    name,
    email: cleanText(draft.email, 120),
    address: cleanText(draft.address, 240),
    hourlyRate: cleanRate(draft.hourlyRate) ?? 0,
  };
  return {
    ...store,
    clients: clientsOf(store).map((client) => (client.id === id ? next : client)),
    invoices: invoicesOf(store).map((invoice) =>
      invoice.clientId === id && invoice.status === "draft"
        ? { ...invoice, clientName: next.name, clientEmail: next.email, clientAddress: next.address }
        : invoice,
    ),
  };
}

export function deleteClient(store: Store, id: string): Store | { ok: false; error: string } {
  if (!clientsOf(store).some((client) => client.id === id)) return { ok: false, error: "That client is missing." };
  return {
    ...store,
    clients: clientsOf(store).filter((client) => client.id !== id),
    jobs: store.jobs.map((job) => {
      if (job.clientId !== id) return job;
      const next = { ...job };
      delete next.clientId;
      return next;
    }),
    deletedIds: uniqueIds([...store.deletedIds, id]),
  };
}

export function updateSettings(store: Store, patch: Partial<Settings>): Store {
  return { ...store, settings: readSettings({ ...settingsOf(store), ...patch }) };
}

export function setInvoiceStatus(store: Store, id: string, status: InvoiceStatus): Store | { ok: false; error: string } {
  if (!invoicesOf(store).some((invoice) => invoice.id === id)) return { ok: false, error: "That invoice is missing." };
  return {
    ...store,
    invoices: invoicesOf(store).map((invoice) => (invoice.id === id ? { ...invoice, status } : invoice)),
  };
}

export function deleteInvoice(store: Store, id: string): Store | { ok: false; error: string } {
  if (!invoicesOf(store).some((invoice) => invoice.id === id)) return { ok: false, error: "That invoice is missing." };
  return {
    ...store,
    invoices: invoicesOf(store).filter((invoice) => invoice.id !== id),
    deletedIds: uniqueIds([...store.deletedIds, id]),
  };
}

export function originOf(entry: Entry): Origin {
  return entry.origin ?? "clock";
}

export function openEntry(entries: Entry[]): Entry | undefined {
  return entries.find((entry) => entry.clockOut === null);
}

function rawBreakMs(entry: Pick<Entry, "breaks" | "clockOut">, end: number): number {
  return (entry.breaks ?? []).reduce((sum, span) => {
    const spanEnd = span.end ?? end;
    return sum + Math.max(0, spanEnd - span.start);
  }, 0);
}

export function durationMs(entry: Pick<Entry, "clockIn" | "clockOut" | "breaks">, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  return Math.max(0, end - entry.clockIn - rawBreakMs(entry, end));
}

function spanMinutes(start: number, end: number): number {
  return Math.max(0, Math.floor(end / 60_000) - Math.floor(start / 60_000));
}

export function breakMs(entry: Pick<Entry, "breaks" | "clockOut">, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  const minutes = (entry.breaks ?? []).reduce((sum, span) => sum + spanMinutes(span.start, span.end ?? end), 0);
  return minutes * 60_000;
}

export function trackedMs(entry: Pick<Entry, "clockIn" | "clockOut" | "breaks">, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  const minutes = spanMinutes(entry.clockIn, end) - breakMs(entry, now) / 60_000;
  return Math.max(0, minutes) * 60_000;
}

export function totalMs(entries: Entry[], now = Date.now()): number {
  return entries.reduce((sum, entry) => sum + trackedMs(entry, now), 0);
}

export function timesAreValid(clockInAt: number, clockOutAt: number | null): boolean {
  if (Number.isNaN(clockInAt)) return false;
  if (clockOutAt === null) return true;
  return !Number.isNaN(clockOutAt) && clockOutAt >= clockInAt;
}

export function intervalsOverlap(a: Pick<Entry, "id" | "clockIn" | "clockOut">, b: Pick<Entry, "id" | "clockIn" | "clockOut">, now = Date.now()): boolean {
  if (a.id === b.id) return false;
  const aEnd = a.clockOut ?? now;
  const bEnd = b.clockOut ?? now;
  return a.clockIn < bEnd && b.clockIn < aEnd;
}

/** Local night runs twelve hours, from nightHour until the same hour next morning. */
export function isNight(when = new Date(), nightHour = 19): boolean {
  const hour = when.getHours();
  const start = ((Math.floor(nightHour) % 24) + 24) % 24;
  const end = (start + 12) % 24;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function placementError(
  entries: Entry[],
  next: Pick<Entry, "clockIn" | "clockOut" | "jobId">,
  ignoreId?: string,
  now = Date.now(),
): string | null {
  if (!timesAreValid(next.clockIn, next.clockOut)) {
    return "Clock out has to be after clock in.";
  }
  if (next.clockOut === null && entries.some((entry) => entry.id !== ignoreId && entry.clockOut === null)) {
    return "A timer is already running. Stop it before leaving this one open.";
  }
  const probe = { id: ignoreId ?? "__new__", clockIn: next.clockIn, clockOut: next.clockOut, jobId: next.jobId };
  const clash = entries.find(
    (entry) => entry.id !== ignoreId && sameJob(entry, next) && intervalsOverlap(probe, entry, now),
  );
  if (clash) {
    const end = clash.clockOut === null ? "now" : formatClock(clash.clockOut);
    return `Overlaps ${formatClock(clash.clockIn)}–${end}.`;
  }
  return null;
}

function sortNewest(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.clockIn - a.clockIn);
}

export function clockIn(entries: Entry[], now = Date.now(), jobId?: string): PlaceResult {
  const next: Entry = { id: crypto.randomUUID(), clockIn: now, clockOut: null, comment: "", origin: "clock", jobId, billable: true };
  const error = placementError(entries, next, undefined, now);
  if (error) return { ok: false, error };
  return { ok: true, entries: [next, ...entries] };
}

function closeOpenBreak(entry: Entry, now: number): Entry {
  if (!onBreak(entry)) return entry;
  return {
    ...entry,
    breaks: (entry.breaks ?? []).map((span) => (span.end === null ? { ...span, end: Math.max(now, span.start) } : span)),
  };
}

export function clockOut(entries: Entry[], now = Date.now(), jobId?: string): Entry[] {
  return entries.map((entry) =>
    entry.clockOut === null && (jobId === undefined || jobIdOf(entry, jobId) === jobId)
      ? { ...closeOpenBreak(entry, now), clockOut: Math.max(now, entry.clockIn) }
      : entry,
  );
}

export function startBreak(entries: Entry[], now = Date.now(), jobId?: string): PlaceResult {
  const open = entries.find((entry) => entry.clockOut === null && (jobId === undefined || jobIdOf(entry, jobId) === jobId));
  if (!open) return { ok: false, error: "Start the clock before a break." };
  if (onBreak(open)) return { ok: false, error: "A break is already running." };
  const next = { ...open, breaks: [...(open.breaks ?? []), { start: now, end: null }] };
  return { ok: true, entries: entries.map((entry) => (entry.id === open.id ? next : entry)) };
}

export function resumeBreak(entries: Entry[], now = Date.now(), jobId?: string): PlaceResult {
  const open = entries.find((entry) => entry.clockOut === null && (jobId === undefined || jobIdOf(entry, jobId) === jobId));
  if (!open || !onBreak(open)) return { ok: false, error: "There is no break to resume." };
  return { ok: true, entries: entries.map((entry) => (entry.id === open.id ? closeOpenBreak(entry, now) : entry)) };
}

export function addManual(
  entries: Entry[],
  draft: { clockIn: number; clockOut: number; comment: string; jobId?: string; billable?: boolean },
): PlaceResult {
  if (Number.isNaN(draft.clockIn) || Number.isNaN(draft.clockOut)) {
    return { ok: false, error: "Enter both a start and an end." };
  }
  if (trackedMs({ clockIn: draft.clockIn, clockOut: draft.clockOut }) < 60_000) {
    return { ok: false, error: "A block has to last at least a minute." };
  }
  const next: Entry = {
    id: crypto.randomUUID(),
    clockIn: draft.clockIn,
    clockOut: draft.clockOut,
    comment: draft.comment.trim(),
    origin: "manual",
    jobId: draft.jobId,
    billable: draft.billable !== false,
  };
  const error = placementError(entries, next, undefined, draft.clockOut);
  if (error) return { ok: false, error };
  return { ok: true, entries: sortNewest([next, ...entries]) };
}

export function updateEntry(
  entries: Entry[],
  id: string,
  patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment" | "billable">>,
): PlaceResult {
  const current = entries.find((entry) => entry.id === id);
  if (!current) return { ok: false, error: "That entry is missing." };
  const next = { ...current, ...patch };
  if (patch.clockIn !== undefined || patch.clockOut !== undefined) {
    const error = placementError(entries, next, id, next.clockOut ?? Date.now());
    if (error) return { ok: false, error };
    if (next.clockOut !== null && trackedMs(next) < 60_000) {
      return { ok: false, error: "A block has to last at least a minute." };
    }
  }
  return { ok: true, entries: sortNewest(entries.map((entry) => (entry.id === id ? next : entry))) };
}

export function deleteEntry(entries: Entry[], id: string): Entry[] {
  return entries.filter((entry) => entry.id !== id);
}

export function removeEntry(store: Store, id: string): Store {
  return {
    ...store,
    entries: store.entries.filter((entry) => entry.id !== id),
    deletedIds: uniqueIds([...store.deletedIds, id]),
  };
}

export function rangeBounds(key: RangeKey, now = new Date(), weekStart: WeekStart = "monday"): { start: number | null; end: number | null } {
  if (key === "all") return { start: null, end: null };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (key === "week") {
    const day = start.getDay();
    const diff = weekStart === "sunday" ? day : day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
  } else if (key === "month") {
    start.setDate(1);
  }
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayShift(clockIn: number, clockOut: number): number {
  return Math.round((startOfLocalDay(clockOut) - startOfLocalDay(clockIn)) / 86_400_000);
}

export function formatOutLabel(clockIn: number, clockOut: number | null): string {
  if (clockOut === null) return "now";
  const label = formatClock(clockOut);
  const days = dayShift(clockIn, clockOut);
  if (days <= 0) return label;
  return `${label} +${days}`;
}

export function entriesInRange(entries: Entry[], key: RangeKey, now = new Date(), weekStart: WeekStart = "monday"): Entry[] {
  const { start, end } = rangeBounds(key, now, weekStart);
  if (start === null || end === null) return entries;
  const nowMs = now.getTime();
  return entries.filter((entry) => {
    const from = entry.clockIn;
    const to = entry.clockOut ?? nowMs;
    return from <= end && to >= start;
  });
}

export function formatRunning(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

export function formatDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDayLabel(ms: number, now = new Date()): string {
  const date = new Date(ms);
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startThat = new Date(date);
  startThat.setHours(0, 0, 0, 0);
  const diffDays = Math.round((startToday.getTime() - startThat.getTime()) / 86_400_000);
  const rest = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (diffDays === 0) return `Today, ${rest}`;
  if (diffDays === 1) return `Yesterday, ${rest}`;
  return rest;
}

export type DayGroup = {
  key: string;
  label: string;
  totalMs: number;
  entries: Entry[];
};

export function groupByDay(entries: Entry[], now = new Date()): DayGroup[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = formatDayKey(entry.clockIn);
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.clockIn - a.clockIn);
      return {
        key,
        label: formatDayLabel(sorted[0].clockIn, now),
        totalMs: totalMs(sorted, now.getTime()),
        entries: sorted,
      };
    });
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function durationParts(ms: number): { hhmm: string; decimal: string } {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return {
    hhmm: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    decimal: (totalMinutes / 60).toFixed(2),
  };
}

type CsvDesk = {
  jobs?: Job[];
  clients?: Client[];
  settings?: Pick<Settings, "currency">;
};

export function toCsv(entries: Entry[], now = Date.now(), desk: Job[] | CsvDesk = []): string {
  const jobs = Array.isArray(desk) ? desk : (desk.jobs ?? []);
  const clients = Array.isArray(desk) ? [] : (desk.clients ?? []);
  const currency = Array.isArray(desk) ? "USD" : desk.settings?.currency || "USD";
  const sorted = [...entries].sort((a, b) => a.clockIn - b.clockIn);
  const header = "Date;Job;Client;In;Out;Duration;Hours;Currency;Rate;Amount;Billable;Comment;Status;Origin";
  let amountTotal = 0;
  const lines = sorted.map((entry) => {
    const job = jobs.find((item) => item.id === entry.jobId);
    const client = clients.find((item) => item.id === job?.clientId);
    const rate = typeof job?.hourlyRate === "number" ? job.hourlyRate : (client?.hourlyRate ?? 0);
    const hours = trackedMs(entry, now) / 3_600_000;
    const amount = entry.clockOut === null || !isBillable(entry) ? 0 : Math.round(hours * rate * 100) / 100;
    amountTotal += amount;
    const parts = durationParts(trackedMs(entry, now));
    return [
      new Date(entry.clockIn).toLocaleDateString("en-US"),
      csvCell(jobNameOf(jobs, entry.jobId)),
      csvCell(client?.name ?? ""),
      formatClock(entry.clockIn),
      entry.clockOut === null ? "" : formatOutLabel(entry.clockIn, entry.clockOut),
      parts.hhmm,
      parts.decimal,
      currency,
      rate.toFixed(2),
      amount.toFixed(2),
      isBillable(entry) ? "yes" : "no",
      csvCell(entry.comment),
      entry.clockOut === null ? "open" : "closed",
      originOf(entry) === "manual" ? "manual" : "timer",
    ].join(";");
  });
  const parts = durationParts(totalMs(sorted, now));
  const total = ["Total", "", "", "", "", parts.hhmm, parts.decimal, currency, "", amountTotal.toFixed(2), "", "", "", ""].join(";");
  return `\uFEFF${[header, ...lines, total].join("\r\n")}`;
}

export function toBackup(store: Store): string {
  return JSON.stringify(store, null, 2);
}

export function parseBackup(raw: string): Store {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That file is not a Horas backup.");
  }
  const store = normalizeStore(parsed);
  if (!store) throw new Error("That file is not a Horas backup.");
  return store;
}

export function mergeEntries(current: Entry[], incoming: Entry[]): Entry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return sortNewest([...byId.values()]);
}

function orderJobs(secondary: Job[], primary: Job[], byId: Map<string, Job>): Job[] {
  const ordered: Job[] = [];
  const placed = new Set<string>();
  for (const job of [...secondary, ...primary]) {
    const live = byId.get(job.id);
    if (!live || placed.has(live.id)) continue;
    ordered.push(live);
    placed.add(live.id);
  }
  return ordered;
}

function orderById<T extends { id: string }>(secondary: T[], primary: T[], byId: Map<string, T>): T[] {
  const ordered: T[] = [];
  const placed = new Set<string>();
  for (const item of [...secondary, ...primary]) {
    const live = byId.get(item.id);
    if (!live || placed.has(live.id)) continue;
    ordered.push(live);
    placed.add(live.id);
  }
  return ordered;
}

function mergeSettings(primary: Settings, secondary: Settings): Settings {
  return {
    businessName: primary.businessName || secondary.businessName,
    email: primary.email || secondary.email,
    address: primary.address || secondary.address,
    currency: primary.currency || secondary.currency || "USD",
    taxPercent: Number.isFinite(primary.taxPercent) ? primary.taxPercent : secondary.taxPercent,
    nextNumber: Math.max(primary.nextNumber || 1, secondary.nextNumber || 1),
    palette: primary.palette || secondary.palette,
    weekStart: primary.weekStart || secondary.weekStart,
    nightHour: Number.isFinite(primary.nightHour) ? primary.nightHour : secondary.nightHour,
  };
}

function combineStores(left: Store, right: Store, mode: "incoming" | "later"): Store {
  const primary = mode === "incoming" ? right : right.savedAt >= left.savedAt ? right : left;
  const secondary = primary === right ? left : right;
  const primaryClients = clientsOf(primary);
  const secondaryClients = clientsOf(secondary);
  const primaryInvoices = invoicesOf(primary);
  const secondaryInvoices = invoicesOf(secondary);
  const liveIds = new Set([
    ...primary.entries.map((entry) => entry.id),
    ...primary.jobs.map((job) => job.id),
    ...primaryClients.map((client) => client.id),
    ...primaryInvoices.map((invoice) => invoice.id),
  ]);
  const deleted = new Set(primary.deletedIds ?? []);
  for (const id of secondary.deletedIds ?? []) {
    if (!liveIds.has(id)) deleted.add(id);
  }

  const jobsById = new Map<string, Job>();
  for (const job of [...secondary.jobs, ...primary.jobs]) {
    if (!deleted.has(job.id)) jobsById.set(job.id, job);
  }
  const jobs = orderJobs(secondary.jobs, primary.jobs, jobsById);
  const sealedJobs = jobs.length > 0 ? jobs : [{ id: crypto.randomUUID(), name: "Job 1" }];
  const fallback = sealedJobs[0].id;

  const entriesById = new Map<string, Entry>();
  for (const entry of [...secondary.entries, ...primary.entries]) {
    if (!deleted.has(entry.id)) entriesById.set(entry.id, entry);
  }
  const entries = sortNewest([...entriesById.values()]).map((entry) => ({
    ...entry,
    jobId: sealedJobs.some((job) => job.id === entry.jobId) ? entry.jobId : fallback,
  }));

  const clientsById = new Map<string, Client>();
  for (const client of [...secondaryClients, ...primaryClients]) {
    if (!deleted.has(client.id)) clientsById.set(client.id, client);
  }
  const invoicesById = new Map<string, Invoice>();
  for (const invoice of [...secondaryInvoices, ...primaryInvoices]) {
    if (!deleted.has(invoice.id)) invoicesById.set(invoice.id, invoice);
  }

  const activeJobId = sealedJobs.some((job) => job.id === primary.activeJobId)
    ? primary.activeJobId
    : sealedJobs.some((job) => job.id === secondary.activeJobId)
      ? secondary.activeJobId
      : fallback;

  const vaultId =
    mode === "incoming"
      ? left.vaultId || right.vaultId
      : primary.vaultId || secondary.vaultId;

  return {
    version: 3,
    jobs: sealedJobs,
    activeJobId,
    entries,
    clients: orderById(secondaryClients, primaryClients, clientsById),
    invoices: orderById(secondaryInvoices, primaryInvoices, invoicesById),
    settings: mergeSettings(settingsOf(primary), settingsOf(secondary)),
    vaultId,
    savedAt: Math.max(left.savedAt, right.savedAt),
    deletedIds: uniqueIds([...deleted]),
  };
}

export function mergeStores(current: Store, incoming: Store): Store {
  return combineStores(current, incoming, "incoming");
}

function completeStore(store: Store): Store {
  return normalizeStore(store) ?? store;
}

export function durableMerge(left: Store, right: Store): Store {
  if (isBlankStore(left) && !isBlankStore(right)) return completeStore(right);
  if (isBlankStore(right) && !isBlankStore(left)) return completeStore(left);
  if (isBlankStore(left) && isBlankStore(right)) {
    return completeStore(left.vaultId ? left : right.vaultId ? right : left);
  }
  return combineStores(left, right, "later");
}

export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toDateValue(ms: number): string {
  return toLocalInput(ms).slice(0, 10);
}

export function toTimeValue(ms: number): string {
  return toLocalInput(ms).slice(11, 16);
}

export function combineLocal(date: string, time: string): number {
  if (!date || !time) return Number.NaN;
  return new Date(`${date}T${time}`).getTime();
}
