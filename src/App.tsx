import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { amountForEntry, formatMoney } from "./billing.ts";
import {
  addJob,
  addManual,
  breakMs,
  clockIn,
  clockOut,
  combineLocal,
  deleteJob,
  durationMs,
  durableMerge,
  emptyStore,
  entriesForJob,
  entriesInRange,
  formatClock,
  formatDayLabel,
  formatDuration,
  formatOutLabel,
  formatRunning,
  groupByDay,
  isBillable,
  jobIdOf,
  jobNameOf,
  jobSlug,
  loadStore,
  mergeStores,
  nextJobName,
  onBreak,
  openEntry,
  originOf,
  parseBackup,
  removeEntry,
  renameJob,
  resumeBreak,
  setActiveJob,
  setJobBilling,
  stampStore,
  startBreak,
  toBackup,
  toCsv,
  toDateValue,
  toTimeValue,
  totalMs,
  trackedMs,
  updateEntry,
  type Entry,
  type PlaceResult,
  type RangeKey,
  type Store,
} from "./model.ts";
import { ClientsPanel, InvoicesPanel } from "./panels.tsx";
import { hydrateStore, persistLocal } from "./persist.ts";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "all", label: "All" },
];

const VIEWS = [
  { key: "time", label: "Time" },
  { key: "clients", label: "Clients" },
  { key: "invoices", label: "Invoices" },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function TimeInput({
  name,
  value,
  onChange,
  required,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [hour = "", minute = ""] = value.split(":");
  return (
    <div className="hm">
      <input type="hidden" name={name} value={value} />
      <select
        name={`${name}-hour`}
        aria-label="Hour"
        value={hour}
        required={required}
        onChange={(event) => {
          const nextHour = event.target.value;
          if (nextHour === "") onChange("");
          else onChange(`${nextHour}:${minute || "00"}`);
        }}
      >
        {required ? null : <option value="">--</option>}
        {HOURS.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <span aria-hidden="true">:</span>
      <select
        name={`${name}-minute`}
        aria-label="Minute"
        value={minute}
        required={required}
        onChange={(event) => {
          const nextMinute = event.target.value;
          if (nextMinute === "") onChange("");
          else onChange(`${hour || "00"}:${nextMinute}`);
        }}
      >
        {required ? null : <option value="">--</option>}
        {MINUTES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </div>
  );
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type Notice = { text: string; kind: "ok" | "error" };

export function App() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<RangeKey>("week");
  const [view, setView] = useState<ViewKey>("time");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undo, setUndo] = useState<Store | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingJob, setAddingJob] = useState(false);
  const [jobName, setJobName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirmingJob, setConfirmingJob] = useState(false);
  const [rateDraft, setRateDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const jobField = useRef<HTMLInputElement>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const job = store.jobs.find((item) => item.id === store.activeJobId) ?? store.jobs[0] ?? emptyStore().jobs[0];
  const entries = store.entries;
  const jobEntries = entriesForJob(entries, job.id);
  const active = openEntry(jobEntries);
  const openOther = entries.find((item) => item.clockOut === null && jobIdOf(item, job.id) !== job.id);
  const client = store.clients.find((item) => item.id === job.clientId);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!(meta instanceof HTMLMetaElement)) return;
    meta.content = active && onBreak(active) ? "#5f6c67" : active ? "#25408f" : "#3e4a46";
  }, [active]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice(null);
      setUndo(null);
    }, undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice, undo]);

  useEffect(() => {
    if (addingJob || renaming) jobField.current?.focus();
  }, [addingJob, renaming]);

  useEffect(() => {
    setRateDraft(job.hourlyRate === undefined ? "" : String(job.hourlyRate));
  }, [job.id, job.hourlyRate]);

  useEffect(() => {
    let cancelled = false;
    void hydrateStore(storeRef.current)
      .then(({ store: next }) => {
        if (cancelled) return;
        const merged = durableMerge(storeRef.current, next);
        persistLocal(merged);
        storeRef.current = merged;
        setStore(merged);
      })
      .catch(() => undefined);
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      const current = storeRef.current;
      void hydrateStore(current)
        .then(({ store: next }) => {
          const merged = durableMerge(storeRef.current, next);
          persistLocal(merged);
          storeRef.current = merged;
          setStore(merged);
        })
        .catch(() => undefined);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  function remember(next: Store) {
    const stamped = stampStore(next);
    persistLocal(stamped);
    storeRef.current = stamped;
    setStore(stamped);
    return stamped;
  }

  function commit(next: Store, message: string | undefined, previous?: Store) {
    remember(next);
    setUndo(previous ?? null);
    setNotice(message ? { text: message, kind: "ok" } : null);
  }

  function apply(result: PlaceResult, message?: string): boolean {
    if (!result.ok) {
      setUndo(null);
      setNotice({ text: result.error, kind: "error" });
      return false;
    }
    remember({ ...store, entries: result.entries });
    setUndo(null);
    if (message !== undefined) setNotice({ text: message, kind: "ok" });
    return true;
  }

  function applyJob(result: Store | { ok: false; error: string }, message?: string, previous?: Store): boolean {
    if ("ok" in result) {
      setUndo(null);
      setNotice({ text: result.error, kind: "error" });
      return false;
    }
    commit(result, message, previous);
    return true;
  }

  const visible = useMemo(() => entriesInRange(jobEntries, range, new Date(now)), [jobEntries, range, now]);
  const days = useMemo(() => groupByDay(visible, new Date(now)), [visible, now]);
  const todayTotal = totalMs(entriesInRange(jobEntries, "today", new Date(now)), now);
  const weekTotal = totalMs(entriesInRange(jobEntries, "week", new Date(now)), now);
  const monthTotal = totalMs(entriesInRange(jobEntries, "month", new Date(now)), now);
  const rangeMoney = visible.reduce((sum, entry) => sum + amountForEntry(store, entry, now), 0);
  const todayLong = new Date(now).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const todayShort = new Date(now).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  function exportCsv() {
    download(
      `horas-${jobSlug(job.name)}-${range}-${stamp()}.csv`,
      toCsv(visible, now, store),
      "text/csv;charset=utf-8",
    );
    setUndo(null);
    setNotice({
      text: `CSV for ${job.name}: ${visible.length} ${visible.length === 1 ? "entry" : "entries"}.`,
      kind: "ok",
    });
  }

  function exportBackup() {
    download(`horas-backup-${stamp()}.json`, toBackup(store), "application/json");
    setUndo(null);
    setNotice({ text: "Backup downloaded.", kind: "ok" });
  }

  async function importBackup(file: File) {
    try {
      const incoming = parseBackup(await file.text());
      commit(mergeStores(store, incoming), `Imported ${incoming.entries.length} entries.`);
    } catch {
      setUndo(null);
      setNotice({ text: "That file is not a Horas backup.", kind: "error" });
    }
  }

  function saveRate() {
    const trimmed = rateDraft.trim();
    if (trimmed === "") {
      if (job.hourlyRate !== undefined) applyJob(setJobBilling(store, job.id, { hourlyRate: null }));
      return;
    }
    const rate = Number(trimmed);
    if (!Number.isFinite(rate) || rate < 0) {
      setUndo(null);
      setNotice({ text: "Enter a rate of zero or more.", kind: "error" });
      return;
    }
    if (job.hourlyRate !== rate) applyJob(setJobBilling(store, job.id, { hourlyRate: rate }));
  }

  function onRangeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = RANGES.findIndex((item) => item.key === range);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      setRange(RANGES[(index + 1) % RANGES.length].key);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      setRange(RANGES[(index + RANGES.length - 1) % RANGES.length].key);
    }
  }

  function onJobKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    const index = store.jobs.findIndex((item) => item.id === job.id);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      applyJob(setActiveJob(store, store.jobs[(index + 1) % store.jobs.length].id));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      applyJob(setActiveJob(store, store.jobs[(index + store.jobs.length - 1) % store.jobs.length].id));
    }
  }

  function saveNewJob() {
    if (applyJob(addJob(store, jobName || nextJobName(store.jobs)), "Job added.")) {
      setAddingJob(false);
      setJobName("");
      setRenaming(false);
      setConfirmingJob(false);
    }
  }

  function saveRename() {
    if (applyJob(renameJob(store, job.id, jobName))) {
      setRenaming(false);
      setJobName("");
    }
  }

  return (
    <div
      className={["hz", view === "time" ? "time" : "", active ? "live" : "", adding ? "adding" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="card">
        <header className="mast">
          <h1>Horas</h1>
          <div className="mast-side">
            <p>
              <span className="date-long">{todayLong}</span>
              <span className="date-short">{todayShort}</span>
            </p>
          </div>
        </header>

        <div className="views" role="tablist" aria-label="Desk">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={view === item.key}
              className={view === item.key ? "job on" : "job"}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {view === "clients" ? (
          <ClientsPanel
            store={store}
            onChange={applyJob}
            onError={(text) => {
              setUndo(null);
              setNotice({ text, kind: "error" });
            }}
          />
        ) : null}

        {view === "invoices" ? (
          <InvoicesPanel
            store={store}
            onChange={applyJob}
            onError={(text) => {
              setUndo(null);
              setNotice({ text, kind: "error" });
            }}
          />
        ) : null}

        {view === "time" ? (
          <div className="time-sheet">
            <div className="jobs" role="tablist" aria-label="Jobs" onKeyDown={onJobKey}>
              {store.jobs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={item.id === job.id}
                  tabIndex={item.id === job.id ? 0 : -1}
                  className={item.id === job.id ? "job on" : "job"}
                  onClick={() => {
                    setAdding(false);
                    setAddingJob(false);
                    setRenaming(false);
                    setConfirmingJob(false);
                    applyJob(setActiveJob(store, item.id));
                  }}
                >
                  {item.name}
                </button>
              ))}
              {addingJob ? (
                <form
                  className="job-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveNewJob();
                  }}
                >
                  <label className="sr" htmlFor="job-name">
                    Job name
                  </label>
                  <input
                    ref={jobField}
                    id="job-name"
                    name="job-name"
                    value={jobName}
                    placeholder={nextJobName(store.jobs)}
                    maxLength={40}
                    onChange={(event) => setJobName(event.target.value)}
                  />
                  <button className="btn slim" type="submit">
                    Save
                  </button>
                  <button
                    className="btn quiet slim"
                    type="button"
                    onClick={() => {
                      setAddingJob(false);
                      setJobName("");
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  className="text"
                  type="button"
                  onClick={() => {
                    setAddingJob(true);
                    setRenaming(false);
                    setConfirmingJob(false);
                    setJobName("");
                  }}
                >
                  Add job
                </button>
              )}
            </div>

            <div className="job-tools">
              {renaming ? (
                <form
                  className="job-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveRename();
                  }}
                >
                  <label className="sr" htmlFor="job-rename">
                    New name
                  </label>
                  <input
                    ref={jobField}
                    id="job-rename"
                    name="job-rename"
                    value={jobName}
                    maxLength={40}
                    onChange={(event) => setJobName(event.target.value)}
                  />
                  <button className="btn slim" type="submit">
                    Save
                  </button>
                  <button
                    className="btn quiet slim"
                    type="button"
                    onClick={() => {
                      setRenaming(false);
                      setJobName("");
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  className="text"
                  type="button"
                  onClick={() => {
                    setRenaming(true);
                    setAddingJob(false);
                    setConfirmingJob(false);
                    setJobName(job.name);
                  }}
                >
                  Rename
                </button>
              )}
              {store.jobs.length > 1 ? (
                confirmingJob ? (
                  <>
                    <span className="ask">Delete {job.name} and its hours?</span>
                    <button
                      className="text danger"
                      type="button"
                      onClick={() => {
                        setConfirmingJob(false);
                        applyJob(deleteJob(store, job.id), "Job deleted.", store);
                      }}
                    >
                      Yes, delete
                    </button>
                    <button className="text" type="button" onClick={() => setConfirmingJob(false)}>
                      No
                    </button>
                  </>
                ) : (
                  <button
                    className="text danger"
                    type="button"
                    onClick={() => {
                      setConfirmingJob(true);
                      setRenaming(false);
                      setAddingJob(false);
                    }}
                  >
                    Delete job
                  </button>
                )
              ) : null}
            </div>

            <div className="bill-row">
              <label>
                Client
                <select
                  name="job-client"
                  value={job.clientId ?? ""}
                  onChange={(event) => applyJob(setJobBilling(store, job.id, { clientId: event.target.value || null }))}
                >
                  <option value="">No client</option>
                  {store.clients.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Rate
                <input
                  name="job-rate"
                  inputMode="decimal"
                  value={rateDraft}
                  placeholder={client ? String(client.hourlyRate) : "0"}
                  onChange={(event) => setRateDraft(event.target.value)}
                  onBlur={saveRate}
                />
              </label>
            </div>

            <section className="punch" aria-label={`Timer for ${job.name}`}>
              {active ? (
                <>
                  <p className={onBreak(active) ? "stamp paused" : "stamp"} aria-live="polite">
                    {formatRunning(durationMs(active, now))}
                  </p>
                  <p className="status">
                    {onBreak(active)
                      ? `On break on ${job.name}.`
                      : `Running on ${job.name} since ${formatClock(active.clockIn)}`}
                  </p>
                  <label htmlFor="active-comment">What you did</label>
                  <textarea
                    id="active-comment"
                    value={active.comment}
                    placeholder="What this block was for."
                    onChange={(event) => apply(updateEntry(entries, active.id, { comment: event.target.value }))}
                  />
                  <div className="punch-dock">
                    <div className="punch-dock-bar">
                      <div className="punch-actions">
                        {onBreak(active) ? (
                          <button className="btn start" type="button" onClick={() => apply(resumeBreak(entries, Date.now(), job.id))}>
                            Resume
                          </button>
                        ) : (
                          <button className="btn ghost" type="button" onClick={() => apply(startBreak(entries, Date.now(), job.id))}>
                            Break
                          </button>
                        )}
                        <button
                          className="btn stop"
                          type="button"
                          onClick={() => commit({ ...store, entries: clockOut(entries, Date.now(), job.id) }, "Clock stopped.")}
                        >
                          Stop
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="stamp">{formatClock(now)}</p>
                  <p className="status">
                    {openOther
                      ? onBreak(openOther)
                        ? `Off ${job.name}. ${jobNameOf(store.jobs, openOther.jobId) || "Another job"} is on break.`
                        : `Off ${job.name}. A timer is open on ${jobNameOf(store.jobs, openOther.jobId) || "another job"}.`
                      : `Off ${job.name}. Start when you begin, or add a block you forgot.`}
                  </p>
                  {openOther ? (
                    <button
                      className="btn quiet"
                      type="button"
                      onClick={() => applyJob(setActiveJob(store, jobIdOf(openOther, job.id)))}
                    >
                      Go to {jobNameOf(store.jobs, openOther.jobId) || "that job"}
                    </button>
                  ) : null}
                  <div className="punch-dock">
                    <div className="punch-dock-bar">
                      <button
                        className="btn start"
                        type="button"
                        onClick={() => apply(clockIn(entries, Date.now(), job.id), "Clock started.")}
                      >
                        Start
                      </button>
                    </div>
                  </div>
                </>
              )}

              {adding ? (
                <ManualForm
                  now={now}
                  onCancel={() => {
                    setAdding(false);
                  }}
                  onSave={(draft) => {
                    if (apply(addManual(entries, { ...draft, jobId: job.id }), "Hours added.")) setAdding(false);
                  }}
                />
              ) : (
                <button className="btn quiet" type="button" onClick={() => setAdding(true)}>
                  Add hours
                </button>
              )}

              {notice && view === "time" ? (
                <p className={notice.kind === "error" ? "note error" : "note"} role="status">
                  <span>{notice.text}</span>
                  {undo ? (
                    <button
                      className="text"
                      type="button"
                      onClick={() => {
                        commit(undo, "Entry restored.");
                      }}
                    >
                      Undo
                    </button>
                  ) : null}
                </p>
              ) : null}
            </section>

            <dl className="sums" aria-label={`Totals for ${job.name}`}>
              <div>
                <dt>Today</dt>
                <dd>{formatDuration(todayTotal)}</dd>
              </div>
              <div>
                <dt>Week</dt>
                <dd>{formatDuration(weekTotal)}</dd>
              </div>
              <div>
                <dt>Month</dt>
                <dd>{formatDuration(monthTotal)}</dd>
              </div>
            </dl>

            <section className="ledger">
              <header className="ledger-bar">
                <div className="ranges" role="tablist" aria-label="Period" onKeyDown={onRangeKey}>
                  {RANGES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="tab"
                      aria-selected={range === item.key}
                      tabIndex={range === item.key ? 0 : -1}
                      className={range === item.key ? "range on" : "range"}
                      onClick={() => setRange(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="ledger-meta">
                  <p>
                    {formatDuration(totalMs(visible, now))} on {job.name}
                    {rangeMoney > 0 ? ` · ${formatMoney(rangeMoney, store.settings.currency)}` : ""}
                  </p>
                  <button className="btn quiet slim" type="button" onClick={exportCsv}>
                    Export CSV
                  </button>
                </div>
              </header>

              {days.length === 0 ? (
                <p className="empty">Nothing in this period for {job.name}.</p>
              ) : (
                days.map((day) => (
                  <article key={day.key} className="day">
                    <header>
                      <h2>{day.label}</h2>
                      <span>{formatDuration(day.totalMs)}</span>
                    </header>
                    <ul>
                      {day.entries.map((item) => (
                        <EntryRow
                          key={item.id}
                          entry={item}
                          now={now}
                          money={amountForEntry(store, item, now)}
                          currency={store.settings.currency}
                          onChange={(patch) => {
                            const times = patch.clockIn !== undefined || patch.clockOut !== undefined;
                            return apply(updateEntry(entries, item.id, patch), times ? "Entry updated." : undefined);
                          }}
                          onDelete={() => commit(removeEntry(store, item.id), "Entry deleted.", store)}
                        />
                      ))}
                    </ul>
                  </article>
                ))
              )}

              <footer className="foot">
                <div className="foot-actions">
                  <button className="text" type="button" onClick={exportBackup}>
                    Download backup
                  </button>
                  <button className="text" type="button" onClick={() => fileRef.current?.click()}>
                    Restore backup
                  </button>
                  <input
                    ref={fileRef}
                    className="file"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void importBackup(file);
                    }}
                  />
                </div>
              </footer>
            </section>
          </div>
        ) : null}

        {notice && view !== "time" ? (
          <p className={notice.kind === "error" ? "note error" : "note"} role="status">
            <span>{notice.text}</span>
            {undo ? (
              <button className="text" type="button" onClick={() => commit(undo, "Restored.")}>
                Undo
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ManualForm({
  now,
  onCancel,
  onSave,
}: {
  now: number;
  onCancel: () => void;
  onSave: (draft: { clockIn: number; clockOut: number; comment: string; billable: boolean }) => void;
}) {
  const [date, setDate] = useState(() => toDateValue(now));
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [comment, setComment] = useState("");
  const [billable, setBillable] = useState(true);
  const first = useRef<HTMLInputElement>(null);
  const clockInAt = combineLocal(date, start);
  let clockOutAt = combineLocal(date, end);
  const overnight = !Number.isNaN(clockInAt) && !Number.isNaN(clockOutAt) && clockOutAt < clockInAt;
  if (overnight) clockOutAt += 86_400_000;
  const preview =
    Number.isNaN(clockInAt) || Number.isNaN(clockOutAt)
      ? null
      : `${formatDuration(trackedMs({ clockIn: clockInAt, clockOut: clockOutAt }))}${overnight ? " · past midnight" : ""}`;

  useEffect(() => {
    first.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <form
      className="manual"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ clockIn: clockInAt, clockOut: clockOutAt, comment, billable });
      }}
    >
      <p>Add a closed block</p>
      <label>
        Date
        <input ref={first} name="date" type="date" value={date} lang="en" onChange={(event) => setDate(event.target.value)} required />
      </label>
      <div className="pair">
        <label>
          In
          <TimeInput name="start" value={start} onChange={setStart} required />
        </label>
        <label>
          Out
          <TimeInput name="end" value={end} onChange={setEnd} required />
        </label>
      </div>
      <label>
        Comment
        <textarea name="comment" value={comment} placeholder="What you did" onChange={(event) => setComment(event.target.value)} />
      </label>
      <label className="checks">
        <input type="checkbox" name="billable" checked={billable} onChange={(event) => setBillable(event.target.checked)} />
        Billable
      </label>
      <p className="preview">{preview ?? "Enter a start and an end."}</p>
      <div className="manual-actions">
        <button className="btn start slim" type="submit">
          Save hours
        </button>
        <button className="btn quiet slim" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EntryRow({
  entry,
  now,
  money,
  currency,
  onChange,
  onDelete,
}: {
  entry: Entry;
  now: number;
  money: number;
  currency: string;
  onChange: (patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment" | "billable">>) => boolean;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [date, setDate] = useState(() => toDateValue(entry.clockIn));
  const [start, setStart] = useState(() => toTimeValue(entry.clockIn));
  const [end, setEnd] = useState(() => (entry.clockOut === null ? "" : toTimeValue(entry.clockOut)));

  useEffect(() => {
    if (!editing) return;
    setDate(toDateValue(entry.clockIn));
    setStart(toTimeValue(entry.clockIn));
    setEnd(entry.clockOut === null ? "" : toTimeValue(entry.clockOut));
  }, [editing, entry.clockIn, entry.clockOut]);

  function saveTimes() {
    const nextIn = combineLocal(date, start);
    let nextOut: number | null = end === "" ? null : combineLocal(date, end);
    if (nextOut !== null && !Number.isNaN(nextIn) && !Number.isNaN(nextOut) && nextOut < nextIn) {
      nextOut += 86_400_000;
    }
    if (onChange({ clockIn: nextIn, clockOut: nextOut })) {
      setEditing(false);
    }
  }

  const tracked = trackedMs(entry, now);
  const durationLabel =
    entry.clockOut === null
      ? formatRunning(durationMs(entry, now))
      : tracked === 0 && durationMs(entry, now) > 0
        ? "< 1 min"
        : formatDuration(tracked);

  return (
    <li className={entry.clockOut === null ? "row open" : "row"}>
      <p className="when">
        <time>{formatClock(entry.clockIn)}</time>
        <time>{formatOutLabel(entry.clockIn, entry.clockOut)}</time>
        <span className="dur">
          {durationLabel}
          {breakMs(entry, now) > 0 ? ` · break ${formatDuration(breakMs(entry, now))}` : ""}
        </span>
        {originOf(entry) === "manual" ? <span className="tag">added</span> : <span />}
      </p>
      <label className="sr" htmlFor={`comment-${entry.id}`}>
        Comment for {formatDayLabel(entry.clockIn)}
      </label>
      <textarea
        id={`comment-${entry.id}`}
        className="note-line"
        value={entry.comment}
        placeholder="No comment"
        rows={Math.min(3, Math.max(1, entry.comment.split("\n").length))}
        onChange={(event) => onChange({ comment: event.target.value })}
      />
      <div className="row-actions">
        <button className="text" type="button" onClick={() => onChange({ billable: !isBillable(entry) })}>
          {isBillable(entry) ? (money > 0 ? formatMoney(money, currency) : "Billable") : "Non-billable"}
        </button>
        <button
          className="text"
          type="button"
          onClick={() => {
            setConfirming(false);
            setEditing((open) => !open);
          }}
        >
          {editing ? "Close" : "Edit"}
        </button>
        {confirming ? (
          <>
            <span className="ask">Delete?</span>
            <button
              className="text danger"
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Yes, delete
            </button>
            <button className="text" type="button" onClick={() => setConfirming(false)}>
              No
            </button>
          </>
        ) : (
          <button
            className="text danger"
            type="button"
            onClick={() => {
              setEditing(false);
              setConfirming(true);
            }}
          >
            Delete
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="edit"
          onSubmit={(event) => {
            event.preventDefault();
            saveTimes();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        >
          <label>
            Date
            <input name="edit-date" type="date" lang="en" value={date} onChange={(event) => setDate(event.target.value)} required />
          </label>
          <label>
            In
            <TimeInput name="edit-start" value={start} onChange={setStart} required />
          </label>
          <label>
            Out
            <TimeInput name="edit-end" value={end} onChange={setEnd} />
          </label>
          <button className="btn slim" type="submit">
            Save
          </button>
        </form>
      ) : null}
    </li>
  );
}
