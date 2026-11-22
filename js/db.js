// Local-first storage on IndexedDB. The phone is the source of truth; sync.js mirrors it to Firebase.
// Every synced record carries: id, updatedAt (ms), deleted (soft delete), _dirty (1 = not yet pushed).

const DB_NAME = 'gymtracker';
const DB_VERSION = 1;
export const SYNCED_STORES = ['exercises', 'routines', 'workouts', 'bodyweight', 'settings'];

let dbPromise = null;
const listeners = new Set();

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of SYNCED_STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked — close other tabs of the app'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        Promise.resolve(fn(os)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaction aborted'));
      })
  );
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function uid(prefix = '') {
  const rnd = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 16);
  return prefix + rnd;
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(store) { for (const fn of listeners) { try { fn(store); } catch (e) { console.error(e); } } }

/** All non-deleted records in a store. */
export async function all(store, { includeDeleted = false } = {}) {
  const rows = await tx(store, 'readonly', (os) => reqP(os.getAll()));
  return includeDeleted ? rows : rows.filter((r) => !r.deleted);
}

export async function get(store, id) {
  const r = await tx(store, 'readonly', (os) => reqP(os.get(id)));
  return r && !r.deleted ? r : null;
}

export async function getRaw(store, id) {
  return tx(store, 'readonly', (os) => reqP(os.get(id)));
}

/** Save a record (local edit): stamps updatedAt and marks dirty for sync. */
export async function put(store, record) {
  const rec = { ...record, updatedAt: Date.now(), _dirty: 1 };
  if (!rec.id) rec.id = uid();
  await tx(store, 'readwrite', (os) => reqP(os.put(rec)));
  emit(store);
  return rec;
}

/** Soft delete so the deletion syncs to other devices. */
export async function remove(store, id) {
  const cur = await getRaw(store, id);
  if (!cur) return;
  await tx(store, 'readwrite', (os) => reqP(os.put({ ...cur, deleted: true, updatedAt: Date.now(), _dirty: 1 })));
  emit(store);
}

/** Write records exactly as given (used by sync pull, seeding and import). No change event for sync. */
export async function putRaw(store, records, { silent = false } = {}) {
  if (!records.length) return;
  await tx(store, 'readwrite', (os) => Promise.all(records.map((r) => reqP(os.put(r)))));
  if (!silent) emit(store);
}

export async function dirty(store) {
  const rows = await tx(store, 'readonly', (os) => reqP(os.getAll()));
  return rows.filter((r) => r._dirty);
}

/** Clear the dirty flag, but only if the record hasn't been edited again since it was pushed. */
export async function markClean(store, pushed) {
  // Plain request callbacks (no awaits) keep the transaction alive on every WebKit version.
  await tx(store, 'readwrite', (os) => {
    for (const p of pushed) {
      const g = os.get(p.id);
      g.onsuccess = () => {
        const cur = g.result;
        if (cur && cur.updatedAt === p.updatedAt && cur._dirty) {
          cur._dirty = 0;
          os.put(cur);
        }
      };
    }
  });
}

export async function meta(key, fallback = null) {
  const r = await tx('meta', 'readonly', (os) => reqP(os.get(key)));
  return r ? r.value : fallback;
}

export async function setMeta(key, value) {
  await tx('meta', 'readwrite', (os) => reqP(os.put({ key, value })));
}

export async function clearAll() {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction([...SYNCED_STORES, 'meta'], 'readwrite');
    for (const s of [...SYNCED_STORES, 'meta']) t.objectStore(s).clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  emit('*');
}

/** Ask the browser not to evict our data (granted heuristically on iOS for Home Screen apps). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

// ---------- Settings ----------
export const DEFAULT_SETTINGS = {
  id: 'main',
  plates: [45, 35, 25, 10, 5, 2.5],
  barWeight: 45,
  defaultRest: 120,
  warmupRest: 60,
  keepAwake: true,
  sound: true,
  animatedBg: true,
  updatedAt: 1,
};

export async function getSettings() {
  const s = await get('settings', 'main');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  return put('settings', { ...cur, ...patch, id: 'main' });
}

// ---------- Export / import ----------
export async function exportAll() {
  const data = { app: 'gym-tracker', version: 1, exportedAt: new Date().toISOString(), stores: {} };
  for (const s of SYNCED_STORES) data.stores[s] = (await all(s, { includeDeleted: true })).map(({ _dirty, ...r }) => r);
  return data;
}

/** Merge an export file in: newer updatedAt wins per record. Returns count of records written. */
export async function importAll(data) {
  if (!data || data.app !== 'gym-tracker' || !data.stores) throw new Error('Not a Gym Tracker backup file');
  let n = 0;
  for (const s of SYNCED_STORES) {
    const incoming = data.stores[s] || [];
    const existing = new Map((await all(s, { includeDeleted: true })).map((r) => [r.id, r]));
    const toWrite = [];
    for (const r of incoming) {
      if (!r || !r.id) continue;
      const cur = existing.get(r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) toWrite.push({ ...r, _dirty: 1 });
    }
    await putRaw(s, toWrite, { silent: true });
    n += toWrite.length;
  }
  emit('*');
  return n;
}
