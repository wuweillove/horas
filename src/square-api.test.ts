import assert from "node:assert/strict";
import test from "node:test";
import { squareRequest } from "../api/square-server.ts";
import { createInvoice } from "./billing.ts";
import { addClient, addManual, combineLocal, emptyStore, setJobBilling, type Invoice, type Store } from "./model.ts";
import { readSquareDraft, squareCustomerBody, squareDraft, squareInvoiceBody, squareOrderBody } from "./square.ts";

const env = {
  SQUARE_APPLICATION_ID: "sq0idp-test",
  SQUARE_APPLICATION_SECRET: "sq0csp-secret",
};

function desk(): Store {
  const base = emptyStore();
  const withClient = addClient(base, { name: "North Studio", email: "hi@north.test", hourlyRate: 50 });
  if ("ok" in withClient) throw new Error(withClient.error);
  const linked = setJobBilling(withClient, withClient.jobs[0].id, { clientId: withClient.clients[0].id });
  if ("ok" in linked) throw new Error(linked.error);
  return { ...linked, settings: { ...linked.settings, taxPercent: 10, currency: "USD" } };
}

function sampleInvoice(): Invoice {
  const start = desk();
  const added = addManual(start.entries, {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "11:00"),
    comment: "Layout",
    jobId: start.jobs[0].id,
  });
  if (!added.ok) throw new Error("manual");
  const drafted = createInvoice({ ...start, entries: added.entries }, start.clients[0].id, [added.entries[0].id]);
  if ("ok" in drafted) throw new Error(drafted.error);
  return drafted.invoices[0];
}

function post(body: unknown, fetchImpl: typeof fetch, serverEnv: Record<string, string | undefined> = env) {
  return squareRequest({
    method: "POST",
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    env: serverEnv,
    fetch: fetchImpl,
  });
}

test("square setup stays on the server", async () => {
  const missing = await squareRequest({ method: "GET", rawBody: null, env: {}, fetch });
  assert.equal(missing.status, 503);
  const ready = await squareRequest({ method: "GET", rawBody: null, env, fetch });
  assert.equal(ready.status, 200);
  assert.equal((ready.body as { clientId: string }).clientId, "sq0idp-test");
  assert.equal(JSON.stringify(ready.body).includes("sq0csp-secret"), false);
});

test("a token exchange uses the secret and returns the seller name", async () => {
  const calls: { url: string; body: unknown; auth: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: String(new Headers(init?.headers).get("authorization") ?? "") });
    if (url.endsWith("/oauth2/token")) {
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        merchant_id: "MERCHANT",
        expires_at: "2026-11-01T00:00:00Z",
      });
    }
    if (url.endsWith("/v2/merchants/MERCHANT")) return Response.json({ merchant: { business_name: "North Desk" } });
    return Response.json({ errors: [{ detail: "missing" }] }, { status: 404 });
  };
  const result = await post({ op: "token", code: "sq0cgb-code", redirectUri: "https://horas-gamma.vercel.app/" }, fetchImpl);
  assert.equal(result.status, 200);
  const body = result.body as { businessName: string; accessToken: string; merchantId: string };
  assert.equal(body.businessName, "North Desk");
  assert.equal(body.accessToken, "access");
  assert.equal(body.merchantId, "MERCHANT");
  assert.equal(JSON.stringify(result.body).includes("sq0csp-secret"), false);
  assert.equal(calls[0].body.client_secret, "sq0csp-secret");
  assert.equal(calls[0].body.grant_type, "authorization_code");
  assert.equal(calls[0].body.redirect_uri, "https://horas-gamma.vercel.app/");
});

test("filing an invoice creates the customer, the hours, and a draft", async () => {
  const built = squareDraft(sampleInvoice());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/v2/locations")) return Response.json({ locations: [{ id: "LOC", status: "INACTIVE" }, { id: "MAIN", status: "ACTIVE" }] });
    if (url.endsWith("/v2/customers/search")) return Response.json({ customers: [] });
    if (url.endsWith("/v2/customers")) return Response.json({ customer: { id: "CUS" } });
    if (url.endsWith("/v2/orders")) return Response.json({ order: { id: "ORD" } });
    if (url.endsWith("/v2/invoices")) return Response.json({ invoice: { id: "INV", public_url: "https://evil.example/pay" } });
    return Response.json({ errors: [{ detail: "missing" }] }, { status: 404 });
  };
  const filed = await post({ op: "invoice", accessToken: "access", draft: built.draft }, fetchImpl);
  assert.equal(filed.status, 200);
  const body = filed.body as { invoiceId: string; orderId: string; url: string };
  assert.equal(body.invoiceId, "INV");
  assert.equal(body.orderId, "ORD");
  assert.equal(body.url, "https://app.squareup.com/dashboard/invoices/INV");
  const draft = readSquareDraft(built.draft);
  assert.ok(draft);
  assert.deepEqual(calls.map((call) => call.url.split("/v2/")[1]), ["locations", "customers/search", "customers", "orders", "invoices"]);
  assert.deepEqual(calls[2].body, squareCustomerBody(draft!));
  assert.deepEqual(calls[3].body, squareOrderBody(draft!, "MAIN", "CUS"));
  assert.deepEqual(calls[4].body, squareInvoiceBody(draft!, "MAIN", "CUS", "ORD"));
  assert.equal(JSON.stringify(calls).includes("sq0csp-secret"), false);
});

test("an existing customer is reused", async () => {
  const start = desk();
  const added = addManual(start.entries, {
    clockIn: combineLocal("2026-09-21", "09:00"),
    clockOut: combineLocal("2026-09-21", "10:00"),
    comment: "",
    jobId: start.jobs[0].id,
  });
  if (!added.ok) throw new Error("manual");
  const drafted = createInvoice({ ...start, entries: added.entries }, start.clients[0].id, [added.entries[0].id]);
  if ("ok" in drafted) throw new Error(drafted.error);
  const built = squareDraft(drafted.invoices[0]);
  if (!built.ok) throw new Error(built.error);
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/v2/locations")) return Response.json({ locations: [{ id: "MAIN", status: "ACTIVE" }] });
    if (url.endsWith("/v2/customers/search")) return Response.json({ customers: [{ id: "FOUND" }] });
    if (url.endsWith("/v2/orders")) return Response.json({ order: { id: "ORD" } });
    if (url.endsWith("/v2/invoices")) return Response.json({ invoice: { id: "INV" } });
    return Response.json({ errors: [{ detail: "unexpected create" }] }, { status: 500 });
  };
  const filed = await post({ op: "invoice", accessToken: "access", draft: built.draft }, fetchImpl);
  assert.equal(filed.status, 200);
  assert.equal(urls.some((url) => url.endsWith("/v2/customers")), false);
});

test("square's refusal is the message the desk shows", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/v2/locations")) return Response.json({ errors: [{ detail: "This location is not allowed." }] }, { status: 403 });
    return Response.json({}, { status: 500 });
  };
  const built = readSquareDraft({
    idempotencyKey: "inv",
    clientKey: "client",
    clientName: "North",
    clientEmail: "",
    number: "H-0001",
    currency: "USD",
    taxPercent: 0,
    dueDate: "2026-10-16",
    lines: [{ name: "Hours", note: "", amount: 40, date: "2026-09-21" }],
  });
  assert.ok(built);
  const denied = await post({ op: "invoice", accessToken: "expired", draft: built }, fetchImpl);
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "This location is not allowed.");
  const unauth = await post(
    { op: "invoice", accessToken: "expired", draft: built },
    async () => Response.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 }),
  );
  assert.equal(unauth.status, 401);
  assert.equal((unauth.body as { error: string }).error, "Square needs to be connected again.");
});
