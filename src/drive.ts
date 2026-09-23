import { normalizeStore, type Store } from "./model.ts";
import { setRemoteSink } from "./persist.ts";

const SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Horas";
const FILE_NAME = "horas.json";

type TokenResponse = { access_token?: string; error?: string };

declare global {
  interface Window {
    HORAS_GOOGLE_CLIENT_ID?: string;
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }) => { requestAccessToken: (override?: { prompt?: string }) => void };
          revoke: (token: string, done: () => void) => void;
        };
      };
    };
  }
}

let token = "";
let folderId = "";
let fileId = "";

export function googleClientId(): string {
  return (window.HORAS_GOOGLE_CLIENT_ID ?? "").trim();
}

export function driveConnected(): boolean {
  return token.length > 0;
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-horas-gis]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("gis")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.dataset.horasGis = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("gis"));
    document.head.appendChild(script);
  });
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`https://www.googleapis.com${path}`, { ...init, headers });
  if (response.status === 401) {
    token = "";
    setRemoteSink(null);
  }
  return response;
}

async function findId(query: string): Promise<string> {
  const params = new URLSearchParams({
    q: query,
    spaces: "drive",
    fields: "files(id,name)",
    pageSize: "10",
  });
  const response = await api(`/drive/v3/files?${params}`);
  if (!response.ok) throw new Error("drive-list");
  const payload = (await response.json()) as { files?: { id?: string }[] };
  return payload.files?.find((file) => file.id)?.id ?? "";
}

async function ensurePlace(): Promise<void> {
  if (!folderId) {
    folderId = await findId(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  }
  if (!folderId) {
    const response = await api("/drive/v3/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    if (!response.ok) throw new Error("drive-folder");
    const created = (await response.json()) as { id?: string };
    folderId = created.id ?? "";
  }
  if (!folderId) throw new Error("drive-folder");
  if (!fileId) {
    fileId = await findId(`name = '${FILE_NAME}' and trashed = false`);
  }
}

async function readEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return "";
  const payload = (await response.json()) as { email?: string };
  return payload.email ?? "";
}

export async function signInWithGoogle(): Promise<string> {
  const clientId = googleClientId();
  if (!clientId) throw new Error("missing-client");
  await loadGis();
  const gis = window.google?.accounts.oauth2;
  if (!gis) throw new Error("gis");
  const accessToken = await new Promise<string>((resolve, reject) => {
    const client = gis.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (response) => {
        if (!response.access_token) {
          reject(new Error(response.error || "denied"));
          return;
        }
        resolve(response.access_token);
      },
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
  token = accessToken;
  const email = await readEmail(accessToken);
  await ensurePlace();
  setRemoteSink({
    read: readDriveStore,
    write: writeDriveStore,
  });
  return email;
}

export function signOutGoogle(): void {
  const current = token;
  token = "";
  folderId = "";
  fileId = "";
  setRemoteSink(null);
  if (current) window.google?.accounts.oauth2.revoke(current, () => undefined);
}

export async function readDriveStore(): Promise<Store | null> {
  if (!token) return null;
  await ensurePlace();
  if (!fileId) return null;
  const response = await api(`/drive/v3/files/${fileId}?alt=media`);
  if (response.status === 404) {
    fileId = "";
    return null;
  }
  if (!response.ok) throw new Error("drive-read");
  return normalizeStore(await response.json());
}

export async function writeDriveStore(store: Store): Promise<boolean> {
  if (!token) return false;
  await ensurePlace();
  const body = JSON.stringify(store);
  if (!fileId) {
    const boundary = `horas-${crypto.randomUUID()}`;
    const payload = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({ name: FILE_NAME, parents: [folderId] }),
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      body,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const response = await api("/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: payload,
      keepalive: true,
    });
    if (!response.ok) return false;
    const created = (await response.json()) as { id?: string };
    fileId = created.id ?? fileId;
    return true;
  }
  const response = await api(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  });
  return response.ok;
}

export async function savePdfToDrive(name: string, bytes: Uint8Array): Promise<void> {
  if (!token) throw new Error("drive-off");
  await ensurePlace();
  const safe = name.replace(/[^\w.-]+/g, "-");
  const existing = await findId(`name = '${safe}' and trashed = false`);
  const boundary = `horas-${crypto.randomUUID()}`;
  const header =
    [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(existing ? { name: safe } : { name: safe, parents: [folderId] }),
      `--${boundary}`,
      "Content-Type: application/pdf",
      "",
    ].join("\r\n") + "\r\n";
  const footer = `\r\n--${boundary}--\r\n`;
  const payload = new Blob([
    header,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    footer,
  ]);
  const path = existing
    ? `/upload/drive/v3/files/${existing}?uploadType=multipart`
    : "/upload/drive/v3/files?uploadType=multipart";
  const response = await api(path, {
    method: existing ? "PATCH" : "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: payload,
  });
  if (!response.ok) throw new Error("drive-pdf");
}
