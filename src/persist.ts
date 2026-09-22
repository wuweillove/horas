import {
  durableMerge,
  ensureVault,
  normalizeStore,
  saveStore,
  stampStore,
  type Store,
} from "./model";

const IDB_NAME = "horas";
const IDB_STORE = "kv";
const IDB_KEY = "store";
const OPFS_FILE = "horas.v1.json";
const API_PATH = "/api/horas";
const REMOTE_WAIT_MS = 800;

let remoteTimer = 0;
let pendingRemote: Store | null = null;
let remoteListener: ((ok: boolean) => void) | null = null;

export function onRemoteResult(listener: ((ok: boolean) => void) | null): void {
  remoteListener = listener;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

async function readIdb(): Promise<Store | null> {
  try {
    const db = await openIdb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return normalizeStore(value);
  } catch {
    return null;
  }
}

async function writeIdb(store: Store): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_STORE).put(store, IDB_KEY);
  });
  db.close();
}

async function readOpfs(): Promise<Store | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(OPFS_FILE);
    const file = await handle.getFile();
    return normalizeStore(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

async function writeOpfs(raw: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(OPFS_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(raw);
  await writable.close();
}

export async function readRemote(vaultId: string): Promise<Store | null> {
  if (!vaultId) return null;
  const response = await fetch(`${API_PATH}?vault=${encodeURIComponent(vaultId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("remote");
  const payload = (await response.json()) as { store?: unknown };
  return normalizeStore(payload.store ?? payload);
}

async function writeRemote(store: Store): Promise<boolean> {
  if (!store.vaultId) return false;
  const response = await fetch(`${API_PATH}?vault=${encodeURIComponent(store.vaultId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(store),
    keepalive: true,
  });
  return response.ok;
}

export function persistLocal(store: Store): void {
  saveStore(store);
  const raw = JSON.stringify(store);
  void writeIdb(store).catch(() => undefined);
  void writeOpfs(raw).catch(() => undefined);
}

export async function flushRemote(store: Store): Promise<boolean> {
  if (!store.vaultId) {
    remoteListener?.(false);
    return false;
  }
  try {
    const ok = await writeRemote(store);
    remoteListener?.(ok);
    return ok;
  } catch {
    remoteListener?.(false);
    return false;
  }
}

export function scheduleRemote(store: Store): void {
  pendingRemote = store;
  if (remoteTimer) window.clearTimeout(remoteTimer);
  remoteTimer = window.setTimeout(() => {
    remoteTimer = 0;
    const next = pendingRemote;
    pendingRemote = null;
    if (next) void flushRemote(next);
  }, REMOTE_WAIT_MS);
}

export function flushPendingRemote(): void {
  if (remoteTimer) {
    window.clearTimeout(remoteTimer);
    remoteTimer = 0;
  }
  const next = pendingRemote;
  pendingRemote = null;
  if (!next?.vaultId) return;
  try {
    const body = JSON.stringify(next);
    const blob = new Blob([body], { type: "application/json" });
    const sent = navigator.sendBeacon(`${API_PATH}?vault=${encodeURIComponent(next.vaultId)}`, blob);
    if (!sent) void flushRemote(next);
  } catch {
    void flushRemote(next);
  }
}

async function readLocalCopies(): Promise<Store[]> {
  const copies: Store[] = [];
  const results = await Promise.allSettled([readIdb(), readOpfs()]);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) copies.push(result.value);
  }
  return copies;
}

export async function hydrateStore(local: Store): Promise<{ store: Store; remote: boolean }> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* persist() is best-effort */
  }
  const copies = [local, ...(await readLocalCopies())];
  const vaultGuess = copies.map((store) => store.vaultId).find(Boolean) ?? "";
  let remoteOk = false;
  if (vaultGuess) {
    try {
      const remote = await readRemote(vaultGuess);
      if (remote) {
        copies.push(remote);
        remoteOk = true;
      } else {
        remoteOk = true;
      }
    } catch {
      remoteOk = false;
    }
  }
  let merged = copies.reduce((acc, store) => durableMerge(acc, store));
  merged = ensureVault(merged);
  if (merged.savedAt === 0) merged = { ...merged, savedAt: Date.now() };
  persistLocal(merged);
  const pushed = await flushRemote(merged);
  return { store: merged, remote: vaultGuess ? remoteOk && pushed : pushed };
}

export async function recoverVault(current: Store, code: string): Promise<Store> {
  const remote = await readRemote(code);
  if (!remote) throw new Error("missing");
  const merged = stampStore(durableMerge(current, { ...remote, vaultId: code }));
  const next = { ...merged, vaultId: code };
  persistLocal(next);
  await flushRemote(next);
  return next;
}

