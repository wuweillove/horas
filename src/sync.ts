import { durableMerge, normalizeStore, normalizeVaultId, stampStore, type Store } from "./model.ts";

const KEY_STORAGE = "horas.syncKey";
export const SYNC_URL = "https://pepitoloco.zo.space/api/horas-sync";

type Sealed = { iv: string; ct: string };

export function syncUrl(): string {
  const custom = (window as Window & { HORAS_SYNC_URL?: string }).HORAS_SYNC_URL;
  return (custom || SYNC_URL).replace(/\/$/, "");
}

export function loadSyncKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function saveSyncKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearSyncKey(): void {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode */
  }
}

export function newSyncKey(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}

export function makeSyncLink(href: string, desk: string, key: string): string {
  const url = new URL(href);
  url.searchParams.set("desk", desk);
  url.hash = `k=${key}`;
  return url.toString();
}

export function readSyncLink(text: string): { desk: string; key: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const desk = normalizeVaultId(url.searchParams.get("desk") ?? url.searchParams.get("vault") ?? "");
    const key = new URLSearchParams(url.hash.replace(/^#/, "")).get("k") ?? "";
    if (desk && decodeKey(key)) return { desk, key };
  } catch {
    /* a bare code, not a URL */
  }
  const parts = trimmed.split(".");
  if (parts.length === 2) {
    const desk = normalizeVaultId(parts[0]);
    if (desk && decodeKey(parts[1])) return { desk, key: parts[1] };
  }
  return null;
}

export function sameContent(left: Store, right: Store): boolean {
  const pick = (store: Store) => ({
    jobs: store.jobs,
    activeJobId: store.activeJobId,
    entries: store.entries,
    clients: store.clients,
    invoices: store.invoices,
    settings: store.settings,
    deletedIds: store.deletedIds,
  });
  return JSON.stringify(pick(left)) === JSON.stringify(pick(right));
}

export function applyRemote(local: Store, remote: Store | null, deskId: string): Store {
  const id = normalizeVaultId(deskId) ?? deskId;
  const current = { ...local, vaultId: id };
  if (!remote) return stampStore(current);
  const merged = durableMerge(current, { ...remote, vaultId: id });
  return stampStore({ ...merged, vaultId: id });
}

export async function sealStore(store: Store, key: string): Promise<Sealed> {
  const raw = decodeKey(key);
  if (!raw) throw new Error("key");
  const cryptoKey = await crypto.subtle.importKey("raw", asBuffer(raw), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(store));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, asBuffer(encoded)));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function openStore(blob: Sealed, key: string): Promise<Store | null> {
  const raw = decodeKey(key);
  const iv = decodeB64(blob.iv);
  const ct = decodeB64(blob.ct);
  if (!raw || !iv || !ct) return null;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", asBuffer(raw), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asBuffer(iv) }, cryptoKey, asBuffer(ct));
    return normalizeStore(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    return null;
  }
}

type Pull = { ok: true; rev: number; store: Store | null } | { ok: false };

export async function pullDesk(desk: string, key: string): Promise<Pull> {
  const id = normalizeVaultId(desk);
  if (!id) return { ok: false };
  let response: Response;
  try {
    response = await fetch(`${syncUrl()}?vault=${id}`);
  } catch {
    return { ok: false };
  }
  if (response.status === 404) return { ok: true, rev: 0, store: null };
  if (!response.ok) return { ok: false };
  let body: { rev?: unknown; blob?: Sealed | null };
  try {
    body = (await response.json()) as { rev?: unknown; blob?: Sealed | null };
  } catch {
    return { ok: false };
  }
  const rev = typeof body.rev === "number" ? body.rev : 0;
  if (!body.blob) return { ok: true, rev, store: null };
  const store = await openStore(body.blob, key);
  if (!store) return { ok: false };
  return { ok: true, rev, store };
}

let saveChain: Promise<unknown> = Promise.resolve();

export function saveDesk(desk: string, key: string, local: Store): Promise<{ ok: true; store: Store } | { ok: false }> {
  const run = saveChain.then(() => saveDeskOnce(desk, key, local));
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function saveDeskOnce(desk: string, key: string, local: Store): Promise<{ ok: true; store: Store } | { ok: false }> {
  const id = normalizeVaultId(desk);
  if (!id || !decodeKey(key)) return { ok: false };
  let current = { ...local, vaultId: id };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pulled = await pullDesk(id, key);
    if (!pulled.ok) return { ok: false };
    const merged = applyRemote(current, pulled.store, id);
    if (pulled.store && sameContent(merged, pulled.store)) return { ok: true, store: merged };
    let sealed: Sealed;
    try {
      sealed = await sealStore(merged, key);
    } catch {
      return { ok: false };
    }
    let response: Response;
    try {
      response = await fetch(`${syncUrl()}?vault=${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: pulled.rev, blob: sealed }),
      });
    } catch {
      return { ok: false };
    }
    if (response.ok) return { ok: true, store: merged };
    if (response.status !== 409) return { ok: false };
    current = merged;
  }
  return { ok: false };
}

let pushTimer = 0;
let pushChain: Promise<void> = Promise.resolve();

export function queueSync(desk: string, key: string, read: () => Store, onStore: (store: Store) => void): void {
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    const local = read();
    pushChain = pushChain.then(async () => {
      const result = await saveDesk(desk, key, local);
      if (result.ok) onStore(result.store);
    });
  }, 800);
}

function asBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeB64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeKey(value: string): Uint8Array | null {
  const bytes = decodeB64(value);
  return bytes?.length === 32 ? bytes : null;
}
