export type Entry = {
  id: string;
  clockIn: number;
  clockOut: number | null;
  comment: string;
};

export type RangeKey = "today" | "week" | "month" | "all";

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

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Entry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.clockIn === "number" &&
    (entry.clockOut === null || typeof entry.clockOut === "number") &&
    typeof entry.comment === "string"
  );
}

export function openEntry(entries: Entry[]): Entry | undefined {
  return entries.find((entry) => entry.clockOut === null);
}

export function clockIn(entries: Entry[], now = Date.now()): Entry[] {
  if (openEntry(entries)) return entries;
  const next: Entry = {
    id: crypto.randomUUID(),
    clockIn: now,
    clockOut: null,
    comment: "",
  };
  return [next, ...entries];
}

export function clockOut(entries: Entry[], now = Date.now()): Entry[] {
  return entries.map((entry) =>
    entry.clockOut === null ? { ...entry, clockOut: Math.max(now, entry.clockIn) } : entry,
  );
}

export function updateEntry(entries: Entry[], id: string, patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment">>): Entry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
}

export function deleteEntry(entries: Entry[], id: string): Entry[] {
  return entries.filter((entry) => entry.id !== id);
}

export function durationMs(entry: Entry, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  return Math.max(0, end - entry.clockIn);
}

export function trackedMs(entry: Entry, now = Date.now()): number {
  const end = entry.clockOut ?? now;
  const minutes = Math.floor(end / 60_000) - Math.floor(entry.clockIn / 60_000);
  return Math.max(0, minutes) * 60_000;
}

export function totalMs(entries: Entry[], now = Date.now()): number {
  return entries.reduce((sum, entry) => sum + trackedMs(entry, now), 0);
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

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
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
  if (diffDays === 0) return `Hoy · ${titled}`;
  if (diffDays === 1) return `Ayer · ${titled}`;
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
  const header = "Fecha;Entrada;Salida;Duración;Horas;Comentario;Estado";
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
    ].join(";");
  });
  const parts = durationParts(totalMs(sorted, now));
  const total = ["Total", "", "", parts.hhmm, parts.decimal, "", ""].join(";");
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
  return [...byId.values()].sort((a, b) => b.clockIn - a.clockIn);
}

export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function timesAreValid(clockInAt: number, clockOutAt: number | null): boolean {
  if (Number.isNaN(clockInAt)) return false;
  if (clockOutAt === null) return true;
  return !Number.isNaN(clockOutAt) && clockOutAt >= clockInAt;
}
