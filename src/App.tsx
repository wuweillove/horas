import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { amountForEntry, formatMoney, weekAcrossJobs } from "./billing.ts";
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
  normalizeVaultId,
  isNight,
  paletteTone,
  onBreak,
  openEntry,
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
  trackedMs,
  updateEntry,
  type Entry,
  type PlaceResult,
  type RangeKey,
  type Store,
} from "./model.ts";
import {
  clearGoogleAccount,
  deskFromGoogle,
  GOOGLE_CLIENT_ID,
  legacyKeyFromGoogle,
  loadDeskOwner,
  loadGis,
  loadGoogleAccount,
  saveDeskOwner,
  saveGoogleAccount,
  signOutGoogle,
  type GoogleAccount,
} from "./google.ts";
import { ClientsPanel, InvoicesPanel, SettingsPanel } from "./panels.tsx";
import { hydrateStore, persistLocal } from "./persist.ts";
import { clearDriveToken, readDriveRecord, requestDriveAccess } from "./drive.ts";
import { applyRemote, loadSyncKey, newSyncKey, pullDesk, queueSync, readSyncLink, rekeyDesk, sameContent, saveDesk, saveSyncKey } from "./sync.ts";
import { verifyGoogleCredential } from "./google.ts";

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
  { key: "settings", label: "Settings" },
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
type UndoSnap = { store: Store; label: string };

function GoogleSignIn({ onCredential }: { onCredential: (credential: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    const paint = () => {
      const parent = host.current;
      const gis = window.google?.accounts?.id;
      if (!parent || !gis || cancelled) return;
      parent.replaceChildren();
      const width = Math.max(200, Math.floor(parent.clientWidth || parent.parentElement?.clientWidth || 240));
      gis.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          if (response.credential) onCredentialRef.current(response.credential);
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      gis.renderButton(parent, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "rectangular",
        logo_alignment: "left",
        width,
      });
    };
    void loadGis().then(() => {
      if (!cancelled) paint();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="google-slot">
      <span className="btn slim google-face">Sign in</span>
      <div className="google-btn" ref={host} data-google-signin="" />
    </div>
  );
}

function stripSyncLink() {
  const url = new URL(window.location.href);
  const hadDesk = url.searchParams.has("desk") || url.searchParams.has("vault");
  const hadKey = new URLSearchParams(url.hash.replace(/^#/, "")).has("k");
  if (!hadDesk && !hadKey) return;
  url.searchParams.delete("desk");
  url.searchParams.delete("vault");
  url.hash = "";
  const next = `${url.pathname}${url.search}`;
  window.history.replaceState(null, "", next);
}


async function adoptDrive(input: {
  sub: string;
  email: string;
  interactive: boolean;
  local: Store;
  fallbackDesk: string;
  keepKey: string;
}): Promise<{ ok: true; store: Store; desk: string } | { ok: false }> {
  const allowed = await requestDriveAccess(input.interactive, input.email);
  if (!allowed) return { ok: false };
  const record = await readDriveRecord();
  if (record === "error") return { ok: false };
  if (record) {
    saveSyncKey(record.key);
    const result = await saveDesk(record.desk, record.key, { ...input.local, vaultId: record.desk });
    if (!result.ok) return { ok: false };
    return { ok: true, store: result.store, desk: record.desk };
  }
  const legacy = await legacyKeyFromGoogle(input.sub);
  const key = input.keepKey && input.keepKey !== legacy ? input.keepKey : newSyncKey();
  saveSyncKey(key);
  const result = await saveDesk(input.fallbackDesk, key, { ...input.local, vaultId: input.fallbackDesk });
  if (!result.ok) return { ok: false };
  return { ok: true, store: result.store, desk: input.fallbackDesk };
}

export function App() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<RangeKey>("week");
  const [view, setView] = useState<ViewKey>("time");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undo, setUndo] = useState<UndoSnap | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingJob, setAddingJob] = useState(false);
  const [jobName, setJobName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirmingJob, setConfirmingJob] = useState(false);
  const [rateDraft, setRateDraft] = useState("");
  const [account, setAccount] = useState<GoogleAccount | null>(() => loadGoogleAccount());
  const [driveOn, setDriveOn] = useState<"unknown" | "on" | "off">("unknown");
  const fileRef = useRef<HTMLInputElement>(null);
  const jobField = useRef<HTMLInputElement>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const accountRef = useRef(account);
  accountRef.current = account;
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

  const night = isNight(new Date(now), store.settings.nightHour);
  const palette = store.settings.palette;

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    if (night) document.documentElement.dataset.night = "1";
    else delete document.documentElement.dataset.night;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!(meta instanceof HTMLMetaElement)) return;
    const tone = paletteTone(palette, night);
    meta.content = active && onBreak(active) ? tone.paused : active ? tone.running : tone.wall;
  }, [active, night, palette]);

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

  useEffect(() => {
    let cancel = false;
    const saved = loadGoogleAccount();
    const linked = saved ? null : readSyncLink(window.location.href);
    if (saved) stripSyncLink();
    if (linked) saveSyncKey(linked.key);

    function accept(desk: string, key: string, local: Store, noticeText: string | null) {
      void saveDesk(desk, key, { ...local, vaultId: desk }).then((result) => {
        if (cancel) return;
        if (!result.ok) {
          if (noticeText) setNotice({ text: "Sync didn't open.", kind: "error" });
          return;
        }
        takeSynced(result.store);
        if (noticeText) setNotice({ text: noticeText, kind: "ok" });
      });
    }

    const tick = () => {
      const signedIn = loadGoogleAccount();
      const key = loadSyncKey();
      const desk = signedIn?.desk || storeRef.current.vaultId;
      if (!key || !normalizeVaultId(desk)) return;
      accept(desk, key, storeRef.current, null);
    };

    if (saved) {
      void (async () => {
        const keepKey = loadDeskOwner() === saved.sub ? loadSyncKey() : "";
        const opened = await adoptDrive({
          sub: saved.sub,
          email: saved.email,
          interactive: false,
          local: storeRef.current,
          fallbackDesk: saved.desk,
          keepKey,
        });
        if (cancel) return;
        if (opened.ok) {
          setDriveOn("on");
          if (opened.desk !== saved.desk) {
            const next = { ...saved, desk: opened.desk };
            saveGoogleAccount(next);
            setAccount(next);
          }
          takeSynced(opened.store);
          return;
        }
        setDriveOn("off");
        setNotice({ text: "Google Drive didn't open. Hours stay on this browser.", kind: "error" });
        const legacy = await legacyKeyFromGoogle(saved.sub);
        const stored = loadSyncKey();
        if (cancel) return;
        if (stored && stored !== legacy) {
          accept(saved.desk, stored, storeRef.current, null);
          return;
        }
        const pulled = await pullDesk(saved.desk, legacy);
        if (cancel) return;
        if (!pulled.ok || !pulled.store) {
          if (stored) accept(saved.desk, stored, storeRef.current, null);
          else if (pulled.ok) {
            const key = newSyncKey();
            saveSyncKey(key);
            accept(saved.desk, key, storeRef.current, null);
          }
          return;
        }
        const key = newSyncKey();
        const result = await rekeyDesk(saved.desk, legacy, key, applyRemote(storeRef.current, pulled.store, saved.desk));
        if (cancel) return;
        if (!result.ok) {
          saveSyncKey(legacy);
          accept(saved.desk, legacy, storeRef.current, null);
          return;
        }
        saveSyncKey(key);
        takeSynced(result.store);
      })();
    } else if (linked) {
      accept(linked.desk, linked.key, storeRef.current, "This browser is on that desk.");
    } else if (loadSyncKey()) {
      tick();
    }

    const timer = window.setInterval(tick, 8000);
    window.addEventListener("focus", tick);
    return () => {
      cancel = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);

  function takeSynced(next: Store) {
    if (sameContent(storeRef.current, next) && storeRef.current.vaultId === next.vaultId) return;
    persistLocal(next);
    storeRef.current = next;
    setStore(next);
  }

  function remember(next: Store) {
    const stamped = stampStore(next);
    persistLocal(stamped);
    storeRef.current = stamped;
    setStore(stamped);
    const key = loadSyncKey();
    const desk = loadGoogleAccount()?.desk || stamped.vaultId;
    if (key && normalizeVaultId(desk)) queueSync(desk, key, () => storeRef.current, takeSynced);
    return stamped;
  }

  async function onGoogleCredential(credential: string) {
    const profile = await verifyGoogleCredential(credential);
    if (!profile) {
      setNotice({ text: "Google didn't sign in.", kind: "error" });
      return;
    }
    const owner = loadDeskOwner();
    const desk = (await deskFromGoogle(profile.sub)).desk;
    const local = owner && owner !== profile.sub ? { ...emptyStore(), vaultId: desk } : storeRef.current;
    const keepKey = owner === profile.sub ? loadSyncKey() : "";
    const opened = await adoptDrive({
      sub: profile.sub,
      email: profile.email,
      interactive: true,
      local,
      fallbackDesk: desk,
      keepKey,
    });
    const nextDesk = opened.ok ? opened.desk : desk;
    const nextStore = opened.ok ? opened.store : { ...local, vaultId: nextDesk };
    if (!opened.ok && !loadSyncKey()) saveSyncKey(newSyncKey());
    const next = { ...profile, desk: nextDesk };
    saveGoogleAccount(next);
    saveDeskOwner(profile.sub);
    setAccount(next);
    setDriveOn(opened.ok ? "on" : "off");
    stripSyncLink();
    takeSynced(nextStore);
    setNotice({
      text: opened.ok ? "Signed in. Hours are in your Google Drive." : "Signed in on this browser. Google Drive didn't open.",
      kind: opened.ok ? "ok" : "error",
    });
  }

  async function allowDrive() {
    const current = accountRef.current;
    if (!current) return;
    const opened = await adoptDrive({
      sub: current.sub,
      email: current.email,
      interactive: true,
      local: storeRef.current,
      fallbackDesk: current.desk,
      keepKey: loadDeskOwner() === current.sub ? loadSyncKey() : "",
    });
    if (!opened.ok) {
      setDriveOn("off");
      setNotice({ text: "Google Drive didn't open. Hours stay on this browser.", kind: "error" });
      return;
    }
    setDriveOn("on");
    if (opened.desk !== current.desk) {
      const next = { ...current, desk: opened.desk };
      saveGoogleAccount(next);
      setAccount(next);
    }
    takeSynced(opened.store);
    setNotice({ text: "Hours are in your Google Drive.", kind: "ok" });
  }

  function signOut() {
    const email = accountRef.current?.email ?? "";
    clearGoogleAccount();
    clearDriveToken();
    signOutGoogle(email);
    setAccount(null);
    setDriveOn("unknown");
    setNotice({ text: "Signed out.", kind: "ok" });
  }

  function commit(next: Store, message: string | undefined, previous?: Store, restoreLabel = "Entry restored.") {
    remember(next);
    setUndo(previous ? { store: previous, label: restoreLabel } : null);
    setNotice(message ? { text: message, kind: "ok" } : null);
  }

  function apply(result: PlaceResult, message?: string, keepUndo = false): boolean {
    if (!result.ok) {
      setUndo(null);
      setNotice({ text: result.error, kind: "error" });
      return false;
    }
    remember({ ...store, entries: result.entries });
    if (!keepUndo) setUndo(null);
    if (message !== undefined) setNotice({ text: message, kind: "ok" });
    return true;
  }

  function applyJob(
    result: Store | { ok: false; error: string },
    message?: string,
    previous?: Store,
    restoreLabel?: string,
  ): boolean {
    if ("ok" in result) {
      setUndo(null);
      setNotice({ text: result.error, kind: "error" });
      return false;
    }
    commit(result, message, previous, restoreLabel);
    return true;
  }

  const weekStart = store.settings.weekStart;
  const visible = useMemo(
    () => entriesInRange(entries, range, new Date(now), weekStart),
    [entries, range, now, weekStart],
  );
  const days = useMemo(() => groupByDay(visible, new Date(now)), [visible, now]);
  const weekAll = weekAcrossJobs(store, now);
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
      `horas-${store.jobs.length > 1 ? "desk" : jobSlug(job.name)}-${range}-${stamp()}.csv`,
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
      className={["hz", night ? "night" : "", view === "time" ? "time" : "", active ? "live" : "", adding ? "adding" : ""]
        .filter(Boolean)
        .join(" ")}
      data-palette={palette}
    >
      <div className="card">
        <header className="mast">
          <div className="mast-id">
            <h1>Horas</h1>
            <p>
              <span className="date-long">{todayLong}</span>
              <span className="date-short">{todayShort}</span>
            </p>
          </div>
          <div className="mast-side">
            <section className="account" aria-label="Account">
              {account ? (
                <>
                  <p className="who">{account.email || account.name || "Signed in"}</p>
                  <button className="text" type="button" onClick={signOut}>
                    Sign out
                  </button>
                </>
              ) : (
                <GoogleSignIn onCredential={(credential) => void onGoogleCredential(credential)} />
              )}
            </section>
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

        {account && driveOn === "off" ? (
          <p className="note error" role="status">
            <span>Hours stay on this browser until Google Drive opens.</span>
            <button className="text" type="button" onClick={() => void allowDrive()}>
              Save to Drive
            </button>
          </p>
        ) : null}

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

        {view === "settings" ? (
          <SettingsPanel
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

            <div className="desk-side">
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
                        applyJob(deleteJob(store, job.id), "Job deleted.", store, "Job restored.");
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
              <p className="kicker">
                {active
                  ? onBreak(active)
                    ? `Break · ${job.name}`
                    : `Running · ${job.name}`
                  : openOther
                    ? `Waiting · ${job.name}`
                    : `Off · ${job.name}`}
              </p>
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
                    onChange={(event) => apply(updateEntry(entries, active.id, { comment: event.target.value }), undefined, true)}
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
                        commit(undo.store, undo.label);
                      }}
                    >
                      Undo
                    </button>
                  ) : null}
                </p>
              ) : null}
            </section>

            <section className="week" aria-label="This week across jobs">
              <header>
                <h2>This week</h2>
                <p>
                  <span className="fig">{formatDuration(weekAll.ms)}</span>
                  <span className="money">{formatMoney(weekAll.amount, store.settings.currency)}</span>
                </p>
              </header>
              {weekAll.jobs.length > 1 ? (
                <ul>
                  {weekAll.jobs.map((item) => (
                    <li key={item.id} className={item.id === job.id ? "on" : undefined}>
                      <span>{item.name}</span>
                      <span>{formatDuration(item.ms)}</span>
                      <span className="money">{formatMoney(item.amount, store.settings.currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            </div>

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
                <button className="text" type="button" onClick={exportCsv}>
                  Export CSV
                </button>
              </header>

              {days.length === 0 ? (
                <p className="empty">Nothing in this period.</p>
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
                          jobName={store.jobs.length > 1 ? jobNameOf(store.jobs, jobIdOf(item)) : ""}
                          money={amountForEntry(store, item, now)}
                          currency={store.settings.currency}
                          onChange={(patch) => {
                            const times = patch.clockIn !== undefined || patch.clockOut !== undefined;
                            return apply(updateEntry(entries, item.id, patch), times ? "Entry updated." : undefined, !times);
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
              <button className="text" type="button" onClick={() => commit(undo.store, undo.label)}>
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

function growNote(node: HTMLTextAreaElement | null) {
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight}px`;
}

function EntryRow({
  entry,
  now,
  jobName,
  money,
  currency,
  onChange,
  onDelete,
}: {
  entry: Entry;
  now: number;
  jobName: string;
  money: number;
  currency: string;
  onChange: (patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment" | "billable">>) => boolean;
  onDelete: () => void;
}) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [date, setDate] = useState(() => toDateValue(entry.clockIn));
  const [start, setStart] = useState(() => toTimeValue(entry.clockIn));
  const [end, setEnd] = useState(() => (entry.clockOut === null ? "" : toTimeValue(entry.clockOut)));

  useEffect(() => {
    growNote(noteRef.current);
  }, [entry.comment, editing]);

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
        {jobName ? <span className="job-name">{jobName}</span> : null}
        {money > 0 && isBillable(entry) ? <span className="money">{formatMoney(money, currency)}</span> : null}
        {!isBillable(entry) ? <span className="dur">Off the bill</span> : null}
      </p>
      {entry.comment.trim() !== "" && !editing ? <p className="said">{entry.comment}</p> : null}
      <button
        className="text row-edit"
        type="button"
        onClick={() => {
          setConfirming(false);
          setEditing((open) => !open);
        }}
      >
        {editing ? "Close" : "Edit"}
      </button>
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
          <label className="span">
            Comment
            <textarea
              ref={noteRef}
              id={`comment-${entry.id}`}
              className="note-line"
              value={entry.comment}
              rows={2}
              onChange={(event) => {
                growNote(event.currentTarget);
                onChange({ comment: event.target.value });
              }}
            />
          </label>
          <div className="row-actions">
            <button className="text" type="button" onClick={() => onChange({ billable: !isBillable(entry) })}>
              {isBillable(entry) ? "Billable" : "Non-billable"}
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
              <button className="text danger" type="button" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )}
          </div>
          <button className="btn slim" type="submit">
            Save
          </button>
        </form>
      ) : null}
    </li>
  );
}
