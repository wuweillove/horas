import { squareLink } from "../src/model.ts";
import {
  SQUARE_SETUP_ERROR,
  readSquareDraft,
  squareApiHost,
  squareCustomerBody,
  squareCustomerSearch,
  squareInvoiceBody,
  squareInvoiceUrl,
  squareOrderBody,
  type SquareDraft,
} from "../src/square.ts";

export const SQUARE_VERSION = "2026-08-19";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

type SquareResult = { status: number; body: unknown };

function sandboxOf(env: Env): boolean {
  return env.SQUARE_ENV === "sandbox";
}

function credentials(env: Env): { applicationId: string; applicationSecret: string } | null {
  const applicationId = env.SQUARE_APPLICATION_ID?.trim() ?? "";
  const applicationSecret = env.SQUARE_APPLICATION_SECRET?.trim() ?? "";
  if (!applicationId || !applicationSecret) return null;
  return { applicationId, applicationSecret };
}

function detail(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const errors = (body as { errors?: { detail?: unknown; code?: unknown }[] }).errors;
  const first = errors?.[0];
  if (typeof first?.detail === "string" && first.detail.trim()) return first.detail;
  if (typeof first?.code === "string" && first.code.trim()) return first.code;
  return fallback;
}

function failure(status: number, body: unknown, fallback: string): SquareResult {
  if (status === 401) return { status: 401, body: { error: "Square needs to be connected again." } };
  const code = status >= 400 && status < 500 ? status : 502;
  return { status: code, body: { error: detail(body, fallback) } };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function callSquare(
  fetchImpl: FetchLike,
  host: string,
  token: string,
  path: string,
  body?: unknown,
  method?: "GET" | "POST",
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(`${host}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": SQUARE_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 502, body: { error: "Square didn't answer." } };
  }
  return { ok: response.ok, status: response.status, body: await readJson(response) };
}

function tokenPayload(body: unknown, businessName: string): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as { access_token?: unknown; refresh_token?: unknown; merchant_id?: unknown; expires_at?: unknown };
  if (typeof raw.access_token !== "string" || typeof raw.refresh_token !== "string" || typeof raw.merchant_id !== "string") return null;
  const expiresAt = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : Number.NaN;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    merchantId: raw.merchant_id,
    businessName,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 29 * 24 * 60 * 60 * 1000,
  };
}

async function businessName(fetchImpl: FetchLike, host: string, token: string, merchantId: string): Promise<string> {
  const result = await callSquare(fetchImpl, host, token, `/v2/merchants/${encodeURIComponent(merchantId)}`);
  const merchant = result.ok && result.body && typeof result.body === "object" ? (result.body as { merchant?: { business_name?: unknown } }).merchant : null;
  return merchant && typeof merchant.business_name === "string" && merchant.business_name.trim() ? merchant.business_name.trim() : "Square";
}

async function obtainToken(
  fetchImpl: FetchLike,
  host: string,
  applicationId: string,
  applicationSecret: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(`${host}/oauth2/token`, {
      method: "POST",
      headers: { "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: applicationId, client_secret: applicationSecret, ...fields }),
    });
  } catch {
    return { ok: false, status: 502, body: null };
  }
  return { ok: response.ok, status: response.status, body: await readJson(response) };
}

function redirectAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

async function connectToken(
  fetchImpl: FetchLike,
  env: Env,
  fields: Record<string, string>,
): Promise<SquareResult> {
  const creds = credentials(env);
  if (!creds) return { status: 503, body: { error: SQUARE_SETUP_ERROR } };
  const host = squareApiHost(sandboxOf(env));
  const token = await obtainToken(fetchImpl, host, creds.applicationId, creds.applicationSecret, fields);
  if (!token.ok) return failure(token.status, token.body, "Square didn't connect.");
  const merchantId = token.body && typeof token.body === "object" ? (token.body as { merchant_id?: unknown }).merchant_id : "";
  const accessToken = token.body && typeof token.body === "object" ? (token.body as { access_token?: unknown }).access_token : "";
  const name =
    typeof accessToken === "string" && typeof merchantId === "string" && merchantId
      ? await businessName(fetchImpl, host, accessToken, merchantId)
      : "Square";
  const payload = tokenPayload(token.body, name);
  if (!payload) return { status: 502, body: { error: "Square didn't return a connection." } };
  return { status: 200, body: payload };
}

function idOf(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const record = (body as Record<string, unknown>)[key];
  if (!record || typeof record !== "object") return "";
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

async function fileInvoice(fetchImpl: FetchLike, env: Env, accessToken: string, draft: SquareDraft): Promise<SquareResult> {
  const host = squareApiHost(sandboxOf(env));
  const locations = await callSquare(fetchImpl, host, accessToken, "/v2/locations");
  if (!locations.ok) return failure(locations.status, locations.body, "Square didn't answer.");
  const list = locations.body && typeof locations.body === "object" ? (locations.body as { locations?: { id?: unknown; status?: unknown }[] }).locations : [];
  const location = (list ?? []).find((item) => item.status === "ACTIVE" && typeof item.id === "string");
  if (!location || typeof location.id !== "string") return { status: 422, body: { error: "Square has no active location." } };

  let customerId = "";
  if (draft.clientEmail) {
    const found = await callSquare(fetchImpl, host, accessToken, "/v2/customers/search", squareCustomerSearch(draft.clientEmail));
    if (!found.ok) return failure(found.status, found.body, "Square didn't find the customer.");
    const customers = found.body && typeof found.body === "object" ? (found.body as { customers?: { id?: unknown }[] }).customers : [];
    if (customers && typeof customers[0]?.id === "string") customerId = customers[0].id;
  }
  if (!customerId) {
    const created = await callSquare(fetchImpl, host, accessToken, "/v2/customers", squareCustomerBody(draft));
    if (!created.ok) return failure(created.status, created.body, "Square didn't save the customer.");
    customerId = idOf(created.body, "customer");
  }
  if (!customerId) return { status: 502, body: { error: "Square didn't save the customer." } };

  const order = await callSquare(fetchImpl, host, accessToken, "/v2/orders", squareOrderBody(draft, location.id, customerId));
  if (!order.ok) return failure(order.status, order.body, "Square didn't save the hours.");
  const orderId = idOf(order.body, "order");
  if (!orderId) return { status: 502, body: { error: "Square didn't save the hours." } };

  const invoice = await callSquare(fetchImpl, host, accessToken, "/v2/invoices", squareInvoiceBody(draft, location.id, customerId, orderId));
  if (!invoice.ok) return failure(invoice.status, invoice.body, "Square didn't file the invoice.");
  const invoiceId = idOf(invoice.body, "invoice");
  if (!invoiceId) return { status: 502, body: { error: "Square didn't file the invoice." } };
  const publicUrl = invoice.body && typeof invoice.body === "object" ? (invoice.body as { invoice?: { public_url?: unknown } }).invoice?.public_url : "";
  const fallback = squareInvoiceUrl(invoiceId, sandboxOf(env));
  const accepted = typeof publicUrl === "string" ? squareLink({ invoiceId, orderId, url: publicUrl }) : undefined;
  return { status: 200, body: { invoiceId, orderId, url: accepted?.url ?? fallback } };
}

export async function squareRequest(input: {
  method: string;
  rawBody: Uint8Array | null;
  env: Env;
  fetch: FetchLike;
}): Promise<SquareResult> {
  const method = input.method.toUpperCase();
  if (method === "GET") {
    const creds = credentials(input.env);
    if (!creds) return { status: 503, body: { error: SQUARE_SETUP_ERROR } };
    return { status: 200, body: { clientId: creds.applicationId, sandbox: sandboxOf(input.env) } };
  }
  if (method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
  if (input.rawBody && input.rawBody.byteLength > 100_000) return { status: 413, body: { error: "That invoice is too large to file." } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(input.rawBody ?? new Uint8Array()));
  } catch {
    return { status: 400, body: { error: "Square didn't understand that request." } };
  }
  if (!parsed || typeof parsed !== "object") return { status: 400, body: { error: "Square didn't understand that request." } };
  const body = parsed as { op?: unknown; code?: unknown; redirectUri?: unknown; refreshToken?: unknown; accessToken?: unknown; draft?: unknown };
  if (body.op === "token") {
    if (typeof body.code !== "string" || typeof body.redirectUri !== "string" || !redirectAllowed(body.redirectUri)) {
      return { status: 400, body: { error: "Square didn't return a connection." } };
    }
    return connectToken(input.fetch, input.env, { grant_type: "authorization_code", code: body.code, redirect_uri: body.redirectUri });
  }
  if (body.op === "refresh") {
    if (typeof body.refreshToken !== "string" || !body.refreshToken) return { status: 400, body: { error: "Square needs to be connected again." } };
    return connectToken(input.fetch, input.env, { grant_type: "refresh_token", refresh_token: body.refreshToken });
  }
  if (body.op === "revoke") {
    const creds = credentials(input.env);
    if (!creds) return { status: 503, body: { error: SQUARE_SETUP_ERROR } };
    if (typeof body.accessToken !== "string" || !body.accessToken) return { status: 400, body: { error: "Square needs to be connected again." } };
    const host = squareApiHost(sandboxOf(input.env));
    try {
      await input.fetch(`${host}/oauth2/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Client ${creds.applicationSecret}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: creds.applicationId, access_token: body.accessToken }),
      });
    } catch {
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { ok: true } };
  }
  if (body.op === "invoice") {
    if (typeof body.accessToken !== "string" || !body.accessToken) return { status: 401, body: { error: "Square needs to be connected again." } };
    const draft = readSquareDraft(body.draft);
    if (!draft) return { status: 400, body: { error: "That invoice can't be filed in Square." } };
    return fileInvoice(input.fetch, input.env, body.accessToken, draft);
  }
  return { status: 400, body: { error: "Square didn't understand that request." } };
}
