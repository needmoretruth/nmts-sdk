// The browser's own store, and what happens when it will not open.
//
// ⛔ ONE DATABASE, ONE STORE, KEYS AS THE PACKAGE SPELLS THEM. `nmts-sdk` / `kv`, string key to
//    bytes — the same shape the Node host gives with files, so nothing above this line knows which
//    it is talking to.
//
// ⛔ A DATABASE THAT WILL NOT OPEN IS NOT A FAILED UPLOAD. Private windows, blocked site data,
//    a worker without storage and a browser that is simply out of quota are all ordinary. Every
//    caller of the store treats "no bytes" as "ask the server again", so the honest answer is to
//    carry on in memory and SAY SO: `durable` turns false, and it is false for the rest of the
//    page rather than flapping.
//
// ⛔ NOTHING HERE IS PLAINTEXT. What the store holds is sealed — the account's file list and the
//    sealed parts of an upload in flight. A browser's storage is readable by the page's own origin
//    and by whoever holds the device; it is not a second place the account's files are legible.

import type { StateHost } from "@needmoretruth/nmts-cli/portable";

import { memoryState } from "./state-memory.ts";

/** The database and the store inside it. Fixed: a page holds one account's work at a time. */
export const DATABASE = "nmts-sdk";
export const STORE = "kv";

/** One request, as a promise. IndexedDB is events; everything above this line is `await`. */
function settled<T>(request: IDBRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("the browser's store refused the request"));
  });
}

/** Open the database, making the store on first use. */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("the browser would not open its store"));
    // ⚠ Another tab holding an older version open. Answered rather than waited on: a page that
    //   hung here would look like a broken upload instead of a browser that needs a reload.
    request.onblocked = (): void => reject(new Error("another tab is holding this browser's store open"));
  });
}

/**
 * The browser's store, falling back to memory the first time it will not open.
 *
 * ⚠ THE DATABASE IS OPENED ON FIRST USE, not here. Making a client must do no work — the same rule
 *   `Nmts` follows — and a page that never touches storage should never be asked for permission
 *   to use it.
 */
export function idbState(): StateHost {
  const memory = memoryState();
  let opening: Promise<IDBDatabase | null> | null = null;
  let durable = true;

  const database = async (): Promise<IDBDatabase | null> => {
    const factory = typeof indexedDB === "undefined" ? undefined : indexedDB;
    if (factory === undefined) {
      durable = false;
      return null;
    }
    opening ??= openDatabase(factory).catch(() => null);
    const db = await opening;
    if (db === null) durable = false;
    return db;
  };

  /** Run one transaction, or answer null when this page has no database to run it in. */
  const inStore = async <T>(
    mode: "readonly" | "readwrite",
    body: (store: IDBObjectStore) => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> => {
    const db = await database();
    if (db === null) return { ran: false };
    try {
      const transaction = db.transaction(STORE, mode);
      const value = await body(transaction.objectStore(STORE));
      // ⛔ A WRITE IS NOT DONE UNTIL THE TRANSACTION IS. A resolved `put` request inside a
      //    transaction that then aborts is a record the next page load will not find.
      if (mode === "readwrite") {
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = (): void => resolve();
          transaction.onerror = (): void => reject(transaction.error ?? new Error("the write did not complete"));
          transaction.onabort = (): void => reject(transaction.error ?? new Error("the write was abandoned"));
        });
      }
      return { ran: true, value };
    } catch {
      // The database opened and then refused — out of quota, or evicted underneath the page.
      durable = false;
      return { ran: false };
    }
  };

  return {
    get durable(): boolean {
      return durable;
    },
    async read(key: string): Promise<Uint8Array | undefined> {
      const out = await inStore("readonly", async (store) => settled(store.get(key)));
      if (!out.ran) return memory.read(key);
      const held = out.value;
      return held instanceof Uint8Array ? new Uint8Array(held) : undefined;
    },
    async write(key: string, bytes: Uint8Array): Promise<void> {
      const out = await inStore("readwrite", async (store) => settled(store.put(new Uint8Array(bytes), key)));
      if (!out.ran) await memory.write(key, bytes);
    },
    async remove(key: string): Promise<void> {
      const out = await inStore("readwrite", async (store) => settled(store.delete(key)));
      if (!out.ran) await memory.remove(key);
    },
    async keys(prefix: string): Promise<string[]> {
      const out = await inStore("readonly", async (store) => settled(store.getAllKeys()));
      if (!out.ran) return memory.keys(prefix);
      return out.value.filter((key): key is string => typeof key === "string").filter((key) => key.startsWith(prefix));
    },
  };
}
