// Optional cloud mirror on Firebase (Auth: email + password, Database: Cloud Firestore).
// Local IndexedDB stays the source of truth; this pushes dirty records and pulls newer ones.
// Conflict rule: per record, the newest updatedAt wins. Deletes are tombstones (deleted: true).
// Firestore layout: users/{uid}/{store}/{recordId}  — locked to the owner by firestore.rules.

import * as db from './db.js';
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '13.4.0';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

let fb = null;
let loading = null;
let st = { configured: false, user: null, state: 'idle', lastSync: null, error: null };
const listeners = new Set();

export const status = () => st;
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(patch, changed = false) {
  st = { ...st, ...patch };
  for (const fn of listeners) { try { fn(st, changed); } catch (e) { console.error(e); } }
}

const isConfigured = () => !!(firebaseConfig && firebaseConfig.apiKey && !/^PASTE/i.test(firebaseConfig.apiKey) && firebaseConfig.projectId);

export async function init() {
  set({ configured: isConfigured(), lastSync: await db.meta('lastSync', null) });
  window.addEventListener('online', () => { if (st.configured) { load().then(() => schedule(0)).catch(() => {}); } });
  window.addEventListener('offline', () => set({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(1500); });
  if (!st.configured) return;
  if (!navigator.onLine) { set({ state: 'offline' }); return; }
  try { await load(); } catch { /* status already set */ }
}

async function load() {
  if (fb) return fb;
  if (loading) return loading;
  loading = (async () => {
    try {
      const [A0, A, F] = await Promise.all([
        import(`${CDN}/firebase-app.js`),
        import(`${CDN}/firebase-auth.js`),
        import(`${CDN}/firebase-firestore.js`),
      ]);
      const app = A0.initializeApp(firebaseConfig);
      const auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
      const fs = F.getFirestore(app);
      fb = { app, auth, fs, A, F };
      A.onAuthStateChanged(auth, (user) => {
        set({ user: user ? { uid: user.uid, email: user.email } : null, error: null, state: 'idle' });
        if (user) schedule(0);
      });
      return fb;
    } catch (e) {
      set({ state: navigator.onLine ? 'error' : 'offline', error: navigator.onLine ? `Couldn’t load Firebase: ${e.message || e}` : null });
      throw e;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

let timerId = null;
export function schedule(ms = 4000) {
  clearTimeout(timerId);
  if (!st.user) return;
  timerId = setTimeout(() => { syncNow().catch(() => {}); }, ms);
}

const clean = (obj) => JSON.parse(JSON.stringify(obj)); // Firestore rejects `undefined`

let running = null;
export async function syncNow() {
  if (!st.user) return;
  if (!navigator.onLine) { set({ state: 'offline' }); return; }
  if (running) return running;
  running = (async () => {
    set({ state: 'syncing', error: null });
    let changed = false;
    try {
      const { F, fs } = await load();
      const uid = st.user.uid;
      // 0) upload plan files before their records, so another phone never sees a record without its file
      const uploaded = await pushFiles(F, fs, uid).catch((e) => { console.warn('file upload failed', e); return null; });
      for (const store of db.SYNCED_STORES) {
        const col = F.collection(fs, 'users', uid, store);
        // 1) pull everything the server got since our last pull (by server time, immune to phone clock drift)
        const metaKey = `pull:${uid}:${store}`;
        const lastPull = (await db.meta(metaKey, 0)) || 0;
        const q = lastPull ? F.query(col, F.where('syncedAt', '>', F.Timestamp.fromMillis(lastPull))) : col;
        const snap = await F.getDocs(q);
        let maxSeen = lastPull;
        const incoming = [];
        const incomingIds = new Set();
        snap.forEach((d) => {
          const data = d.data();
          const sa = data.syncedAt?.toMillis ? data.syncedAt.toMillis() : 0;
          if (sa > maxSeen) maxSeen = sa;
          delete data.syncedAt;
          if (data.id) { incoming.push(data); incomingIds.add(data.id); }
        });
        if (incoming.length) {
          const local = new Map((await db.all(store, { includeDeleted: true })).map((r) => [r.id, r]));
          const toWrite = incoming
            .filter((r) => { const l = local.get(r.id); return !l || (r.updatedAt || 0) > (l.updatedAt || 0); })
            .map((r) => ({ ...r, _dirty: 0 }));
          if (toWrite.length) { await db.putRaw(store, toWrite, { silent: true }); changed = true; }
        }
        // 2) push local edits. The first sync for this account on this phone pushes everything, so
        //    built-in exercises/routines (never "edited", so never dirty) reach the cloud too and a
        //    new phone restoring from sync gets the routines its workouts belong to.
        let dirty = lastPull ? await db.dirty(store) : (await db.all(store, { includeDeleted: true })).filter((r) => !incomingIds.has(r.id) || r._dirty);
        if (store === 'files') dirty = await filesReady(dirty, uploaded, uid);
        for (let i = 0; i < dirty.length; i += 400) {
          const chunk = dirty.slice(i, i + 400);
          const batch = F.writeBatch(fs);
          for (const r of chunk) {
            const { _dirty, ...rest } = r;
            batch.set(F.doc(col, r.id), { ...clean(rest), syncedAt: F.serverTimestamp() });
          }
          await batch.commit();
          await db.markClean(store, chunk);
        }
        if (maxSeen > lastPull) await db.setMeta(metaKey, maxSeen);
      }
      // 3) download plan files that arrived as records from another phone
      if (await pullFiles(F, fs, uid).catch((e) => { console.warn('file download failed', e); return false; })) changed = true;
      const now = Date.now();
      await db.setMeta('lastSync', now);
      set({ state: 'idle', lastSync: now }, changed);
    } catch (e) {
      console.warn('sync failed', e);
      set({ state: navigator.onLine ? 'error' : 'offline', error: friendlyError(e) }, changed);
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------------------------------------------------------------- plan files
// Stored as users/{uid}/blobs/{hash}_{i}: raw bytes in ≤700 KB pieces (a Firestore document holds
// at most 1 MiB). Named by content hash, so re-uploading is harmless and old versions are easy to find.
const CHUNK = 700 * 1024;
const chunkCount = (size) => Math.max(1, Math.ceil((size || 0) / CHUNK));

async function pushFiles(F, fs, uid) {
  const key = `blobUp:${uid}`;
  const up = { ...((await db.meta(key, {})) || {}) };
  const files = await db.all('files');
  const col = F.collection(fs, 'users', uid, 'blobs');
  for (const f of files) {
    if (!f.hash || up[f.hash]) continue;
    const blob = await db.getBlob(`file:${f.hash}`);
    if (!blob) continue; // it came from another phone, which uploads it
    const u8 = new Uint8Array(await blob.arrayBuffer());
    const n = chunkCount(u8.length);
    for (let i = 0; i < n; i++) {
      await F.setDoc(F.doc(col, `${f.hash}_${i}`), { hash: f.hash, i, n, data: F.Bytes.fromUint8Array(u8.slice(i * CHUNK, (i + 1) * CHUNK)) });
    }
    up[f.hash] = n;
    await db.setMeta(key, up);
  }
  // Remove pieces of files this phone uploaded that no plan points at any more
  const live = new Set(files.map((f) => f.hash));
  for (const [hash, n] of Object.entries(up)) {
    if (live.has(hash)) continue;
    for (let i = 0; i < n; i++) await F.deleteDoc(F.doc(col, `${hash}_${i}`));
    delete up[hash];
    await db.setMeta(key, up);
  }
  return up;
}

/** Hold back a plan record until its file is in the cloud (deletes always go through). */
async function filesReady(records, uploaded, uid) {
  const up = uploaded || (await db.meta(`blobUp:${uid}`, {})) || {};
  const out = [];
  for (const r of records) {
    if (r.deleted || !r.hash || up[r.hash] || !(await db.getBlob(`file:${r.hash}`))) out.push(r);
  }
  return out;
}

async function pullFiles(F, fs, uid) {
  let got = false;
  for (const f of await db.all('files')) {
    if (!f.hash || (await db.getBlob(`file:${f.hash}`))) continue;
    const n = chunkCount(f.size);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const snap = await F.getDoc(F.doc(F.collection(fs, 'users', uid, 'blobs'), `${f.hash}_${i}`));
      if (!snap.exists()) { parts.length = 0; break; } // not fully uploaded yet; try next sync
      parts.push(snap.data().data.toUint8Array());
    }
    if (parts.length !== n) continue;
    await db.putBlob(`file:${f.hash}`, new Blob(parts, { type: f.type || 'application/pdf' }));
    got = true;
  }
  return got;
}

export async function signIn(email, password) {
  if (!email || !password) throw new Error('Enter email and password');
  const { A, auth } = await load();
  await A.signInWithEmailAndPassword(auth, email, password);
}

export async function signUp(email, password) {
  if (!email || !password) throw new Error('Enter email and password');
  const { A, auth } = await load();
  await A.createUserWithEmailAndPassword(auth, email, password);
}

/** One button for everyone: sign in, or create the account if this email is new. */
export async function connect(email, password) {
  if (!email || !password) throw new Error('Enter your email and a password');
  try {
    await signIn(email, password);
    return 'signed-in';
  } catch (e) {
    if (!['auth/invalid-credential', 'auth/user-not-found', 'auth/invalid-login-credentials'].includes(e?.code)) throw e;
    try {
      await signUp(email, password);
      return 'created';
    } catch (e2) {
      if (e2?.code === 'auth/email-already-in-use') throw Object.assign(new Error('Wrong password for that email.'), { code: 'auth/wrong-password' });
      throw e2;
    }
  }
}

export async function signOut() {
  if (!fb) { set({ user: null }); return; }
  await fb.A.signOut(fb.auth);
  set({ user: null, state: 'idle' });
}

export async function resetPassword(email) {
  if (!email) throw new Error('Type your email first');
  const { A, auth } = await load();
  await A.sendPasswordResetEmail(auth, email);
}

export function friendlyError(e) {
  const code = e?.code || '';
  const map = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong password for that email. Tap Forgot password if you need to reset it.',
    'auth/user-not-found': 'No account with that email — tap Create account.',
    'auth/email-already-in-use': 'That email already has an account — tap Sign in.',
    'auth/weak-password': 'Password needs at least 6 characters.',
    'auth/invalid-email': 'That email address doesn’t look right.',
    'auth/network-request-failed': 'No connection — try again when you have signal.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes.',
    'auth/operation-not-allowed': 'Email/Password sign-in isn’t enabled in Firebase (README step 2).',
    'auth/configuration-not-found': 'Email/Password sign-in isn’t enabled in Firebase (README step 2).',
    'permission-denied': 'Firestore rules are blocking sync — paste the rules from README step 4.',
    'unavailable': 'Firebase is unreachable right now — will retry.',
    'failed-precondition': 'Firestore database not created yet (README step 2).',
    'not-found': 'Firestore database not created yet (README step 2).',
    'resource-exhausted': 'The sync account is over its free daily limit. It picks up again tomorrow.',
  };
  return map[code] || e?.message || String(e);
}
