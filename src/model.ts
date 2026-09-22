export type Origin = "clock" | "manual";

export type Entry = {
  id: string;
  clockIn: number;
  clockOut: number | null;
  comment: string;
  origin?: Origin;
};

export type RangeKey = "today" | "week" | "month" | "all";

export type PlaceResult = { ok: true; entries: Entry[] } | { ok: false; error: string };

const STORAGE_KEY = "horas.v1";

export function loadEntries(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export function saveEntries(entries: Entry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function isOrigin(value: unknown): value is Origin {
  return value === "clock" || value === "manual";
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Entry>;
  const originOk = entry.origin === undefined || isOrigin(entry.origin);
  return (
    typeof entry.id === "string" &&
    typeof entry.clockIn === "number" &&
    (entry.clockOut === null || typeof entry.clockOut === "number") &&
    typeof entry.comment === "string" &&
    originOk
  );
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
  next: Pick<Entry, "clockIn" | "clockOut">,
  ignoreId?: string,
  now = Date.now(),
): string | null {
  if (!timesAreValid(next.clockIn, next.clockOut)) {
    return "La salida tiene que ser posterior a la entrada.";
  }
  if (next.clockOut === null && entries.some((entry) => entry.id !== ignoreId && entry.clockOut === null)) {
    return "Ya hay un tramo en curso. Ciérralo antes de dejar este abierto.";
  }
  const probe = { id: ignoreId ?? "__new__", clockIn: next.clockIn, clockOut: next.clockOut };
  const clash = entries.find((entry) => entry.id !== ignoreId && intervalsOverlap(probe, entry, now));
  if (clash) {
    const end = clash.clockOut === null ? "ahora" : formatClock(clash.clockOut);
    return `Se cruza con ${formatClock(clash.clockIn)}–${end}.`;
  }
  return null;
}

function sortNewest(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.clockIn - a.clockIn);
}

export function clockIn(entries: Entry[], now = Date.now()): PlaceResult {
  const next: Entry = { id: crypto.randomUUID(), clockIn: now, clockOut: null, comment: "", origin: "clock" };
  const error = placementError(entries, next, undefined, now);
  if (error) return { ok: false, error };
  return { ok: true, entries: [next, ...entries] };
}

export function clockOut(entries: Entry[], now = Date.now()): Entry[] {
  return entries.map((entry) =>
    entry.clockOut === null ? { ...entry, clockOut: Math.max(now, entry.clockIn) } : entry,
  );
}

export function addManual(entries: Entry[], draft: { clockIn: number; clockOut: number; comment: string }): PlaceResult {
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

export function entriesInRange(entries: Entry[], key: RangeKey, now = new Date()): Entry[] {
  const { start, end } = rangeBounds(key, now);
  if (start === null || end === null) return entries;
  return entries.filter((entry) => entry.clockIn >= start && entry.clockIn <= end);
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

export function toCsv(entries: Entry[], now = Date.now()): string {
  const sorted = [...entries].sort((a, b) => a.clockIn - b.clockIn);
  const header = "Fecha;Entrada;Salida;Duración;Horas;Comentario;Estado;Origen";
  const lines = sorted.map((entry) => {
    const fecha = new Date(entry.clockIn).toLocaleDateString("es-ES");
    const parts = durationParts(trackedMs(entry, now));
    return [
      fecha,
      formatClock(entry.clockIn),
      entry.clockOut === null ? "" : formatClock(entry.clockOut),
      parts.hhmm,
      parts.decimal,
      csvCell(entry.comment),
      entry.clockOut === null ? "en curso" : "cerrado",
      originOf(entry) === "manual" ? "manual" : "fichaje",
    ].join(";");
  });
  const parts = durationParts(totalMs(sorted, now));
  const total = ["Total", "", "", parts.hhmm, parts.decimal, "", "", ""].join(";");
  return `\uFEFF${[header, ...lines, total].join("\r\n")}`;
}

export function toBackup(entries: Entry[]): string {
  return JSON.stringify({ version: 1, entries }, null, 2);
}

export function parseBackup(raw: string): Entry[] {
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!parsed || !Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) {
    throw new Error("El archivo no es una copia de Horas.");
  }
  return parsed.entries;
}

export function mergeEntries(current: Entry[], incoming: Entry[]): Entry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return sortNewest([...byId.values()]);
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
