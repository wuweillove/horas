export type Origin = "clock" | "manual";

export type Job = {
  id: string;
  name: string;
};

export type Entry = {
  id: string;
  clockIn: number;
  clockOut: number | null;
  comment: string;
  origin?: Origin;
  jobId?: string;
};

export type Store = {
  version: 2;
  jobs: Job[];
  activeJobId: string;
  entries: Entry[];
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
  return (
    typeof entry.id === "string" &&
    typeof entry.clockIn === "number" &&
    (entry.clockOut === null || typeof entry.clockOut === "number") &&
    typeof entry.comment === "string" &&
    originOk &&
    jobOk
  );
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
  while (taken.has(`trabajo ${n}`)) n += 1;
  return `Trabajo ${n}`;
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
  return slug || "trabajo";
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
  return store.entries.length === 0 && store.deletedIds.length === 0 && store.savedAt === 0;
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
  const job: Job = { id: crypto.randomUUID(), name: "Trabajo 1" };
  return { version: 2, jobs: [job], activeJobId: job.id, entries: [], vaultId: "", savedAt: 0, deletedIds: [] };
}

export function storeFromEntries(entries: Entry[], jobName = "Trabajo 1"): Store {
  const job: Job = { id: crypto.randomUUID(), name: jobName };
  return {
    version: 2,
    jobs: [job],
    activeJobId: job.id,
    entries: entries.filter(isEntry).map((entry) => ({ ...entry, jobId: entry.jobId ?? job.id })),
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

export function normalizeStore(data: unknown): Store | null {
  if (Array.isArray(data)) return storeFromEntries(data.filter(isEntry));
  if (!data || typeof data !== "object") return null;
  const value = data as {
    version?: unknown;
    jobs?: unknown;
    activeJobId?: unknown;
    entries?: unknown;
    vaultId?: unknown;
    savedAt?: unknown;
    deletedIds?: unknown;
  };
  if (value.version === 1 && Array.isArray(value.entries)) {
    const migrated = storeFromEntries(value.entries.filter(isEntry));
    return { ...migrated, vaultId: readVaultId(value), savedAt: readSavedAt(value), deletedIds: readDeletedIds(value) };
  }
  if (value.version !== 2 || !Array.isArray(value.jobs) || !Array.isArray(value.entries)) return null;
  const jobs = value.jobs.filter(isJob).map((job) => ({ id: job.id, name: job.name.trim().slice(0, 40) }));
  if (jobs.length === 0) {
    const migrated = storeFromEntries(value.entries.filter(isEntry));
    return { ...migrated, vaultId: readVaultId(value), savedAt: readSavedAt(value), deletedIds: readDeletedIds(value) };
  }
  const deletedIds = readDeletedIds(value);
  const deleted = new Set(deletedIds);
  const liveJobs = jobs.filter((job) => !deleted.has(job.id));
  const sealedJobs = liveJobs.length > 0 ? liveJobs : [{ id: crypto.randomUUID(), name: "Trabajo 1" }];
  const jobFallback = sealedJobs[0].id;
  const entries = value.entries
    .filter(isEntry)
    .filter((entry) => !deleted.has(entry.id))
    .map((entry) => ({
      ...entry,
      jobId: sealedJobs.some((job) => job.id === entry.jobId) ? entry.jobId : jobFallback,
    }));
  const activeJobId = sealedJobs.some((job) => job.id === value.activeJobId)
    ? (value.activeJobId as string)
    : jobFallback;
  return {
    version: 2,
    jobs: sealedJobs,
    activeJobId,
    entries,
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
    const alreadyV2 =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === 2;
    if (!alreadyV2) saveStore(store);
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
  if (!normalized) return { ok: false, error: "Ponle un nombre al trabajo." };
  const job: Job = { id: crypto.randomUUID(), name: normalized };
  return { ...store, jobs: [...store.jobs, job], activeJobId: job.id };
}

export function renameJob(store: Store, id: string, name: string): Store | { ok: false; error: string } {
  const normalized = normalizeJobName(name);
  if (!normalized) return { ok: false, error: "Ponle un nombre al trabajo." };
  if (!store.jobs.some((job) => job.id === id)) return { ok: false, error: "No encuentro ese trabajo." };
  return { ...store, jobs: store.jobs.map((job) => (job.id === id ? { ...job, name: normalized } : job)) };
}

export function deleteJob(store: Store, id: string): Store | { ok: false; error: string } {
  if (store.jobs.length < 2) return { ok: false, error: "Tiene que quedar al menos un trabajo." };
  if (!store.jobs.some((job) => job.id === id)) return { ok: false, error: "No encuentro ese trabajo." };
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
  if (!store.jobs.some((job) => job.id === id)) return { ok: false, error: "No encuentro ese trabajo." };
  return { ...store, activeJobId: id };
}

export function originOf(entry: Entry): Origin {
  return entry.origin ?? "clock";
}

export function openEntry(entries: Entry[]): Entry | undefined {
  return entries.find((entry) => entry.clockOut === null);
}

export function durationMs(entry: Pick<Entry, "clockIn" | "clockOut">, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  return Math.max(0, end - entry.clockIn);
}

export function trackedMs(entry: Pick<Entry, "clockIn" | "clockOut">, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  const minutes = Math.floor(end / 60_000) - Math.floor(entry.clockIn / 60_000);
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

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export function placementError(
  entries: Entry[],
  next: Pick<Entry, "clockIn" | "clockOut" | "jobId">,
  ignoreId?: string,
  now = Date.now(),
): string | null {
  if (!timesAreValid(next.clockIn, next.clockOut)) {
    return "La salida tiene que ser posterior a la entrada.";
  }
  if (next.clockOut === null && entries.some((entry) => entry.id !== ignoreId && entry.clockOut === null)) {
    return "Ya hay un tramo en curso. Ciérralo antes de dejar este abierto.";
  }
  const probe = { id: ignoreId ?? "__new__", clockIn: next.clockIn, clockOut: next.clockOut, jobId: next.jobId };
  const clash = entries.find(
    (entry) => entry.id !== ignoreId && sameJob(entry, next) && intervalsOverlap(probe, entry, now),
  );
  if (clash) {
    const end = clash.clockOut === null ? "ahora" : formatClock(clash.clockOut);
    return `Se cruza con ${formatClock(clash.clockIn)}–${end}.`;
  }
  return null;
}

function sortNewest(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.clockIn - a.clockIn);
}

export function clockIn(entries: Entry[], now = Date.now(), jobId?: string): PlaceResult {
  const next: Entry = { id: crypto.randomUUID(), clockIn: now, clockOut: null, comment: "", origin: "clock", jobId };
  const error = placementError(entries, next, undefined, now);
  if (error) return { ok: false, error };
  return { ok: true, entries: [next, ...entries] };
}

export function clockOut(entries: Entry[], now = Date.now(), jobId?: string): Entry[] {
  return entries.map((entry) =>
    entry.clockOut === null && (jobId === undefined || jobIdOf(entry, jobId) === jobId)
      ? { ...entry, clockOut: Math.max(now, entry.clockIn) }
      : entry,
  );
}

export function addManual(
  entries: Entry[],
  draft: { clockIn: number; clockOut: number; comment: string; jobId?: string },
): PlaceResult {
  if (Number.isNaN(draft.clockIn) || Number.isNaN(draft.clockOut)) {
    return { ok: false, error: "Falta la hora de entrada o de salida." };
  }
  if (trackedMs({ clockIn: draft.clockIn, clockOut: draft.clockOut }) < 60_000) {
    return { ok: false, error: "El tramo tiene que durar al menos un minuto." };
  }
  const next: Entry = {
    id: crypto.randomUUID(),
    clockIn: draft.clockIn,
    clockOut: draft.clockOut,
    comment: draft.comment.trim(),
    origin: "manual",
    jobId: draft.jobId,
  };
  const error = placementError(entries, next, undefined, draft.clockOut);
  if (error) return { ok: false, error };
  return { ok: true, entries: sortNewest([next, ...entries]) };
}

export function updateEntry(entries: Entry[], id: string, patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment">>): PlaceResult {
  const current = entries.find((entry) => entry.id === id);
  if (!current) return { ok: false, error: "No encuentro ese registro." };
  const next = { ...current, ...patch };
  if (patch.clockIn !== undefined || patch.clockOut !== undefined) {
    const error = placementError(entries, next, id, next.clockOut ?? Date.now());
    if (error) return { ok: false, error };
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

export function rangeBounds(key: RangeKey, now = new Date()): { start: number | null; end: number | null } {
  if (key === "all") return { start: null, end: null };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (key === "week") {
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
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
  if (clockOut === null) return "ahora";
  const label = formatClock(clockOut);
  const days = dayShift(clockIn, clockOut);
  if (days <= 0) return label;
  return `${label} +${days}`;
}

export function entriesInRange(entries: Entry[], key: RangeKey, now = new Date()): Entry[] {
  const { start, end } = rangeBounds(key, now);
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
  const rest = date.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const titled = rest.charAt(0).toUpperCase() + rest.slice(1);
  if (diffDays === 0) return `Hoy, ${titled}`;
  if (diffDays === 1) return `Ayer, ${titled}`;
  return titled;
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
    decimal: (totalMinutes / 60).toFixed(2).replace(".", ","),
  };
}

export function toCsv(entries: Entry[], now = Date.now(), jobs: Job[] = []): string {
  const sorted = [...entries].sort((a, b) => a.clockIn - b.clockIn);
  const header = "Fecha;Trabajo;Entrada;Salida;Duración;Horas;Comentario;Estado;Origen";
  const lines = sorted.map((entry) => {
    const fecha = new Date(entry.clockIn).toLocaleDateString("es-ES");
    const parts = durationParts(trackedMs(entry, now));
    return [
      fecha,
      csvCell(jobNameOf(jobs, entry.jobId)),
      formatClock(entry.clockIn),
      entry.clockOut === null ? "" : formatOutLabel(entry.clockIn, entry.clockOut),
      parts.hhmm,
      parts.decimal,
      csvCell(entry.comment),
      entry.clockOut === null ? "en curso" : "cerrado",
      originOf(entry) === "manual" ? "manual" : "fichaje",
    ].join(";");
  });
  const parts = durationParts(totalMs(sorted, now));
  const total = ["Total", "", "", "", parts.hhmm, parts.decimal, "", "", ""].join(";");
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
    throw new Error("El archivo no es una copia de Horas.");
  }
  const store = normalizeStore(parsed);
  if (!store) throw new Error("El archivo no es una copia de Horas.");
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

function combineStores(left: Store, right: Store, mode: "incoming" | "later"): Store {
  const primary = mode === "incoming" ? right : right.savedAt >= left.savedAt ? right : left;
  const secondary = primary === right ? left : right;
  const liveIds = new Set([...primary.entries.map((entry) => entry.id), ...primary.jobs.map((job) => job.id)]);
  const deleted = new Set(primary.deletedIds);
  for (const id of secondary.deletedIds) {
    if (!liveIds.has(id)) deleted.add(id);
  }

  const jobsById = new Map<string, Job>();
  for (const job of [...secondary.jobs, ...primary.jobs]) {
    if (!deleted.has(job.id)) jobsById.set(job.id, job);
  }
  const jobs = orderJobs(secondary.jobs, primary.jobs, jobsById);
  const sealedJobs = jobs.length > 0 ? jobs : [{ id: crypto.randomUUID(), name: "Trabajo 1" }];
  const fallback = sealedJobs[0].id;

  const entriesById = new Map<string, Entry>();
  for (const entry of [...secondary.entries, ...primary.entries]) {
    if (!deleted.has(entry.id)) entriesById.set(entry.id, entry);
  }
  const entries = sortNewest([...entriesById.values()]).map((entry) => ({
    ...entry,
    jobId: sealedJobs.some((job) => job.id === entry.jobId) ? entry.jobId : fallback,
  }));

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
    version: 2,
    jobs: sealedJobs,
    activeJobId,
    entries,
    vaultId,
    savedAt: Math.max(left.savedAt, right.savedAt),
    deletedIds: uniqueIds([...deleted]),
  };
}

export function mergeStores(current: Store, incoming: Store): Store {
  return combineStores(current, incoming, "incoming");
}

export function durableMerge(left: Store, right: Store): Store {
  if (isBlankStore(left) && !isBlankStore(right)) return right;
  if (isBlankStore(right) && !isBlankStore(left)) return left;
  if (isBlankStore(left) && isBlankStore(right)) {
    return left.vaultId ? left : right.vaultId ? right : left;
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
