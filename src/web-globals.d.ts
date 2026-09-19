// The browser names this package uses that `@types/node` does not declare.
//
// ⛔ WHY THIS FILE RATHER THAN `"lib": ["DOM"]`. The same package is imported by servers and by
//    agents, and telling the compiler this is a browser would make `document`, `window` and
//    several hundred other names type-check inside code that runs in neither. What is declared
//    below is exactly what `state-idb.ts` and `host-browser.ts` touch, and nothing else.
//
// ⚠ IT HAS NO TOP-LEVEL `import` OR `export`, on purpose: that is what makes everything in it
//   ambient, including the module declaration at the end.
//
// Each definition is the WHATWG one, narrowed to the members this package uses.

interface IDBRequestLike<T> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IDBOpenDBRequest extends IDBRequestLike<IDBDatabase> {
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}

interface IDBObjectStore {
  get(key: string): IDBRequestLike<unknown>;
  put(value: unknown, key: string): IDBRequestLike<unknown>;
  delete(key: string): IDBRequestLike<unknown>;
  getAllKeys(): IDBRequestLike<unknown[]>;
}

interface IDBTransaction {
  objectStore(name: string): IDBObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: Error | null;
}

interface DOMStringList {
  contains(name: string): boolean;
}

interface IDBDatabase {
  objectStoreNames: DOMStringList;
  createObjectStore(name: string): IDBObjectStore;
  transaction(names: string, mode: "readonly" | "readwrite"): IDBTransaction;
  close(): void;
}

interface IDBFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

/** Absent in a worker with storage blocked, in some private windows, and in Node. */
declare const indexedDB: IDBFactory | undefined;

/**
 * The engine is WebAssembly, and a runtime without it can do nothing with this account.
 *
 * ⚠ Declared as an object rather than the whole namespace: this package only ever asks whether it
 *   is there, and the engine's own glue declares what it uses.
 */
declare const WebAssembly: object | undefined;

/**
 * The engine's own glue, as the installed command-line package carries it.
 *
 * ⛔ DECLARED RATHER THAN IMPORTED FOR ITS TYPES, because the file is a build artefact that ships
 *    inside the published package (`vendor/nmts-crypto/`) and is not in this source tree. What is
 *    written here is the initialiser and nothing else: every export the engine has is checked at
 *    run time by `isCryptoGlue`, the same gate the Node load passes, so a declaration that claimed
 *    the rest would be a second description of a frozen format that could drift from the first.
 */
declare module "@needmoretruth/nmts-cli/vendor/nmts-crypto/nmts_crypto_wasm.js" {
  export default function init(options: { module_or_path: string }): Promise<unknown>;
}
