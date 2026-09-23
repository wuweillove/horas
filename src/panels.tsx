import { useEffect, useState } from "react";
import { amountForEntry, createInvoice, formatMoney, totalsFor, unbilledEntries } from "./billing.ts";
import {
  addClient,
  dayHour,
  deleteClient,
  deleteInvoice,
  formatDayKey,
  setInvoiceStatus,
  updateClient,
  updateSettings,
  type InvoiceStatus,
  type PaletteId,
  type Store,
  type WeekStart,
} from "./model.ts";
import { renderInvoicePdf } from "./pdf.ts";

function blobBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function downloadBytes(filename: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([blobBytes(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type DeskChange = Store | { ok: false; error: string };

type PanelProps = {
  store: Store;
  onChange: (next: DeskChange, message?: string) => boolean;
  onError: (text: string) => void;
};

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "MXN"];
const PALETTE_CHOICES: { id: PaletteId; label: string }[] = [
  { id: "salvia", label: "Salvia" },
  { id: "tiza", label: "Tiza" },
  { id: "oxido", label: "Óxido" },
];
const NIGHT_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function SettingsPanel({ store, onChange, onError }: PanelProps) {
  const [businessName, setBusinessName] = useState(store.settings.businessName);
  const [email, setEmail] = useState(store.settings.email);
  const [address, setAddress] = useState(store.settings.address);
  const [currency, setCurrency] = useState(store.settings.currency);
  const [tax, setTax] = useState(String(store.settings.taxPercent));
  const morning = String(dayHour(store.settings.nightHour)).padStart(2, "0");

  useEffect(() => {
    setBusinessName(store.settings.businessName);
    setEmail(store.settings.email);
    setAddress(store.settings.address);
    setCurrency(store.settings.currency);
    setTax(String(store.settings.taxPercent));
  }, [store.settings]);

  function chooseWeek(weekStart: WeekStart) {
    if (weekStart !== store.settings.weekStart) onChange(updateSettings(store, { weekStart }));
  }

  return (
    <section className="ledger panel" aria-label="Settings">
      <div className="panel-side">
        <div className="set">
          <p className="kicker">Palette</p>
          <div className="palettes" role="radiogroup" aria-label="Palette">
            {PALETTE_CHOICES.map((item) => (
              <button
                key={item.id}
                className={store.settings.palette === item.id ? "swatch on" : "swatch"}
                type="button"
                role="radio"
                aria-checked={store.settings.palette === item.id}
                onClick={() => {
                  if (store.settings.palette !== item.id) onChange(updateSettings(store, { palette: item.id }));
                }}
              >
                <span className={`chip ${item.id}`} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="set">
          <p className="kicker">Week</p>
          <div className="ranges" role="tablist" aria-label="Week">
            {(
              [
                ["monday", "Monday"],
                ["sunday", "Sunday"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={store.settings.weekStart === key ? "range on" : "range"}
                type="button"
                role="tab"
                aria-selected={store.settings.weekStart === key}
                onClick={() => chooseWeek(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="set night-set">
          <label>
            Night
            <select
              name="night-hour"
              value={store.settings.nightHour}
              onChange={(event) => onChange(updateSettings(store, { nightHour: Number(event.target.value) }))}
            >
              {NIGHT_HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
          <p className="kicker">Day {morning}:00</p>
        </div>
      </div>
      <div className="panel-list">
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const taxPercent = Number(tax);
            if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
              onError("Tax has to be between 0 and 100.");
              return;
            }
            onChange(updateSettings(store, { businessName, email, address, currency, taxPercent }), "Imprint saved.");
          }}
        >
          <p>Imprint</p>
          <label>
            Business name
            <input name="business-name" value={businessName} onChange={(event) => setBusinessName(event.target.value)} />
          </label>
          <label>
            Email
            <input name="business-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Address
            <textarea name="business-address" rows={2} value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
          <div className="pair">
            <label>
              Currency
              <select name="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {CURRENCIES.includes(currency) ? null : <option value={currency}>{currency}</option>}
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tax %
              <input name="tax" inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} />
            </label>
          </div>
          <button className="btn slim" type="submit">
            Save imprint
          </button>
        </form>
      </div>
    </section>
  );
}

export function ClientsPanel({ store, onChange, onError }: PanelProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [rate, setRate] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  function readRate(): number | undefined {
    if (rate.trim() === "") return 0;
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0) {
      onError("Enter a rate of zero or more.");
      return undefined;
    }
    return value;
  }

  return (
    <section className="ledger panel" aria-label="Clients">
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const hourlyRate = readRate();
          if (hourlyRate === undefined) return;
          const draft = { name, email, address, hourlyRate };
          const result = editing ? updateClient(store, editing, draft) : addClient(store, draft);
          if (onChange(result, editing ? "Client updated." : "Client added.")) {
            setEditing(null);
            setName("");
            setEmail("");
            setAddress("");
            setRate("");
          }
        }}
      >
        <p>{editing ? "Edit client" : "New client"}</p>
        <label>
          Name
          <input name="client-name" value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Email
          <input name="client-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Address
          <textarea name="client-address" value={address} rows={2} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <label>
          Hourly rate
          <input
            name="client-rate"
            inputMode="decimal"
            value={rate}
            placeholder="0"
            onChange={(event) => setRate(event.target.value)}
          />
        </label>
        <div className="manual-actions">
          <button className="btn slim" type="submit">
            {editing ? "Save client" : "Add client"}
          </button>
          {editing ? (
            <button
              className="btn quiet slim"
              type="button"
              onClick={() => {
                setEditing(null);
                setName("");
                setEmail("");
                setAddress("");
                setRate("");
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
      <div className="panel-list">
      {store.clients.length === 0 ? <p className="empty">No clients yet.</p> : null}
      {store.clients.map((client) => (
        <article key={client.id} className="client">
          <header>
            <h2>{client.name}</h2>
            <span className="money">{formatMoney(client.hourlyRate, store.settings.currency)} / h</span>
          </header>
          {client.email || client.address ? (
            <p className="muted">
              {[client.email, client.address].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          <div className="row-actions">
            <button
              className="text"
              type="button"
              onClick={() => {
                setEditing(client.id);
                setName(client.name);
                setEmail(client.email);
                setAddress(client.address);
                setRate(String(client.hourlyRate));
              }}
            >
              Edit
            </button>
            <button
              className="text danger"
              type="button"
              onClick={() => onChange(deleteClient(store, client.id), "Client removed.")}
            >
              Remove
            </button>
          </div>
        </article>
      ))}
      </div>
    </section>
  );
}

export function InvoicesPanel({ store, onChange }: PanelProps) {
  const [clientId, setClientId] = useState(store.clients[0]?.id ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const open = unbilledEntries(store, clientId);
  const openKey = open.map((entry) => entry.id).join("\n");

  useEffect(() => {
    setPicked(openKey ? openKey.split("\n") : []);
  }, [openKey]);

  function toggle(id: string) {
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  return (
    <section className="ledger panel" aria-label="Invoices">
      <div className="panel-side">
      {store.clients.length === 0 ? (
        <p className="empty">Add a client, then invoice their closed hours.</p>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const result = createInvoice(store, clientId, picked.length ? picked : open.map((entry) => entry.id));
            if (onChange(result, "Invoice drafted.")) setPicked([]);
          }}
        >
          <label>
            Client
            <select
              name="invoice-client"
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value);
                setPicked([]);
              }}
            >
              {store.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          {open.length === 0 ? (
            <p className="muted">No closed billable hours left for this client.</p>
          ) : (
            <div className="checks">
              {open.map((entry) => (
                <label key={entry.id}>
                  <input type="checkbox" checked={picked.includes(entry.id)} onChange={() => toggle(entry.id)} />
                  <span>
                    {formatDayKey(entry.clockIn)} · {formatMoney(amountForEntry(store, entry), store.settings.currency)}
                  </span>
                </label>
              ))}
            </div>
          )}
          <button className="btn slim" type="submit" disabled={picked.length === 0}>
            Draft invoice
          </button>
        </form>
      )}
      </div>

      <div className="panel-list">
      {store.invoices.length === 0 ? <p className="empty">No invoices yet.</p> : null}
      {store.invoices.map((invoice) => {
        const totals = totalsFor(invoice);
        const statuses: InvoiceStatus[] = ["draft", "sent", "paid"];
        return (
          <article key={invoice.id} className="invoice">
            <header>
              <h2>
                {invoice.number} · {invoice.clientName}
              </h2>
              <span className="money">{formatMoney(totals.total, totals.currency)}</span>
            </header>
            <p className="muted">
              {new Date(invoice.issuedAt).toLocaleDateString("en-US")} · {invoice.lines.length}{" "}
              {invoice.lines.length === 1 ? "line" : "lines"}
            </p>
            <div className="status-picks" role="group" aria-label={`${invoice.number} status`}>
              {statuses.map((status) => (
                <button
                  key={status}
                  className="text"
                  type="button"
                  aria-pressed={invoice.status === status}
                  onClick={() => onChange(setInvoiceStatus(store, invoice.id, status))}
                >
                  {status}
                </button>
              ))}
            </div>
            <div className="row-actions">
              <button
                className="text"
                type="button"
                onClick={() => downloadBytes(`${invoice.number}.pdf`, renderInvoicePdf(invoice, store.settings), "application/pdf")}
              >
                PDF
              </button>
              <button className="text danger" type="button" onClick={() => onChange(deleteInvoice(store, invoice.id), "Invoice removed.")}>
                Remove
              </button>
            </div>
          </article>
        );
      })}
      </div>
    </section>
  );
}
