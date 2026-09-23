import assert from "node:assert/strict";
import test from "node:test";
import {
  addManual,
  clockIn,
  clockOut,
  combineLocal,
  durationMs,
  entriesInRange,
  intervalsOverlap,
  mergeEntries,
  parseBackup,
  placementError,
  rangeBounds,
  formatOutLabel,
  toCsv,
  totalMs,
  trackedMs,
  addJob,
  breakMs,
  deleteJob,
  durableMerge,
  emptyStore,
  ensureVault,
  entriesForJob,
  formatVaultId,
  jobSlug,
  mergeStores,
  normalizeStore,
  isNight,
  onBreak,
  resumeBreak,
  startBreak,
  normalizeVaultId,
  removeEntry,
  renameJob,
  stampStore,
  toBackup,
  updateSettings,
  type Entry,
  type Store,
} from "./model.ts";

const monday = new Date(2026, 8, 21, 15, 0, 0, 0);

function entry(partial: Partial<Entry> & Pick<Entry, "id" | "clockIn">): Entry {
  return { clockOut: null, comment: "", origin: "clock", ...partial };
}

test("palette, week start, and night hour stay on the desk", () => {
  const next = updateSettings(emptyStore(), { palette: "oxido", weekStart: "sunday", nightHour: 21, businessName: "Ada" });
  const again = normalizeStore(JSON.parse(JSON.stringify(next)));
  assert.equal(again?.settings.palette, "oxido");
  assert.equal(again?.settings.weekStart, "sunday");
  assert.equal(again?.settings.nightHour, 21);
  assert.equal(again?.settings.businessName, "Ada");
  const blank = normalizeStore({ version: 3, jobs: next.jobs, entries: [], settings: { currency: "EUR" } });
  assert.equal(blank?.settings.palette, "salvia");
  assert.equal(blank?.settings.weekStart, "monday");
  assert.equal(blank?.settings.nightHour, 19);
});

test("night follows the local hour", () => {
  assert.equal(isNight(new Date(2026, 8, 23, 6, 59)), true);
  assert.equal(isNight(new Date(2026, 8, 23, 7, 0)), false);
  assert.equal(isNight(new Date(2026, 8, 23, 18, 59)), false);
  assert.equal(isNight(new Date(2026, 8, 23, 19, 0)), true);
  assert.equal(isNight(new Date(2026, 8, 23, 0, 0)), true);
  assert.equal(isNight(new Date(2026, 8, 23, 20, 0), 21), false);
  assert.equal(isNight(new Date(2026, 8, 23, 21, 0), 21), true);
  assert.equal(isNight(new Date(2026, 8, 23, 8, 59), 21), true);
  assert.equal(isNight(new Date(2026, 8, 23, 9, 0), 21), false);
});

test("clock in once and clock out", () => {
  const start = new Date(2026, 8, 21, 9, 0, 0, 0).getTime();
  const started = clockIn([], start);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.entries.length, 1);
  assert.equal(clockIn(started.entries, start + 1000).ok, false);
  const ended = clockOut(started.entries, start + 90 * 60 * 1000);
  assert.equal(ended[0].clockOut, start + 90 * 60 * 1000);
  assert.equal(durationMs(ended[0], start + 999999), 90 * 60 * 1000);
});

test("week starts on Monday and month starts on the first", () => {
  const week = rangeBounds("week", monday);
  assert.equal(new Date(week.start!).getDay(), 1);
  assert.equal(new Date(week.start!).getDate(), 21);
  const month = rangeBounds("month", monday);
  assert.equal(new Date(month.start!).getDate(), 1);
  const sunday = rangeBounds("week", new Date(2026, 8, 23, 12), "sunday");
  assert.equal(new Date(sunday.start!).getDay(), 0);
  assert.equal(new Date(sunday.start!).getDate(), 20);
});

test("range filter keeps spans that overlap the period", () => {
  const today = new Date(2026, 8, 21, 9, 30).getTime();
  const yesterdayClosed = new Date(2026, 8, 20, 18, 0).getTime();
  const overnight = {
    id: "night",
    clockIn: combineLocal("2026-09-20", "22:00"),
    clockOut: combineLocal("2026-09-21", "02:00"),
    comment: "guardia",
    origin: "manual" as const,
  };
  const stillOpen = entry({ id: "open", clockIn: combineLocal("2026-09-20", "23:00") });
  const entries = [
    entry({ id: "a", clockIn: today, comment: "hoy" }),
    entry({ id: "b", clockIn: yesterdayClosed, clockOut: yesterdayClosed + 30 * 60 * 1000, comment: "ayer" }),
    overnight,
    stillOpen,
  ];
  const filtered = entriesInRange(entries, "today", monday);
  assert.deepEqual(
    filtered.map((item) => item.id).sort(),
    ["a", "night", "open"],
  );
});

test("csv escapes comments and adds origin plus a total row", () => {
  const start = new Date(2026, 8, 21, 9, 0).getTime();
  const end = start + 150 * 60 * 1000;
  const csv = toCsv([entry({ id: "a", clockIn: start, clockOut: end, comment: 'dijo "hola"; y siguió', origin: "manual" })], end);
  assert.match(csv, /^\uFEFFDate;Job;Client;In;Out;Duration;Hours;Currency;Rate;Amount;Billable;Comment;Status;Origin/);
  assert.match(csv, /"dijo ""hola""; y siguió"/);
  assert.match(csv, /02:30;2.50/);
  assert.match(csv, /manual/);
  assert.match(csv, /Total;;;;;02:30;2.50/);
  assert.equal(totalMs([entry({ id: "a", clockIn: start, clockOut: end })], end), 150 * 60 * 1000);
});

test("reported minutes follow the clocks, not the leftover seconds", () => {
  const start = new Date(2026, 8, 21, 21, 30, 50).getTime();
  const end = new Date(2026, 8, 21, 21, 31, 10).getTime();
  const item = entry({ id: "a", clockIn: start, clockOut: end, comment: "cruce" });
  assert.ok(durationMs(item, end) < 60_000);
  assert.equal(trackedMs(item, end), 60_000);
  assert.match(toCsv([item], end), /00:01;0.02/);
});

test("backup merge replaces the same id and keeps the rest", () => {
  const current = [entry({ id: "a", clockIn: 2, comment: "viejo" }), entry({ id: "b", clockIn: 1, comment: "se queda" })];
  const incoming = parseBackup(JSON.stringify({ version: 1, entries: [entry({ id: "a", clockIn: 3, comment: "nuevo" })] }));
  const merged = mergeEntries(current, incoming.entries);
  assert.deepEqual(
    merged.map((item) => item.comment),
    ["nuevo", "se queda"],
  );
  assert.throws(() => parseBackup("{"), /Horas backup/);
});

test("manual entry is closed, tagged, and rejects overlap or a zero minute span", () => {
  const morning = addManual([], {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "13:00"),
    comment: "Taller",
  });
  assert.equal(morning.ok, true);
  if (!morning.ok) return;
  assert.equal(morning.entries[0].origin, "manual");
  assert.equal(morning.entries[0].comment, "Taller");

  const overlap = addManual(morning.entries, {
    clockIn: combineLocal("2026-09-21", "12:00"),
    clockOut: combineLocal("2026-09-21", "14:00"),
    comment: "cruce",
  });
  assert.equal(overlap.ok, false);

  const tooShort = addManual([], {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "09:00"),
    comment: "nada",
  });
  assert.equal(tooShort.ok, false);

  const afternoon = addManual(morning.entries, {
    clockIn: combineLocal("2026-09-21", "14:00"),
    clockOut: combineLocal("2026-09-21", "18:00"),
    comment: "Informes",
  });
  assert.equal(afternoon.ok, true);
  if (!afternoon.ok) return;
  assert.equal(afternoon.entries.length, 2);
  assert.equal(totalMs(afternoon.entries, combineLocal("2026-09-21", "18:00")), 8 * 60 * 60 * 1000);

  const night = addManual([], {
    clockIn: combineLocal("2026-09-21", "22:00"),
    clockOut: combineLocal("2026-09-22", "02:00"),
    comment: "Guardia",
  });
  assert.equal(night.ok, true);
  if (!night.ok) return;
  assert.equal(trackedMs(night.entries[0], night.entries[0].clockOut ?? 0), 4 * 60 * 60 * 1000);
  assert.match(toCsv(night.entries, night.entries[0].clockOut ?? 0), /02:00 \+1/);
});

test("overnight clock-out is labeled with the extra day", () => {
  assert.equal(formatOutLabel(combineLocal("2026-09-21", "09:00"), combineLocal("2026-09-21", "18:00")), "18:00");
  assert.equal(formatOutLabel(combineLocal("2026-09-21", "22:00"), combineLocal("2026-09-22", "02:00")), "02:00 +1");
  assert.equal(formatOutLabel(combineLocal("2026-09-21", "09:00"), null), "now");
});

test("placement blocks a second open interval and detects overlap", () => {
  const open = entry({ id: "open", clockIn: combineLocal("2026-09-21", "09:00") });
  const closed = entry({
    id: "closed",
    clockIn: combineLocal("2026-09-21", "14:00"),
    clockOut: combineLocal("2026-09-21", "16:00"),
  });
  assert.ok(intervalsOverlap(open, { id: "x", clockIn: combineLocal("2026-09-21", "10:00"), clockOut: combineLocal("2026-09-21", "11:00") }, combineLocal("2026-09-21", "12:00")));
  assert.equal(
    placementError([open], { clockIn: combineLocal("2026-09-21", "15:00"), clockOut: null }),
    "A timer is already running. Stop it before leaving this one open.",
  );
  assert.match(
    placementError([closed], {
      clockIn: combineLocal("2026-09-21", "15:00"),
      clockOut: combineLocal("2026-09-21", "17:00"),
    }) ?? "",
    /Overlaps/,
  );
});

test("hours of different jobs stay apart and may overlap", () => {
  const morning = addManual([], {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "13:00"),
    comment: "Bar",
    jobId: "bar",
  });
  assert.equal(morning.ok, true);
  if (!morning.ok) return;
  const clinic = addManual(morning.entries, {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "13:00"),
    comment: "Clínica",
    jobId: "clinic",
  });
  assert.equal(clinic.ok, true);
  if (!clinic.ok) return;
  assert.equal(entriesForJob(clinic.entries, "bar").length, 1);
  assert.equal(entriesForJob(clinic.entries, "clinic").length, 1);
  const clash = addManual(clinic.entries, {
    clockIn: combineLocal("2026-09-21", "12:00"),
    clockOut: combineLocal("2026-09-21", "14:00"),
    comment: "cruce",
    jobId: "bar",
  });
  assert.equal(clash.ok, false);
  const started = clockIn(clinic.entries, combineLocal("2026-09-21", "18:00"), "bar");
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(clockIn(started.entries, combineLocal("2026-09-21", "18:01"), "clinic").ok, false);
  const csv = toCsv(entriesForJob(clinic.entries, "clinic"), combineLocal("2026-09-21", "13:00"), [
    { id: "clinic", name: "Clínica" },
  ]);
  assert.match(csv, /Clínica/);
});

test("old hours become the first job and jobs can be renamed or removed", () => {
  const migrated = normalizeStore([entry({ id: "a", clockIn: 1, clockOut: 2, comment: "viejo" })]);
  assert.ok(migrated);
  assert.equal(migrated.jobs.length, 1);
  assert.equal(migrated.jobs[0].name, "Job 1");
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.clients, []);
  assert.equal(migrated.entries[0].jobId, migrated.jobs[0].id);
  const added = addJob(migrated, "  Bar  ");
  assert.ok(!("ok" in added));
  assert.equal(added.jobs.length, 2);
  assert.equal(added.activeJobId, added.jobs[1].id);
  assert.equal(added.jobs[1].name, "Bar");
  const renamed = renameJob(added, added.jobs[1].id, "El bar");
  assert.ok(!("ok" in renamed));
  assert.equal(renamed.jobs[1].name, "El bar");
  const withHours = {
    ...renamed,
    entries: [
      entry({ id: "keep", clockIn: 1, clockOut: 2, jobId: renamed.jobs[0].id }),
      entry({ id: "gone", clockIn: 3, clockOut: 4, jobId: renamed.jobs[1].id }),
    ],
  };
  const removed = deleteJob(withHours, renamed.jobs[1].id);
  assert.ok(!("ok" in removed));
  assert.equal(removed.jobs.length, 1);
  assert.deepEqual(
    removed.entries.map((item) => item.id),
    ["keep"],
  );
  const last = deleteJob(migrated, migrated.jobs[0].id);
  assert.equal("ok" in last, true);
  assert.equal(jobSlug("El Bar"), "el-bar");
  assert.equal(jobSlug("Clínica 2"), "clinica-2");
  const parsed = parseBackup(toBackup(renamed));
  assert.equal(parsed.jobs[1].name, "El bar");
  const incoming = normalizeStore({
    version: 2,
    jobs: [{ id: "taller", name: "Taller" }],
    activeJobId: "taller",
    entries: [entry({ id: "t1", clockIn: 9, clockOut: 10, jobId: "taller" })],
  });
  assert.ok(incoming);
  const merged = mergeStores(renamed, incoming);
  assert.equal(merged.jobs.length, 3);
  assert.equal(merged.entries.some((item) => item.jobId === "taller"), true);
  assert.ok(removed.deletedIds.includes(renamed.jobs[1].id));
  assert.ok(removed.deletedIds.includes("gone"));
});

test("vault codes normalize and a blank copy does not steal hours", () => {
  const raw = "A1B2-C3D4-E5F6-7890-ABCD";
  assert.equal(normalizeVaultId(raw), "a1b2c3d4e5f67890abcd");
  assert.equal(formatVaultId("a1b2c3d4e5f67890abcd"), "a1b2-c3d4-e5f6-7890-abcd");
  assert.equal(normalizeVaultId("corto"), null);
  const hours = stampStore({
    version: 2,
    jobs: [{ id: "bar", name: "Bar" }],
    activeJobId: "bar",
    entries: [entry({ id: "e1", clockIn: 1, clockOut: 2, jobId: "bar" })],
    vaultId: "a1b2c3d4e5f67890abcd",
    savedAt: 50,
    deletedIds: [],
  });
  const blank = emptyStore();
  const merged = durableMerge(blank, hours);
  assert.equal(merged.vaultId, "a1b2c3d4e5f67890abcd");
  assert.equal(merged.entries[0].id, "e1");
  const stampedEmpty = stampStore(ensureVault(emptyStore()), 999);
  const recovered = durableMerge(stampedEmpty, hours);
  assert.equal(recovered.entries[0].id, "e1");
  assert.equal(recovered.jobs.length, 1);
  assert.equal(recovered.jobs[0].id, "bar");
  assert.equal(recovered.activeJobId, "bar");
  const generated = ensureVault(emptyStore());
  assert.equal(generated.vaultId.length, 20);
});

test("deletes stay deleted unless a newer copy brings the hours back", () => {
  const base: Store = {
    version: 2,
    jobs: [
      { id: "bar", name: "Bar" },
      { id: "clinic", name: "Clínica" },
    ],
    activeJobId: "bar",
    entries: [
      entry({ id: "keep", clockIn: 1, clockOut: 2, jobId: "bar" }),
      entry({ id: "gone", clockIn: 3, clockOut: 4, jobId: "bar" }),
    ],
    vaultId: "a1b2c3d4e5f67890abcd",
    savedAt: 10,
    deletedIds: [],
  };
  const deleted = stampStore(removeEntry(base, "gone"), 20);
  assert.equal(deleted.entries.some((item) => item.id === "gone"), false);
  assert.ok(deleted.deletedIds.includes("gone"));
  const stale = { ...base, savedAt: 5 };
  const synced = durableMerge(stale, deleted);
  assert.equal(synced.entries.some((item) => item.id === "gone"), false);
  const undone = stampStore({ ...base, deletedIds: [] }, 30);
  const restored = durableMerge(deleted, undone);
  assert.equal(restored.entries.some((item) => item.id === "gone"), true);
  assert.equal(restored.deletedIds.includes("gone"), false);
});

test("a break pauses the clock and stays out of the billed minutes", () => {
  const start = combineLocal("2026-09-21", "09:00");
  const started = clockIn([], start, "studio");
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const paused = startBreak(started.entries, start + 60 * 60 * 1000);
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(onBreak(paused.entries[0]), true);
  assert.equal(trackedMs(paused.entries[0], start + 90 * 60 * 1000), 60 * 60 * 1000);
  assert.equal(durationMs(paused.entries[0], start + 90 * 60 * 1000), 60 * 60 * 1000);
  const resumed = resumeBreak(paused.entries, start + 90 * 60 * 1000);
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(onBreak(resumed.entries[0]), false);
  const ended = clockOut(resumed.entries, start + 3 * 60 * 60 * 1000);
  assert.equal(trackedMs(ended[0]), 150 * 60 * 1000);
  assert.equal(breakMs(ended[0]), 30 * 60 * 1000);
  const stoppedMidBreak = clockOut(paused.entries, start + 105 * 60 * 1000);
  assert.equal(onBreak(stoppedMidBreak[0]), false);
  assert.equal(trackedMs(stoppedMidBreak[0]), 60 * 60 * 1000);
});
