import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  addManual,
  clockIn,
  clockOut,
  combineLocal,
  deleteEntry,
  durationMs,
  entriesInRange,
  formatClock,
  formatDayLabel,
  formatDuration,
  formatOutLabel,
  formatRunning,
  groupByDay,
  loadEntries,
  mergeEntries,
  openEntry,
  originOf,
  parseBackup,
  saveEntries,
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
} from "./model";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Hoy" },
  { key: "week", label: "Semana" },
  { key: "month", label: "Mes" },
  { key: "all", label: "Todo" },
];

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
        aria-label="Hora"
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
        aria-label="Minutos"
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
  const [entries, setEntries] = useState<Entry[]>(() => loadEntries());
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<RangeKey>("week");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undo, setUndo] = useState<Entry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = openEntry(entries);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice(null);
      setUndo(null);
    }, undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice, undo]);

  function commit(next: Entry[], message: string | undefined, previous?: Entry[]) {
    saveEntries(next);
    setEntries(next);
    setUndo(previous ?? null);
    setNotice(message ? { text: message, kind: "ok" } : null);
  }

  function apply(result: PlaceResult, message?: string): boolean {
    if (!result.ok) {
      setUndo(null);
      setNotice({ text: result.error, kind: "error" });
      return false;
    }
    saveEntries(result.entries);
    setEntries(result.entries);
    setUndo(null);
    if (message !== undefined) setNotice({ text: message, kind: "ok" });
    return true;
  }

  const visible = useMemo(() => entriesInRange(entries, range, new Date(now)), [entries, range, now]);
  const days = useMemo(() => groupByDay(visible, new Date(now)), [visible, now]);
  const todayTotal = totalMs(entriesInRange(entries, "today", new Date(now)), now);
  const weekTotal = totalMs(entriesInRange(entries, "week", new Date(now)), now);
  const monthTotal = totalMs(entriesInRange(entries, "month", new Date(now)), now);
  const todayTitle = new Date(now).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  function exportCsv() {
    download(`horas-${range}-${stamp()}.csv`, toCsv(visible, now), "text/csv;charset=utf-8");
    setUndo(null);
    setNotice({
      text: `CSV descargado con ${visible.length} ${visible.length === 1 ? "registro" : "registros"}.`,
      kind: "ok",
    });
  }

  function exportBackup() {
    download(`horas-copia-${stamp()}.json`, toBackup(entries), "application/json");
    setUndo(null);
    setNotice({ text: "Copia descargada.", kind: "ok" });
  }

  async function importBackup(file: File) {
    try {
      const incoming = parseBackup(await file.text());
      commit(mergeEntries(entries, incoming), `Se importaron ${incoming.length} registros.`);
    } catch {
      setUndo(null);
      setNotice({ text: "No pude leer ese archivo. Usa una copia exportada desde Horas.", kind: "error" });
    }
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

  return (
    <div className={active ? "hz live" : "hz"}>
      <div className="card">
        <header className="mast">
          <h1>Horas</h1>
          <p>{todayTitle.charAt(0).toUpperCase() + todayTitle.slice(1)}</p>
        </header>

        <section className="punch" aria-label="Fichaje">
          {active ? (
            <>
              <p className="stamp" aria-live="polite">
                {formatRunning(durationMs(active, now))}
              </p>
              <p className="status">En curso desde {formatClock(active.clockIn)}</p>
              <label htmlFor="active-comment">Qué hiciste</label>
              <textarea
                id="active-comment"
                value={active.comment}
                placeholder="A qué te dedicaste en este tramo."
                onChange={(event) => apply(updateEntry(entries, active.id, { comment: event.target.value }))}
              />
              <button className="btn stop" type="button" onClick={() => commit(clockOut(entries, Date.now()), "Tramo cerrado.")}>
                Salir
              </button>
            </>
          ) : (
            <>
              <p className="stamp">{formatClock(now)}</p>
              <p className="status">Fuera. Entra al empezar, o añade un tramo si se te olvidó.</p>
              <button className="btn start" type="button" onClick={() => apply(clockIn(entries, Date.now()), "Tramo abierto.")}>
                Entrar
              </button>
            </>
          )}

          {adding ? (
            <ManualForm
              now={now}
              onCancel={() => {
                setAdding(false);
              }}
              onSave={(draft) => {
                if (apply(addManual(entries, draft), "Horas añadidas.")) setAdding(false);
              }}
            />
          ) : (
            <button className="btn quiet" type="button" onClick={() => setAdding(true)}>
              Añadir horas
            </button>
          )}

          {notice ? (
            <p className={notice.kind === "error" ? "note error" : "note"} role="status">
              <span>{notice.text}</span>
              {undo ? (
                <button
                  className="text"
                  type="button"
                  onClick={() => {
                    commit(undo, "Registro recuperado.");
                  }}
                >
                  Deshacer
                </button>
              ) : null}
            </p>
          ) : null}
        </section>

        <dl className="sums" aria-label="Totales">
          <div>
            <dt>Hoy</dt>
            <dd>{formatDuration(todayTotal)}</dd>
          </div>
          <div>
            <dt>Semana</dt>
            <dd>{formatDuration(weekTotal)}</dd>
          </div>
          <div>
            <dt>Mes</dt>
            <dd>{formatDuration(monthTotal)}</dd>
          </div>
        </dl>

        <section className="ledger">
          <header className="ledger-bar">
            <div className="ranges" role="tablist" aria-label="Periodo" onKeyDown={onRangeKey}>
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
              <p>{formatDuration(totalMs(visible, now))} en este periodo</p>
              <button className="btn quiet slim" type="button" onClick={exportCsv}>
                Exportar CSV
              </button>
            </div>
          </header>

          {days.length === 0 ? (
            <p className="empty">Este periodo está vacío. Entra ahora o añade un tramo cerrado.</p>
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
                      onChange={(patch) => {
                        const times = patch.clockIn !== undefined || patch.clockOut !== undefined;
                        return apply(updateEntry(entries, item.id, patch), times ? "Registro actualizado." : undefined);
                      }}
                      onDelete={() => commit(deleteEntry(entries, item.id), "Registro borrado.", entries)}
                    />
                  ))}
                </ul>
              </article>
            ))
          )}

          <footer className="foot">
            <p>Gratis y sin cuenta. Las horas se quedan en este navegador.</p>
            <div className="foot-actions">
              <button className="text" type="button" onClick={exportBackup}>
                Descargar copia
              </button>
              <button className="text" type="button" onClick={() => fileRef.current?.click()}>
                Restaurar copia
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
  onSave: (draft: { clockIn: number; clockOut: number; comment: string }) => void;
}) {
  const [date, setDate] = useState(() => toDateValue(now));
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [comment, setComment] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const clockInAt = combineLocal(date, start);
  let clockOutAt = combineLocal(date, end);
  const overnight = !Number.isNaN(clockInAt) && !Number.isNaN(clockOutAt) && clockOutAt < clockInAt;
  if (overnight) clockOutAt += 86_400_000;
  const preview =
    Number.isNaN(clockInAt) || Number.isNaN(clockOutAt)
      ? null
      : `${formatDuration(trackedMs({ clockIn: clockInAt, clockOut: clockOutAt }))}${overnight ? " · pasa de medianoche" : ""}`;

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
        onSave({ clockIn: clockInAt, clockOut: clockOutAt, comment });
      }}
    >
      <p>Añadir un tramo cerrado</p>
      <label>
        Fecha
        <input ref={first} name="date" type="date" value={date} lang="es" onChange={(event) => setDate(event.target.value)} required />
      </label>
      <div className="pair">
        <label>
          Entrada
          <TimeInput name="start" value={start} onChange={setStart} required />
        </label>
        <label>
          Salida
          <TimeInput name="end" value={end} onChange={setEnd} required />
        </label>
      </div>
      <label>
        Comentario
        <textarea name="comment" value={comment} placeholder="Qué hiciste" onChange={(event) => setComment(event.target.value)} />
      </label>
      <p className="preview">{preview ?? "Indica entrada y salida."}</p>
      <div className="manual-actions">
        <button className="btn start slim" type="submit">
          Guardar horas
        </button>
        <button className="btn quiet slim" type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function EntryRow({
  entry,
  now,
  onChange,
  onDelete,
}: {
  entry: Entry;
  now: number;
  onChange: (patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment">>) => boolean;
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
        <span className="dur">{durationLabel}</span>
        {originOf(entry) === "manual" ? <span className="tag">añadido</span> : <span />}
      </p>
      <label className="sr" htmlFor={`comment-${entry.id}`}>
        Comentario del {formatDayLabel(entry.clockIn)}
      </label>
      <textarea
        id={`comment-${entry.id}`}
        className="note-line"
        value={entry.comment}
        placeholder="Sin comentario"
        rows={Math.min(3, Math.max(1, entry.comment.split("\n").length))}
        onChange={(event) => onChange({ comment: event.target.value })}
      />
      <div className="row-actions">
        <button
          className="text"
          type="button"
          onClick={() => {
            setConfirming(false);
            setEditing((open) => !open);
          }}
        >
          {editing ? "Cerrar" : "Corregir"}
        </button>
        {confirming ? (
          <>
            <span className="ask">¿Borrar?</span>
            <button
              className="text danger"
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Sí, borrar
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
            Borrar
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
            Fecha
            <input name="edit-date" type="date" lang="es" value={date} onChange={(event) => setDate(event.target.value)} required />
          </label>
          <label>
            Entrada
            <TimeInput name="edit-start" value={start} onChange={setStart} required />
          </label>
          <label>
            Salida
            <TimeInput name="edit-end" value={end} onChange={setEnd} />
          </label>
          <button className="btn slim" type="submit">
            Guardar
          </button>
        </form>
      ) : null}
    </li>
  );
}
