/**
 * A tiny key-value cache in IndexedDB. Every call is guarded: in a private window, with site data
 * blocked or with the database failing, reads return undefined and writes do nothing, and the app
 * works exactly as it would on a first visit. Nothing here is required for correctness.
 */
const DB = "plumbline";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB error"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T | undefined>((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // unavailable: the cache is an optimisation only
  }
}
