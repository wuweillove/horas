import {
  durableMerge,
  ensureVault,
  isBlankStore,
  normalizeStore,
  saveStore,
  stampStore,
  type Store,
} from "./model.ts";

const IDB_NAME = "horas";
const IDB_STORE = "kv";
const IDB_KEY = "store";
const OPFS_FILE = "horas.v1.json";
const REMOTE_WAIT_MS = 800;

export type RemoteSink = {
  read: () => Promise<Store | null>;
  write: (store: Store) => Promise<boolean>;
};

let remoteTimer = 0;
let pendingRemote: Store | null = null;
let remoteListener: ((ok: boolean) => void) | null = null;
let sink: RemoteSink | null = null;

export function setRemoteSink(next: RemoteSink | null): void {
  sink = next;
}

export function remoteSinkReady(): boolean {
  return sink !== null;
}

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

export async function readRemote(): Promise<Store | null> {
  if (!sink) return null;
  return sink.read();
}

async function writeRemote(store: Store): Promise<boolean> {
  if (!sink) return false;
  return sink.write(store);
}

export function persistLocal(store: Store): void {
  saveStore(store);
  const raw = JSON.stringify(store);
  void writeIdb(store).catch(() => undefined);
  void writeOpfs(raw).catch(() => undefined);
}

export async function flushRemote(store: Store): Promise<boolean> {
  if (!sink) return false;
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
  if (!next || !sink) return;
  void flushRemote(next);
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
  let remoteOk = false;
  if (sink) {
    try {
      const remote = await readRemote();
      if (remote) copies.push(remote);
      remoteOk = true;
    } catch {
      remoteOk = false;
    }
  }
  let merged = copies.reduce((acc, store) => durableMerge(acc, store));
  merged = ensureVault(merged);
  if (merged.savedAt === 0) merged = { ...merged, savedAt: Date.now() };
  persistLocal(merged);
  const pushed = sink ? await flushRemote(merged) : false;
  return { store: merged, remote: remoteOk && pushed };
}

export async function recoverVault(current: Store, code: string): Promise<Store> {
  const remote = await readRemote();
  if (!remote || remote.vaultId !== code) throw new Error("missing");
  const incoming = { ...remote, vaultId: code };
  const merged = isBlankStore(current) ? incoming : durableMerge(current, incoming);
  const next = stampStore({ ...merged, vaultId: code });
  persistLocal(next);
  await flushRemote(next);
  return next;
}

