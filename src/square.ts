import { formatMoney, roundMoney } from "./billing.ts";
import type { Invoice, InvoiceLine, SquareLink } from "./model.ts";

export const SQUARE_SETUP_ERROR = "Square is not set up on this site yet.";
export const SQUARE_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "INVOICES_READ",
  "INVOICES_WRITE",
].join(" ");

const ACCOUNT_KEY = "horas.square";
const STATE_KEY = "horas.squareState";
const REDIRECT_KEY = "horas.squareRedirect";
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND"]);

export type SquareAccount = {
  merchantId: string;
  businessName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type SquareLine = {
  name: string;
  note: string;
  amount: number;
  date: string;
};

export type SquareDraft = {
  idempotencyKey: string;
  clientKey: string;
  clientName: string;
  clientEmail: string;
  clientAddress: string;
  number: string;
  currency: string;
  taxPercent: number;
  dueDate: string;
  notes: string;
  lines: SquareLine[];
};

export type SquareFinish = { ok: true; connected: boolean } | { ok: false; error: string };

type TokenResponse = {
  accessToken: string;
  refreshToken: string;
  merchantId: string;
  businessName: string;
  expiresAt: number;
};

let consumed = false;
let consumedRedirect: { code: string; state: string } | { error: string } | null | undefined;
let finishing: Promise<SquareFinish> | null = null;

export function minorUnits(amount: number, currency: string): number {
  const factor = ZERO_DECIMAL.has(currency) ? 1 : 100;
  return Math.round(roundMoney(amount) * factor);
}

export function taxPercentage(percent: number): string {
  return String(Math.round(percent * 100) / 100);
}

export function dueDateFrom(issuedAt: number, days = 14): string {
  const date = new Date(issuedAt);
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function squareIdempotency(prefix: string, raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  return `${prefix}${clean || "horas"}`.slice(0, 45);
}

export function squareApiHost(sandbox: boolean): string {
  return sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

export function squareInvoiceUrl(invoiceId: string, sandbox: boolean): string {
  const host = sandbox ? "https://app.squareupsandbox.com" : "https://app.squareup.com";
  return `${host}/dashboard/invoices/${encodeURIComponent(invoiceId)}`;
}

export function squareRedirectUri(href: string): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function squareAuthorizeUrl(clientId: string, redirectUri: string, state: string, sandbox: boolean): string {
  const url = new URL("/oauth2/authorize", squareApiHost(sandbox));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SQUARE_SCOPES);
  url.searchParams.set("session", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

function lineName(line: InvoiceLine, currency: string): string {
  const parts = [line.date, line.job, `${line.hours.toFixed(2)} h × ${formatMoney(line.rate, currency)}`].filter((part) => part.trim() !== "");
  return parts.join(" · ").slice(0, 400);
}

export function squareDraft(invoice: Invoice, now = Date.now()): { ok: true; draft: SquareDraft } | { ok: false; error: string } {
  const currency = /^[A-Za-z]{3}$/.test(invoice.currency) ? invoice.currency.toUpperCase() : "USD";
  const lines = invoice.lines
    .filter((line) => roundMoney(line.amount) > 0)
    .map((line) => ({
      name: lineName(line, currency),
      note: line.comment.trim().slice(0, 500),
      amount: roundMoney(line.amount),
      date: /^\d{4}-\d{2}-\d{2}$/.test(line.date) ? line.date : "",
    }));
  if (lines.length === 0) return { ok: false, error: "This invoice has no amount to send." };
  const taxPercent = Number.isFinite(invoice.taxPercent) ? Math.min(100, Math.max(0, invoice.taxPercent)) : 0;
  return {
    ok: true,
    draft: {
      idempotencyKey: invoice.id,
      clientKey: invoice.clientId,
      clientName: invoice.clientName.trim().slice(0, 100) || "Client",
      clientEmail: invoice.clientEmail.trim().slice(0, 120),
      clientAddress: invoice.clientAddress.trim().slice(0, 240),
      number: invoice.number.trim().slice(0, 20) || "H-0001",
      currency,
      taxPercent: Math.round(taxPercent * 100) / 100,
      dueDate: dueDateFrom(Math.max(now, invoice.issuedAt)),
      notes: invoice.notes.trim().slice(0, 500),
      lines,
    },
  };
}

export function readSquareDraft(value: unknown): SquareDraft | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SquareDraft>;
  if (typeof raw.idempotencyKey !== "string" || typeof raw.clientKey !== "string") return null;
  if (typeof raw.clientName !== "string" || typeof raw.number !== "string") return null;
  if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) return null;
  if (typeof raw.taxPercent !== "number" || raw.taxPercent < 0 || raw.taxPercent > 100) return null;
  if (typeof raw.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate)) return null;
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 100) return null;
  const lines: SquareLine[] = [];
  for (const item of raw.lines) {
    if (!item || typeof item !== "object") return null;
    const line = item as Partial<SquareLine>;
    if (typeof line.name !== "string" || typeof line.amount !== "number") return null;
    const amount = roundMoney(line.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null;
    const name = line.name.trim().slice(0, 400);
    if (!name) return null;
    lines.push({
      name,
      note: typeof line.note === "string" ? line.note.trim().slice(0, 500) : "",
      amount,
      date: typeof line.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(line.date) ? line.date : "",
    });
  }
  const email = typeof raw.clientEmail === "string" ? raw.clientEmail.trim().slice(0, 120) : "";
  if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  return {
    idempotencyKey: raw.idempotencyKey.trim().slice(0, 80),
    clientKey: raw.clientKey.trim().slice(0, 80),
    clientName: raw.clientName.trim().slice(0, 100) || "Client",
    clientEmail: email,
    clientAddress: typeof raw.clientAddress === "string" ? raw.clientAddress.trim().slice(0, 240) : "",
    number: raw.number.trim().slice(0, 20) || "H-0001",
    currency: raw.currency,
    taxPercent: Math.round(raw.taxPercent * 100) / 100,
    dueDate: raw.dueDate,
    notes: typeof raw.notes === "string" ? raw.notes.trim().slice(0, 500) : "",
    lines,
  };
}

export function squareCustomerBody(draft: SquareDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    idempotency_key: squareIdempotency("c", `${draft.clientKey}:${draft.clientEmail}`),
    company_name: draft.clientName,
  };
  if (draft.clientEmail) body.email_address = draft.clientEmail;
  if (draft.clientAddress) body.note = draft.clientAddress;
  return body;
}

export function squareCustomerSearch(email: string): Record<string, unknown> {
  return { query: { filter: { email_address: { exact: email } } }, limit: 1 };
}

export function squareOrderBody(draft: SquareDraft, locationId: string, customerId: string): Record<string, unknown> {
  const order: Record<string, unknown> = {
    location_id: locationId,
    customer_id: customerId,
    reference_id: draft.number.slice(0, 40),
    line_items: draft.lines.map((line, index) => {
      const item: Record<string, unknown> = {
        uid: `h${index}`,
        name: line.name,
        quantity: "1",
        base_price_money: { amount: minorUnits(line.amount, draft.currency), currency: draft.currency },
      };
      if (line.note) item.note = line.note;
      return item;
    }),
    pricing_options: { auto_apply_discounts: false, auto_apply_taxes: false },
  };
  if (draft.taxPercent > 0) {
    order.taxes = [
      {
        uid: "horas-tax",
        name: "Tax",
        percentage: taxPercentage(draft.taxPercent),
        scope: "ORDER",
        type: "ADDITIVE",
      },
    ];
  }
  return { idempotency_key: squareIdempotency("o", draft.idempotencyKey), order };
}

export function squareInvoiceBody(
  draft: SquareDraft,
  locationId: string,
  customerId: string,
  orderId: string,
): Record<string, unknown> {
  const dates = draft.lines.map((line) => line.date).filter((date) => date !== "").sort();
  const invoice: Record<string, unknown> = {
    location_id: locationId,
    order_id: orderId,
    primary_recipient: { customer_id: customerId },
    delivery_method: draft.clientEmail ? "EMAIL" : "SHARE_MANUALLY",
    payment_requests: [
      {
        request_type: "BALANCE",
        due_date: draft.dueDate,
        automatic_payment_source: "NONE",
      },
    ],
    invoice_number: draft.number,
    title: `Hours ${draft.number}`.slice(0, 255),
    description: draft.notes || "Hours tracked in Horas.",
    accepted_payment_methods: {
      card: true,
      square_gift_card: false,
      bank_account: false,
      buy_now_pay_later: false,
      cash_app_pay: false,
    },
  };
  const serviceDate = dates[dates.length - 1];
  if (serviceDate) invoice.sale_or_service_date = serviceDate;
  return { idempotency_key: squareIdempotency("i", draft.idempotencyKey), invoice };
}

function notifySquare(): void {
  try {
    window.dispatchEvent(new Event("horas-square"));
  } catch {
    /* the page is going away */
  }
}

export function loadSquareAccount(): SquareAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SquareAccount>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    if (typeof parsed.merchantId !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.merchantId) return null;
    return {
      merchantId: parsed.merchantId,
      businessName: typeof parsed.businessName === "string" && parsed.businessName.trim() ? parsed.businessName : "Square",
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function saveSquareAccount(account: SquareAccount): boolean {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    notifySquare();
    return true;
  } catch {
    return false;
  }
}

export function clearSquareAccount(): void {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* private mode */
  }
  notifySquare();
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function squareEndpoint(): string {
  return new URL("/api/square", window.location.origin).toString();
}

async function postSquare(body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(squareEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    return { status: response.status, body: payload };
  } catch {
    return { status: 502, body: { error: "Square didn't answer." } };
  }
}

function errorOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return fallback;
}

function readToken(body: unknown): TokenResponse | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Partial<TokenResponse>;
  if (typeof raw.accessToken !== "string" || typeof raw.refreshToken !== "string" || typeof raw.merchantId !== "string") return null;
  if (typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) return null;
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    merchantId: raw.merchantId,
    businessName: typeof raw.businessName === "string" && raw.businessName.trim() ? raw.businessName : "Square",
    expiresAt: raw.expiresAt,
  };
}

export function squareRedirectPending(href = typeof window === "undefined" ? "" : window.location.href): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.searchParams.has("code") && url.searchParams.has("state");
  } catch {
    return false;
  }
}

function consumeSquareRedirect(): { code: string; state: string } | { error: string } | null {
  if (consumed) return consumedRedirect ?? null;
  consumed = true;
  if (typeof window === "undefined") {
    consumedRedirect = null;
    return null;
  }
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  let storedState: string | null = null;
  try {
    storedState = sessionStorage.getItem(STATE_KEY);
  } catch {
    storedState = null;
  }
  const pending = (code && state) || (error && storedState);
  if (!pending) {
    consumedRedirect = null;
    return null;
  }
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  if (error || !code || !state) {
    consumedRedirect = {
      error: error === "access_denied" ? "Square connection was cancelled." : "Square connection was interrupted. Try again.",
    };
    return consumedRedirect;
  }
  consumedRedirect = { code, state };
  return consumedRedirect;
}

export async function beginSquareConnect(): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(squareEndpoint());
  } catch {
    return { ok: false, error: "Square didn't answer." };
  }
  const payload = (await response.json().catch(() => null)) as { clientId?: unknown; sandbox?: unknown; error?: unknown } | null;
  if (!response.ok || !payload || typeof payload.clientId !== "string") {
    return { ok: false, error: errorOf(payload, SQUARE_SETUP_ERROR) };
  }
  let state = "";
  const redirectUri = squareRedirectUri(window.location.href);
  try {
    state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(REDIRECT_KEY, redirectUri);
  } catch {
    return { ok: false, error: "This browser can't keep the Square connection." };
  }
  window.location.assign(squareAuthorizeUrl(payload.clientId, redirectUri, state, payload.sandbox === true));
  return { ok: true };
}

export function finishSquareConnect(): Promise<SquareFinish> {
  if (!finishing) finishing = runFinish();
  return finishing;
}

async function runFinish(): Promise<SquareFinish> {
  const redirected = consumeSquareRedirect();
  if (!redirected) return { ok: true, connected: false };
  if ("error" in redirected) return { ok: false, error: redirected.error };
  let expected: string | null = null;
  let redirectUri = squareRedirectUri(window.location.href);
  try {
    expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    redirectUri = sessionStorage.getItem(REDIRECT_KEY) || redirectUri;
    sessionStorage.removeItem(REDIRECT_KEY);
  } catch {
    return { ok: false, error: "Square connection was interrupted. Try again." };
  }
  if (!expected || expected !== redirected.state) return { ok: false, error: "Square connection was interrupted. Try again." };
  const result = await postSquare({ op: "token", code: redirected.code, redirectUri });
  const token = readToken(result.body);
  if (result.status !== 200 || !token) return { ok: false, error: errorOf(result.body, "Square didn't connect.") };
  if (!saveSquareAccount(token)) return { ok: false, error: "This browser can't keep the Square connection." };
  return { ok: true, connected: true };
}

async function refreshAccount(account: SquareAccount): Promise<{ ok: true; account: SquareAccount } | { ok: false; error: string }> {
  const result = await postSquare({ op: "refresh", refreshToken: account.refreshToken });
  const token = readToken(result.body);
  if (result.status !== 200 || !token) return { ok: false, error: errorOf(result.body, "Square needs to be connected again.") };
  const next = { ...token, refreshToken: token.refreshToken || account.refreshToken };
  if (!saveSquareAccount(next)) return { ok: false, error: "This browser can't keep the Square connection." };
  return { ok: true, account: next };
}

export async function disconnectSquare(): Promise<void> {
  const account = loadSquareAccount();
  clearSquareAccount();
  if (!account) return;
  await postSquare({ op: "revoke", accessToken: account.accessToken });
}

export async function sendInvoiceToSquare(
  invoice: Invoice,
): Promise<{ ok: true; square: SquareLink } | { ok: false; error: string; disconnected?: boolean }> {
  if (invoice.square) return { ok: true, square: invoice.square };
  let account = loadSquareAccount();
  if (!account) return { ok: false, error: "Connect Square first." };
  const built = squareDraft(invoice);
  if (!built.ok) return built;
  if (account.expiresAt <= Date.now() + 60_000) {
    const refreshed = await refreshAccount(account);
    if (!refreshed.ok) {
      clearSquareAccount();
      return { ok: false, error: refreshed.error, disconnected: true };
    }
    account = refreshed.account;
  }
  const file = (token: string) => postSquare({ op: "invoice", accessToken: token, draft: built.draft });
  let result = await file(account.accessToken);
  if (result.status === 401) {
    const refreshed = await refreshAccount(account);
    if (!refreshed.ok) {
      clearSquareAccount();
      return { ok: false, error: refreshed.error, disconnected: true };
    }
    result = await file(refreshed.account.accessToken);
  }
  if (result.status === 401) {
    clearSquareAccount();
    return { ok: false, error: "Square needs to be connected again.", disconnected: true };
  }
  const body = result.body as { invoiceId?: unknown; orderId?: unknown; url?: unknown; error?: unknown } | null;
  if (result.status !== 200 || !body) return { ok: false, error: errorOf(result.body, "Square didn't file the invoice.") };
  const square: SquareLink = {
    invoiceId: typeof body.invoiceId === "string" ? body.invoiceId : "",
    orderId: typeof body.orderId === "string" ? body.orderId : "",
    url: typeof body.url === "string" ? body.url : "",
  };
  if (!square.invoiceId || !square.orderId || !square.url) return { ok: false, error: errorOf(result.body, "Square didn't file the invoice.") };
  return { ok: true, square };
}
