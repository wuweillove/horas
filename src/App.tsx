import { useEffect, useMemo, useRef, useState } from "react";
import {
  clockIn,
  clockOut,
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
  parseBackup,
  saveEntries,
  timesAreValid,
  toBackup,
  toCsv,
  toLocalInput,
  totalMs,
  updateEntry,
  type Entry,
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
    setNotice("Copia de seguridad descargada.");
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
    <main className="app">
      <header className="top">
        <div>
          <p className="eyebrow">Registro personal</p>
          <h1>Horas</h1>
        </div>
        <button className="button ghost" type="button" onClick={exportCsv}>
          Exportar CSV
        </button>
      </header>

      <section className="hero" aria-label="Fichaje">
        {active ? (
          <>
            <p className="status">En curso desde {formatClock(active.clockIn)}</p>
            <p className="timer" aria-live="polite">
              {formatRunning(durationMs(active, now))}
            </p>
            <label className="comment-label" htmlFor="active-comment">
              Qué hiciste
            </label>
            <textarea
              id="active-comment"
              value={active.comment}
              placeholder="Una nota corta del tramo: a qué te dedicaste."
              onChange={(event) => commit(updateEntry(entries, active.id, { comment: event.target.value }))}
            />
            <button className="button stop" type="button" onClick={() => commit(clockOut(entries, Date.now()))}>
              Salir
            </button>
          </>
        ) : (
          <>
            <p className="status">Fuera</p>
            <p className="idle-title">Cuando empieces, entra.</p>
            <button className="button start" type="button" onClick={() => commit(clockIn(entries, Date.now()))}>
              Entrar
            </button>
          </>
        )}
      </section>

      <section className="totals" aria-label="Totales">
        <Total label="Hoy" value={formatDuration(todayTotal)} />
        <Total label="Esta semana" value={formatDuration(weekTotal)} />
        <Total label="Este mes" value={formatDuration(monthTotal)} />
      </section>

      <section className="history">
        <div className="history-bar">
          <div className="ranges" role="tablist" aria-label="Periodo">
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={range === item.key}
                className={range === item.key ? "range active" : "range"}
                onClick={() => setRange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="period-total">{formatDuration(totalMs(visible, now))} en este periodo</p>
        </div>

        {days.length === 0 ? (
          <p className="empty">Todavía no hay horas en este periodo.</p>
        ) : (
          days.map((day) => (
            <article key={day.key} className="day">
              <header>
                <h2>{day.label}</h2>
                <span>{formatDuration(day.totalMs)}</span>
              </header>
              <ul>
                {day.entries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    now={now}
                    anotherOpen={entries.some((item) => item.id !== entry.id && item.clockOut === null)}
                    onChange={(patch) => commit(updateEntry(entries, entry.id, patch))}
                    onDelete={() => {
                      if (window.confirm("¿Borrar este registro?")) commit(deleteEntry(entries, entry.id), "Registro borrado.");
                    }}
                  />
                ))}
              </ul>
            </article>
          ))
        )}
      </section>

      <footer className="foot">
        <p>Gratis y sin cuenta. Las horas se guardan solo en este navegador.</p>
        <div className="foot-actions">
          <button className="text-button" type="button" onClick={exportBackup}>
            Descargar copia
          </button>
          <button className="text-button" type="button" onClick={() => fileRef.current?.click()}>
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
        {notice ? <p className="notice">{notice}</p> : null}
      </footer>
    </main>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <article>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function EntryRow({
  entry,
  now,
  anotherOpen,
  onChange,
  onDelete,
}: {
  entry: Entry;
  now: number;
  anotherOpen: boolean;
  onChange: (patch: Partial<Pick<Entry, "clockIn" | "clockOut" | "comment">>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [clockInValue, setClockInValue] = useState(() => toLocalInput(entry.clockIn));
  const [clockOutValue, setClockOutValue] = useState(() => (entry.clockOut === null ? "" : toLocalInput(entry.clockOut)));
  const [error, setError] = useState<string | null>(null);

  function saveTimes() {
    const nextIn = new Date(clockInValue).getTime();
    const nextOut = clockOutValue === "" ? null : new Date(clockOutValue).getTime();
    if (!timesAreValid(nextIn, nextOut)) {
      setError("La salida tiene que ser posterior a la entrada.");
      return;
    }
    if (nextOut === null && anotherOpen) {
      setError("Ya hay un tramo en curso. Ciérralo antes de dejar este abierto.");
      return;
    }
    onChange({ clockIn: nextIn, clockOut: nextOut });
    setError(null);
    setEditing(false);
  }

  return (
    <li>
      <div className="entry-main">
        <p className="span">
          {formatClock(entry.clockIn)} – {entry.clockOut === null ? "ahora" : formatClock(entry.clockOut)}
          <span>{formatDuration(durationMs(entry, now))}</span>
        </p>
        <label className="sr" htmlFor={`comment-${entry.id}`}>
          Comentario del {formatDayLabel(entry.clockIn)}
        </label>
        <textarea
          id={`comment-${entry.id}`}
          className="entry-comment"
          value={entry.comment}
          placeholder="Sin comentario"
          rows={Math.min(4, Math.max(1, entry.comment.split("\n").length))}
          onChange={(event) => onChange({ comment: event.target.value })}
        />
        <div className="entry-actions">
          <button className="text-button" type="button" onClick={() => setEditing((open) => !open)}>
            {editing ? "Cerrar" : "Corregir horas"}
          </button>
          <button className="text-button danger" type="button" onClick={onDelete}>
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
              <input
                type="datetime-local"
                value={clockOutValue}
                onChange={(event) => setClockOutValue(event.target.value)}
              />
            </label>
            <button className="button small" type="submit">
              Guardar
            </button>
            {error ? <p className="error">{error}</p> : null}
          </form>
        ) : null}
      </div>
    </li>
  );
}
