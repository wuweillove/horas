import { useEffect, useMemo, useRef, useState } from "react";
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
  toLocalInput,
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

export function App() {
  const [entries, setEntries] = useState<Entry[]>(() => loadEntries());
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<RangeKey>("week");
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = openEntry(entries);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  function commit(next: Entry[], message?: string) {
    saveEntries(next);
    setEntries(next);
    setNotice(message ?? null);
  }

  function apply(result: PlaceResult, message?: string): boolean {
    if (!result.ok) {
      setNotice(result.error);
      return false;
    }
    saveEntries(result.entries);
    setEntries(result.entries);
    if (message !== undefined) setNotice(message);
    return true;
  }

  const visible = useMemo(() => entriesInRange(entries, range, new Date(now)), [entries, range, now]);
  const days = useMemo(() => groupByDay(visible, new Date(now)), [visible, now]);
  const todayTotal = totalMs(entriesInRange(entries, "today", new Date(now)), now);
  const weekTotal = totalMs(entriesInRange(entries, "week", new Date(now)), now);
  const monthTotal = totalMs(entriesInRange(entries, "month", new Date(now)), now);

  function exportCsv() {
    download(`horas-${stamp()}.csv`, toCsv(visible, now), "text/csv;charset=utf-8");
    setNotice(`CSV descargado con ${visible.length} ${visible.length === 1 ? "registro" : "registros"}.`);
  }

  function exportBackup() {
    download(`horas-copia-${stamp()}.json`, toBackup(entries), "application/json");
    setNotice("Copia descargada.");
  }

  async function importBackup(file: File) {
    try {
      const incoming = parseBackup(await file.text());
      commit(mergeEntries(entries, incoming), `Se importaron ${incoming.length} registros.`);
    } catch {
      setNotice("No pude leer ese archivo. Usa una copia exportada desde Horas.");
    }
  }

  return (
    <div className="shell">
      <aside className={active ? "station live" : "station"}>
        <header className="brand">
          <h1>Horas</h1>
          <p>Fichaje y libro personal.</p>
        </header>

        <section className="punch" aria-label="Fichaje">
          {active ? (
            <>
              <p className="status">En curso desde {formatClock(active.clockIn)}</p>
              <p className="timer" aria-live="polite">
                {formatRunning(durationMs(active, now))}
              </p>
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
              <p className="status">Fuera</p>
              <p className="idle">Cuando empieces, entra. Si se te olvidó, añade las horas.</p>
              <button
                className="btn start"
                type="button"
                onClick={() => apply(clockIn(entries, Date.now()))}
              >
                Entrar
              </button>
            </>
          )}

          {adding ? (
            <ManualForm
              now={now}
              onCancel={() => {
                setAdding(false);
                setNotice(null);
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
      </aside>

      <section className="ledger">
        <header className="ledger-bar">
          <div className="ranges" role="tablist" aria-label="Periodo">
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={range === item.key}
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
          <p className="empty">No hay horas en este periodo. Entra o añádelas.</p>
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
                    onDelete={() => {
                      if (window.confirm("¿Borrar este registro?")) commit(deleteEntry(entries, item.id), "Registro borrado.");
                    }}
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

      <p className={notice ? "banner on" : "banner"} role="status">
        {notice}
      </p>
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
  const preview = Number.isNaN(clockInAt) || Number.isNaN(clockOutAt)
    ? null
    : `${formatDuration(trackedMs({ clockIn: clockInAt, clockOut: clockOutAt }))}${overnight ? " (pasa de medianoche)" : ""}`;

  useEffect(() => {
    first.current?.focus();
  }, []);

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
        <input ref={first} type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
      </label>
      <div className="pair">
        <label>
          Entrada
          <input type="time" value={start} onChange={(event) => setStart(event.target.value)} required />
        </label>
        <label>
          Salida
          <input type="time" value={end} onChange={(event) => setEnd(event.target.value)} required />
        </label>
      </div>
      <label>
        Comentario
        <textarea value={comment} placeholder="Qué hiciste" onChange={(event) => setComment(event.target.value)} />
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
  const [clockInValue, setClockInValue] = useState(() => toLocalInput(entry.clockIn));
  const [clockOutValue, setClockOutValue] = useState(() => (entry.clockOut === null ? "" : toLocalInput(entry.clockOut)));

  useEffect(() => {
    if (!editing) return;
    setClockInValue(toLocalInput(entry.clockIn));
    setClockOutValue(entry.clockOut === null ? "" : toLocalInput(entry.clockOut));
  }, [editing, entry.clockIn, entry.clockOut]);

  function saveTimes() {
    const nextIn = new Date(clockInValue).getTime();
    const nextOut = clockOutValue === "" ? null : new Date(clockOutValue).getTime();
    if (onChange({ clockIn: nextIn, clockOut: nextOut })) setEditing(false);
  }

  return (
    <li className={entry.clockOut === null ? "row open" : "row"}>
      <p className="when">
        <time>
          {formatClock(entry.clockIn)}–{entry.clockOut === null ? "ahora" : formatClock(entry.clockOut)}
        </time>
        <span>{formatDuration(trackedMs(entry, now))}</span>
        {originOf(entry) === "manual" ? <span className="tag">añadido</span> : null}
      </p>
      <label className="sr" htmlFor={`comment-${entry.id}`}>
        Comentario del {formatDayLabel(entry.clockIn)}
      </label>
      <textarea
        id={`comment-${entry.id}`}
        value={entry.comment}
        placeholder="Sin comentario"
        rows={Math.min(3, Math.max(1, entry.comment.split("\n").length))}
        onChange={(event) => onChange({ comment: event.target.value })}
      />
      <div className="row-actions">
        <button className="text" type="button" onClick={() => setEditing((open) => !open)}>
          {editing ? "Cerrar" : "Corregir"}
        </button>
        <button className="text danger" type="button" onClick={onDelete}>
          Borrar
        </button>
      </div>
      {editing ? (
        <form
          className="edit"
          onSubmit={(event) => {
            event.preventDefault();
            saveTimes();
          }}
        >
          <label>
            Entrada
            <input type="datetime-local" value={clockInValue} onChange={(event) => setClockInValue(event.target.value)} required />
          </label>
          <label>
            Salida
            <input type="datetime-local" value={clockOutValue} onChange={(event) => setClockOutValue(event.target.value)} />
          </label>
          <button className="btn slim" type="submit">
            Guardar
          </button>
        </form>
      ) : null}
    </li>
  );
}
