import { durableMerge, ensureVault, normalizeStore, saveStore, type Store } from "./model.ts";

const IDB_NAME = "horas";
const IDB_STORE = "kv";
const IDB_KEY = "store";
const OPFS_FILE = "horas.v1.json";

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

export function persistLocal(store: Store): void {
  saveStore(store);
  const raw = JSON.stringify(store);
  void writeIdb(store).catch(() => undefined);
  void writeOpfs(raw).catch(() => undefined);
}

async function readLocalCopies(): Promise<Store[]> {
  const copies: Store[] = [];
  const results = await Promise.allSettled([readIdb(), readOpfs()]);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) copies.push(result.value);
  }
  return copies;
}

export async function hydrateStore(local: Store): Promise<{ store: Store }> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* persist() is best-effort */
  }
  const copies = [local, ...(await readLocalCopies())];
  let merged = copies.reduce((acc, store) => durableMerge(acc, store));
  merged = ensureVault(merged);
  if (merged.savedAt === 0) merged = { ...merged, savedAt: Date.now() };
  persistLocal(merged);
  return { store: merged };
}

