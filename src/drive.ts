import { GOOGLE_CLIENT_ID, loadGis, loadGoogleAccount } from "./google.ts";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "horas-desk.json";
const TOKEN_KEY = "horas.driveToken";
const SCOPE_BLOCK_KEY = "horas.driveScope";
const MAX_BYTES = 1_500_000;
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export type DriveBlob = { iv: string; ct: string };
export type DriveRecord = {
  v: 1;
  desk: string;
  key: string;
  rev: number;
  blob: DriveBlob;
  etag?: string;
  fileId?: string;
};

type SavedToken = { accessToken: string; expiresAt: number };
type DriveFile = { id: string; etag: string };
type TokenResult = true | "scope" | false;

let silentFailed = false;
let pending: Promise<boolean> | null = null;
let pendingInteractive = false;

export function loadDriveToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedToken>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (parsed.expiresAt < Date.now() + 60_000) return null;
    return parsed.accessToken;
  } catch {
    return null;
  }
}

function saveDriveToken(accessToken: string, expiresAt: number): void {
  try {
    const payload: SavedToken = { accessToken, expiresAt };
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(payload));
  } catch {
    /* private mode */
  }
}

export function clearDriveToken(): void {
  silentFailed = false;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

function scopeBlocked(): boolean {
  try {
    return sessionStorage.getItem(SCOPE_BLOCK_KEY) === "no";
  } catch {
    return false;
  }
}

function blockScope(): void {
  try {
    sessionStorage.setItem(SCOPE_BLOCK_KEY, "no");
  } catch {
    /* private mode */
  }
}

function clearScopeBlock(): void {
  try {
    sessionStorage.removeItem(SCOPE_BLOCK_KEY);
  } catch {
    /* private mode */
  }
}

/** True when this browser can read and write the hidden Drive file. */
export function prepareDrive(): Promise<boolean> {
  if (loadDriveToken()) return Promise.resolve(true);
  if (silentFailed || scopeBlocked()) return Promise.resolve(false);
  const account = loadGoogleAccount();
  if (!account) return Promise.resolve(false);
  return requestDriveAccess(false, account.email);
}

export function requestDriveAccess(interactive: boolean, loginHint = ""): Promise<boolean> {
  if (loadDriveToken()) return Promise.resolve(true);
  if (!interactive && (silentFailed || scopeBlocked())) return Promise.resolve(false);
  if (pending && (pendingInteractive || !interactive)) return pending;
  const run = runRequest(interactive, loginHint).finally(() => {
    if (pending === run) {
      pending = null;
      pendingInteractive = false;
    }
  });
  pending = run;
  pendingInteractive = interactive;
  return run;
}

async function runRequest(interactive: boolean, loginHint: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  await loadGis();
  const silent = await askToken("", loginHint);
  if (silent === true) {
    silentFailed = false;
    clearScopeBlock();
    return true;
  }
  if (silent === "scope") {
    blockScope();
    silentFailed = true;
    return false;
  }
  if (!interactive) {
    silentFailed = true;
    return false;
  }
  const consented = await askToken("consent", loginHint);
  if (consented === true) {
    silentFailed = false;
    clearScopeBlock();
    return true;
  }
  if (consented === "scope") blockScope();
  silentFailed = true;
  return false;
}

function askToken(prompt: string, loginHint: string): Promise<TokenResult> {
  return new Promise((resolve) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      resolve(false);
      return;
    }
    let settled = false;
    let timer = 0;
    const finish = (result: TokenResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    timer = window.setTimeout(() => finish(false), prompt === "consent" ? 20_000 : 5_000);
    try {
      const client = oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        include_granted_scopes: true,
        callback: (response) => {
          if (response.error === "invalid_scope") {
            finish("scope");
            return;
          }
          const scope = response.scope ?? "";
          const allowed = scope === "" || scope.includes("drive.appdata");
          if (!response.access_token || response.error || !allowed) {
            finish(false);
            return;
          }
          const expiresIn = typeof response.expires_in === "number" ? response.expires_in : 3600;
          saveDriveToken(response.access_token, Date.now() + expiresIn * 1000);
          finish(true);
        },
        error_callback: () => finish(false),
      });
      client.requestAccessToken(loginHint ? { prompt, login_hint: loginHint } : { prompt });
    } catch {
      finish(false);
    }
  });
}

export function parseDriveRecord(value: unknown): DriveRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.desk !== "string" || !/^[a-f0-9]{20}$/.test(row.desk)) return null;
  if (typeof row.key !== "string" || !isSyncKey(row.key)) return null;
  if (typeof row.rev !== "number" || !Number.isInteger(row.rev) || row.rev < 0) return null;
  if (!row.blob || typeof row.blob !== "object") return null;
  const sealed = row.blob as Record<string, unknown>;
  if (typeof sealed.iv !== "string" || typeof sealed.ct !== "string") return null;
  if (!/^[A-Za-z0-9_-]{8,}$/.test(sealed.iv) || !/^[A-Za-z0-9_-]{8,}$/.test(sealed.ct)) return null;
  return { v: 1, desk: row.desk, key: row.key, rev: row.rev, blob: { iv: sealed.iv, ct: sealed.ct } };
}

export async function readDriveRecord(): Promise<DriveRecord | null | "error"> {
  const found = await findDriveFile();
  if (found === "error") return "error";
  if (!found) return null;
  const response = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(found.id)}?alt=media`, { method: "GET" });
  if (!response) return "error";
  if (response.status === 404) return null;
  if (!response.ok) return "error";
  try {
    const parsed = parseDriveRecord(await response.json());
    if (!parsed) return "error";
    return { ...parsed, etag: found.etag, fileId: found.id };
  } catch {
    return "error";
  }
}

export async function writeDriveRecord(record: DriveRecord): Promise<true | "conflict" | false> {
  if (!/^[a-f0-9]{20}$/.test(record.desk) || !isSyncKey(record.key)) return false;
  const json = JSON.stringify({ v: 1, desk: record.desk, key: record.key, rev: record.rev, blob: record.blob });
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES) return false;
  let fileId = record.fileId;
  let etag = record.etag ?? "";
  if (!fileId) {
    const found = await findDriveFile();
    if (found === "error") return false;
    if (found) {
      fileId = found.id;
      etag = found.etag;
    }
  }
  if (!fileId) return (await createDriveFile(json)) ? true : false;
  return patchDriveFile(fileId, etag, json);
}

async function findDriveFile(): Promise<DriveFile | null | "error"> {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    pageSize: "1",
    orderBy: "modifiedTime desc",
    fields: "files(id,etag)",
    q: `name = '${FILE_NAME}' and trashed = false`,
  });
  const response = await driveFetch(`${DRIVE_FILES}?${params}`, { method: "GET" });
  if (!response || !response.ok) return "error";
  try {
    const body = (await response.json()) as { files?: { id?: unknown; etag?: unknown }[] };
    const file = body.files?.[0];
    if (!file || typeof file.id !== "string") return null;
    return { id: file.id, etag: typeof file.etag === "string" ? file.etag : "" };
  } catch {
    return "error";
  }
}

async function createDriveFile(json: string): Promise<boolean> {
  const boundary = "horas_desk";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] }),
    `--${boundary}`,
    "Content-Type: application/json",
    "",
    json,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,etag`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return Boolean(response?.ok);
}

async function patchDriveFile(id: string, etag: string, json: string): Promise<true | "conflict" | false> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (etag) headers["If-Match"] = etag;
  const response = await driveFetch(`${DRIVE_UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id,etag`, {
    method: "PATCH",
    headers,
    body: json,
  });
  if (!response) return false;
  if (response.status === 412 || response.status === 409 || response.status === 404) return "conflict";
  return response.ok ? true : false;
}

async function driveFetch(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  allowRefresh = true,
): Promise<Response | null> {
  let token = loadDriveToken();
  if (!token && allowRefresh) {
    const account = loadGoogleAccount();
    if (account) await requestDriveAccess(false, account.email);
    token = loadDriveToken();
  }
  if (!token) return null;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      body: init.body,
    });
  } catch {
    return null;
  }
  if (response.status === 401 && allowRefresh) {
    clearDriveToken();
    const account = loadGoogleAccount();
    if (!account || !(await requestDriveAccess(false, account.email))) return null;
    return driveFetch(url, init, false);
  }
  return response;
}

function isSyncKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
    return atob(padded).length === 32;
  } catch {
    return false;
  }
}
