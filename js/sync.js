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
      for (const store of db.SYNCED_STORES) {
        const col = F.collection(fs, 'users', uid, store);
        // 1) pull everything the server got since our last pull (by server time, immune to phone clock drift)
        const metaKey = `pull:${uid}:${store}`;
        const lastPull = (await db.meta(metaKey, 0)) || 0;
        const q = lastPull ? F.query(col, F.where('syncedAt', '>', F.Timestamp.fromMillis(lastPull))) : col;
        const snap = await F.getDocs(q);
        let maxSeen = lastPull;
        const incoming = [];
        snap.forEach((d) => {
          const data = d.data();
          const sa = data.syncedAt?.toMillis ? data.syncedAt.toMillis() : 0;
          if (sa > maxSeen) maxSeen = sa;
          delete data.syncedAt;
          if (data.id) incoming.push(data);
        });
        if (incoming.length) {
          const local = new Map((await db.all(store, { includeDeleted: true })).map((r) => [r.id, r]));
          const toWrite = incoming
            .filter((r) => { const l = local.get(r.id); return !l || (r.updatedAt || 0) > (l.updatedAt || 0); })
            .map((r) => ({ ...r, _dirty: 0 }));
          if (toWrite.length) { await db.putRaw(store, toWrite, { silent: true }); changed = true; }
        }
        // 2) push local edits
        const dirty = await db.dirty(store);
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
    'auth/wrong-password': 'Wrong email or password.',
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
  };
  return map[code] || e?.message || String(e);
}
