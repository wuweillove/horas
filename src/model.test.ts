import assert from "node:assert/strict";
import test from "node:test";
import {
  clockIn,
  clockOut,
  durationMs,
  entriesInRange,
  mergeEntries,
  parseBackup,
  rangeBounds,
  toCsv,
  totalMs,
  trackedMs,
  type Entry,
} from "./model.ts";

const monday = new Date(2026, 8, 21, 15, 0, 0, 0);

function entry(partial: Partial<Entry> & Pick<Entry, "id" | "clockIn">): Entry {
  return { clockOut: null, comment: "", ...partial };
}

test("clock in once and clock out", () => {
  const start = new Date(2026, 8, 21, 9, 0, 0, 0).getTime();
  const started = clockIn([], start);
  assert.equal(started.length, 1);
  assert.equal(clockIn(started, start + 1000).length, 1);
  const ended = clockOut(started, start + 90 * 60 * 1000);
  assert.equal(ended[0].clockOut, start + 90 * 60 * 1000);
  assert.equal(durationMs(ended[0], start + 999999), 90 * 60 * 1000);
});

test("week starts on Monday and month starts on the first", () => {
  const week = rangeBounds("week", monday);
  assert.equal(new Date(week.start!).getDay(), 1);
  assert.equal(new Date(week.start!).getDate(), 21);
  const month = rangeBounds("month", monday);
  assert.equal(new Date(month.start!).getDate(), 1);
});

test("range filter uses the clock-in day", () => {
  const today = new Date(2026, 8, 21, 9, 30).getTime();
  const yesterday = new Date(2026, 8, 20, 18, 0).getTime();
  const entries = [
    entry({ id: "a", clockIn: today, comment: "hoy" }),
    entry({ id: "b", clockIn: yesterday, comment: "ayer" }),
  ];
  const filtered = entriesInRange(entries, "today", monday);
  assert.deepEqual(filtered.map((item) => item.id), ["a"]);
});

test("csv escapes comments and adds a total row", () => {
  const start = new Date(2026, 8, 21, 9, 0).getTime();
  const end = start + 150 * 60 * 1000;
  const csv = toCsv([entry({ id: "a", clockIn: start, clockOut: end, comment: 'dijo "hola"; y siguió' })], end);
  assert.match(csv, /^\uFEFFFecha;Entrada;Salida;Duración;Horas;Comentario;Estado/);
  assert.match(csv, /"dijo ""hola""; y siguió"/);
  assert.match(csv, /02:30;2,50/);
  assert.match(csv, /Total;;;02:30;2,50/);
  assert.equal(totalMs([entry({ id: "a", clockIn: start, clockOut: end })], end), 150 * 60 * 1000);
});

test("reported minutes follow the clocks, not the leftover seconds", () => {
  const start = new Date(2026, 8, 21, 21, 30, 50).getTime();
  const end = new Date(2026, 8, 21, 21, 31, 10).getTime();
  const item = entry({ id: "a", clockIn: start, clockOut: end, comment: "cruce" });
  assert.ok(durationMs(item, end) < 60_000);
  assert.equal(trackedMs(item, end), 60_000);
  assert.match(toCsv([item], end), /00:01;0,02/);
});

test("backup merge replaces the same id and keeps the rest", () => {
  const current = [entry({ id: "a", clockIn: 2, comment: "viejo" }), entry({ id: "b", clockIn: 1, comment: "se queda" })];
  const incoming = parseBackup(JSON.stringify({ version: 1, entries: [entry({ id: "a", clockIn: 3, comment: "nuevo" })] }));
  const merged = mergeEntries(current, incoming);
  assert.deepEqual(
    merged.map((item) => item.comment),
    ["nuevo", "se queda"],
  );
  assert.throws(() => parseBackup("{"), /JSON|archivo|Unexpected/i);
});
