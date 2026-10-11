import 'fake-indexeddb/auto';

/**
 * Shared IndexedDB shim for the browser only.
 *
 * `db.ts` reads `globalThis.__TODO_DB_NAME__` at import time to pick its
 * database name; tests set it in a `vi.hoisted()` block BEFORE importing.
 * The Node test environment has no `crypto.randomUUID` guarantee, so we make
 * sure a DOMException-friendly one exists.
 */
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: {} as Crypto });
}
