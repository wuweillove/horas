import assert from "node:assert/strict";
import test from "node:test";
import { createInvoice, totalsFor, unbilledEntries, weekAcrossJobs } from "./billing.ts";
import { addClient, addJob, addManual, clockIn, combineLocal, emptyStore, setJobBilling, type Store } from "./model.ts";
import { renderInvoicePdf } from "./pdf.ts";

function desk(): Store {
  const base = emptyStore();
  const withClient = addClient(base, { name: "North Studio", email: "hi@north.test", hourlyRate: 50 });
  if ("ok" in withClient) throw new Error(withClient.error);
  const linked = setJobBilling(withClient, withClient.jobs[0].id, { clientId: withClient.clients[0].id });
  if ("ok" in linked) throw new Error(linked.error);
  return { ...linked, settings: { ...linked.settings, taxPercent: 10, currency: "USD", businessName: "Ada Freelance" } };
}

test("this week adds every job and leaves last week out", () => {
  const start = desk();
  const first = start.jobs[0].id;
  const rated = setJobBilling(start, first, { hourlyRate: 40 });
  if ("ok" in rated) throw new Error(rated.error);
  const added = addJob(rated, "Workshop");
  if ("ok" in added) throw new Error(added.error);
  const second = added.jobs[1].id;
  const both = setJobBilling(added, second, { hourlyRate: 25 });
  if ("ok" in both) throw new Error(both.error);
  const now = combineLocal("2026-09-23", "18:00");
  const blocks = [
    addManual([], {
      clockIn: combineLocal("2026-09-20", "09:00"),
      clockOut: combineLocal("2026-09-20", "11:00"),
      comment: "Last week",
      jobId: first,
    }),
  ];
  const lastWeek = blocks[0];
  assert.equal(lastWeek.ok, true);
  if (!lastWeek.ok) return;
  const monday = addManual(lastWeek.entries, {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "12:00"),
    comment: "Design",
    jobId: first,
  });
  assert.equal(monday.ok, true);
  if (!monday.ok) return;
  const unpaid = addManual(monday.entries, {
    clockIn: combineLocal("2026-09-21", "13:00"),
    clockOut: combineLocal("2026-09-21", "14:00"),
    comment: "Admin",
    jobId: first,
    billable: false,
  });
  assert.equal(unpaid.ok, true);
  if (!unpaid.ok) return;
  const workshop = addManual(unpaid.entries, {
    clockIn: combineLocal("2026-09-22", "10:00"),
    clockOut: combineLocal("2026-09-22", "12:00"),
    comment: "Build",
    jobId: second,
  });
  assert.equal(workshop.ok, true);
  if (!workshop.ok) return;
  const running = clockIn(workshop.entries, combineLocal("2026-09-23", "17:00"), second);
  assert.equal(running.ok, true);
  if (!running.ok) return;
  const week = weekAcrossJobs({ ...both, entries: running.entries }, now);
  assert.equal(week.ms, 7 * 60 * 60 * 1000);
  assert.equal(week.amount, 170);
  assert.deepEqual(
    week.jobs.map((job) => [job.name, job.ms, job.amount]),
    [
      ["Job 1", 4 * 60 * 60 * 1000, 120],
      ["Workshop", 3 * 60 * 60 * 1000, 50],
    ],
  );
});

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
