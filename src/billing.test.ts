import assert from "node:assert/strict";
import test from "node:test";
import { createInvoice, totalsFor, unbilledEntries } from "./billing.ts";
import { addClient, addManual, combineLocal, emptyStore, setJobBilling, type Store } from "./model.ts";
import { renderInvoicePdf } from "./pdf.ts";

function desk(): Store {
  const base = emptyStore();
  const withClient = addClient(base, { name: "North Studio", email: "hi@north.test", hourlyRate: 50 });
  if ("ok" in withClient) throw new Error(withClient.error);
  const linked = setJobBilling(withClient, withClient.jobs[0].id, { clientId: withClient.clients[0].id });
  if ("ok" in linked) throw new Error(linked.error);
  return { ...linked, settings: { ...linked.settings, taxPercent: 10, currency: "USD", businessName: "Ada Freelance" } };
}

test("invoice uses closed billable hours and keeps the rate it was drafted with", () => {
  const start = desk();
  const jobId = start.jobs[0].id;
  const morning = addManual([], {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "11:00"),
    comment: "Design",
    jobId,
  });
  assert.equal(morning.ok, true);
  if (!morning.ok) return;
  const open = addManual(morning.entries, {
    clockIn: combineLocal("2026-09-21", "12:00"),
    clockOut: combineLocal("2026-09-21", "13:00"),
    comment: "Call",
    jobId,
    billable: false,
  });
  assert.equal(open.ok, true);
  if (!open.ok) return;
  const store = { ...start, entries: open.entries };
  const ready = unbilledEntries(store, store.clients[0].id);
  assert.deepEqual(
    ready.map((entry) => entry.comment),
    ["Design"],
  );
  const drafted = createInvoice(store, store.clients[0].id, ready.map((entry) => entry.id), combineLocal("2026-09-22", "09:00"));
  if ("ok" in drafted) throw new Error(drafted.error);
  const invoice = drafted.invoices[0];
  assert.equal(invoice.number, "H-0001");
  assert.equal(invoice.lines[0].hours, 2);
  assert.equal(invoice.lines[0].amount, 100);
  assert.equal(totalsFor(invoice).tax, 10);
  assert.equal(totalsFor(invoice).total, 110);
  assert.equal(unbilledEntries(drafted, drafted.clients[0].id).length, 0);
  assert.equal(drafted.settings.nextNumber, 2);
  const pdf = new TextDecoder().decode(renderInvoicePdf(invoice, drafted.settings));
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.match(pdf, /H-0001/);
  assert.match(pdf, /North Studio/);
  assert.match(pdf, /110\.00/);
});
