import assert from "node:assert/strict";
import test from "node:test";
import { createInvoice } from "./billing.ts";
import { addClient, addManual, combineLocal, durableMerge, emptyStore, linkSquare, normalizeStore, setJobBilling, type Invoice, type Store } from "./model.ts";
import {
  dueDateFrom,
  readSquareDraft,
  squareAuthorizeUrl,
  squareDraft,
  squareIdempotency,
  squareInvoiceBody,
  squareOrderBody,
  SQUARE_SCOPES,
} from "./square.ts";

function desk(): Store {
  const base = emptyStore();
  const withClient = addClient(base, { name: "North Studio", email: "hi@north.test", address: "1 Dock St", hourlyRate: 50 });
  if ("ok" in withClient) throw new Error(withClient.error);
  const linked = setJobBilling(withClient, withClient.jobs[0].id, { clientId: withClient.clients[0].id });
  if ("ok" in linked) throw new Error(linked.error);
  return { ...linked, settings: { ...linked.settings, taxPercent: 10, currency: "USD" } };
}

function sample(): { store: Store; invoice: Invoice } {
  const start = desk();
  const added = addManual(start.entries, {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "11:30"),
    comment: "Layout",
    jobId: start.jobs[0].id,
  });
  assert.equal(added.ok, true);
  if (!added.ok) throw new Error("manual");
  const drafted = createInvoice(
    { ...start, entries: added.entries },
    start.clients[0].id,
    added.entries.map((entry) => entry.id),
    combineLocal("2026-09-22", "09:00"),
  );
  if ("ok" in drafted) throw new Error(drafted.error);
  return { store: drafted, invoice: drafted.invoices[0] };
}

test("a square draft names the hours and keeps the Horas amount", () => {
  const { invoice } = sample();
  const built = squareDraft(invoice, new Date(2026, 9, 2, 12).getTime());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.draft.lines.length, 1);
  assert.equal(built.draft.lines[0].amount, 125);
  assert.match(built.draft.lines[0].name, /2\.50 h/);
  assert.match(built.draft.lines[0].name, /\$50\.00/);
  assert.equal(built.draft.lines[0].note, "Layout");
  assert.equal(built.draft.lines[0].date, "2026-09-21");
  assert.equal(built.draft.clientEmail, "hi@north.test");
  assert.equal(built.draft.taxPercent, 10);
  assert.equal(built.draft.dueDate, "2026-10-16");
  const order = squareOrderBody(built.draft, "LOC", "CUS");
  const line = (order.order as { line_items: { base_price_money: { amount: number } }[] }).line_items[0];
  assert.equal(line.base_price_money.amount, 12500);
  const taxes = (order.order as { taxes: { percentage: string; scope: string }[] }).taxes;
  assert.equal(taxes[0].percentage, "10");
  assert.equal(taxes[0].scope, "ORDER");
  const filed = squareInvoiceBody(built.draft, "LOC", "CUS", "ORD");
  const invoiceBody = filed.invoice as { delivery_method: string; sale_or_service_date: string; payment_requests: { due_date: string }[] };
  assert.equal(invoiceBody.delivery_method, "EMAIL");
  assert.equal(invoiceBody.sale_or_service_date, "2026-09-21");
  assert.equal(invoiceBody.payment_requests[0].due_date, "2026-10-16");
});

test("the authorize url asks only for invoice permissions", () => {
  const url = new URL(squareAuthorizeUrl("sq0idp-test", "https://horas-gamma.vercel.app/", "abc", false));
  assert.equal(url.origin, "https://connect.squareup.com");
  assert.equal(url.searchParams.get("client_id"), "sq0idp-test");
  assert.equal(url.searchParams.get("scope"), SQUARE_SCOPES);
  assert.equal(url.searchParams.get("redirect_uri"), "https://horas-gamma.vercel.app/");
  assert.equal(url.searchParams.get("state"), "abc");
  assert.match(SQUARE_SCOPES, /INVOICES_WRITE/);
  assert.doesNotMatch(SQUARE_SCOPES, /PAYMENTS_WRITE/);
  const sandbox = new URL(squareAuthorizeUrl("sandbox-id", "http://localhost:5173/", "abc", true));
  assert.equal(sandbox.origin, "https://connect.squareupsandbox.com");
});

test("due date is fourteen local days out", () => {
  assert.equal(dueDateFrom(new Date(2026, 9, 2, 12).getTime()), "2026-10-16");
  assert.equal(squareIdempotency("o", "abc-def"), "oabcdef");
});

test("a square link survives a reload and a later desk that dropped it", () => {
  const { store, invoice } = sample();
  const linked = linkSquare(store, invoice.id, {
    invoiceId: "inv_1",
    orderId: "ord_1",
    url: "https://app.squareup.com/dashboard/invoices/inv_1",
  });
  if ("ok" in linked) throw new Error(linked.error);
  const again = normalizeStore(JSON.parse(JSON.stringify(linked)));
  assert.equal(again?.invoices[0].square?.invoiceId, "inv_1");

  const dirty = structuredClone(linked);
  dirty.invoices[0].square = { invoiceId: "inv_1", orderId: "ord_1", url: "https://evil.example/invoice" };
  assert.equal(normalizeStore(dirty)?.invoices[0].square, undefined);

  const older = { ...linked, savedAt: 10 };
  const dropped = {
    ...older,
    savedAt: 20,
    invoices: older.invoices.map((item) => {
      const { square: _square, ...rest } = item;
      return rest;
    }),
  };
  const merged = durableMerge(older, dropped);
  assert.equal(merged.invoices[0].square?.orderId, "ord_1");
  assert.equal(merged.invoices[0].status, older.invoices[0].status);
});

test("a draft with no amount is refused", () => {
  const { invoice } = sample();
  const empty = { ...invoice, lines: invoice.lines.map((line) => ({ ...line, amount: 0 })) };
  const built = squareDraft(empty);
  assert.equal(built.ok, false);
  assert.equal(readSquareDraft({ ...("ok" in built ? {} : {}), lines: [] }), null);
});
