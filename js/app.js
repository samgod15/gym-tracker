import * as db from './db.js';
import * as calc from './calc.js';
import * as timer from './timer.js';
import * as sync from './sync.js';
import { seedIfNeeded, seedNewUser, TEMPLATES } from './seed.js';
import * as B from './body.js';
import * as fx from './fx.js';
import { lineChart } from './charts.js';
import { h, fill, toast, sheet, confirmSheet, fmtDate, fmtDuration, debounce, relTime } from './ui.js';
import * as install from './install.js';
import * as plan from './plan.js';
import * as PP from './planparse.js';
import * as coach from './coach.js';
const { todayISO } = calc;

export const APP_VERSION = '1.7.0';

// ---------------------------------------------------------------- state
const S = {
  exercises: new Map(),
  routines: [],
  workouts: [],
  settings: { ...db.DEFAULT_SETTINGS },
  bodyweight: [],
  histIndex: null, // exerciseId -> [{workout, entry, at}] newest first (finished workouts only)
  current: null, // workout open in the editor
  profile: { ...db.DEFAULT_PROFILE },
  measurements: [],
  seeded: true,
};
const latestBW = () => S.bodyweight[0]?.weight ?? null;

const exById = (id) => S.exercises.get(id) || { id, name: 'Deleted exercise', loadType: 'total', restSec: null, missing: true };
const sortedExercises = () => [...S.exercises.values()].sort((a, b) => a.name.localeCompare(b.name));

async function loadAll() {
  const [ex, rt, wo, bw, settings, profile, ms, planRec] = await Promise.all([
    db.all('exercises'), db.all('routines'), db.all('workouts'), db.all('bodyweight'), db.getSettings(), db.getProfile(), db.all('measurements'), plan.getPlan(),
  ]);
  S.plan = planRec;
  S.profile = profile;
  S.measurements = ms.sort((a, b) => b.date.localeCompare(a.date));
  S.exercises = new Map(ex.map((e) => [e.id, e]));
  S.routines = rt.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
  S.workouts = wo.sort((a, b) => b.startedAt - a.startedAt);
  S.bodyweight = bw.sort((a, b) => b.date.localeCompare(a.date));
  S.settings = settings;
  S.histIndex = null;
  S.coach = null;
  S.snooze = (await db.meta('coachSnooze', {})) || {};
  timer.setSound(settings.sound !== false);
}

function histIndex() {
  if (S.histIndex) return S.histIndex;
  const idx = new Map();
  for (const w of S.workouts) {
    if (!w.endedAt) continue;
    for (const entry of w.entries || []) {
      if (!idx.has(entry.exerciseId)) idx.set(entry.exerciseId, []);
      idx.get(entry.exerciseId).push({ workout: w, entry, at: w.startedAt });
    }
  }
  for (const list of idx.values()) list.sort((a, b) => b.at - a.at);
  S.histIndex = idx;
  return idx;
}

const historyFor = (exerciseId, excludeWorkoutId = null) =>
  (histIndex().get(exerciseId) || []).filter((r) => r.workout.id !== excludeWorkoutId && r.entry.sets.some((s) => s.done));

const activeWorkout = () => S.workouts.find((w) => !w.endedAt);
const realWorkouts = () => S.workouts.filter((w) => w.endedAt && !w.id.startsWith('wo-baseline'));

// ---------------------------------------------------------------- routing
const app = document.getElementById('app');
const main = document.getElementById('main');
const titleEl = document.getElementById('title');
const headRight = document.getElementById('head-right');
const backBtn = document.getElementById('back');
const ROOT_TABS = ['train', 'history', 'progress', 'body', 'welcome'];
const PARENT = { settings: '#/train', workout: '#/train', routine: '#/train', session: '#/history', exercise: '#/progress', plan: '#/train', coach: '#/train' };
const navStack = []; // hashes visited inside the app, so Back can return to where you came from

backBtn.addEventListener('click', () => {
  if (navStack.length > 1) history.back();
  else location.replace(PARENT[route().name] || '#/train');
});

function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'train').split('/');
  return { name: parts[0], id: parts[1] ? decodeURIComponent(parts[1]) : null };
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

let elapsedTick = null;

async function render() {
  const r = route();
  if (!S.seeded && r.name !== 'welcome') { location.replace('#/welcome'); return; }
  clearInterval(elapsedTick);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabFor(r.name)));
  fill(headRight, syncButton());
  backBtn.hidden = ROOT_TABS.includes(r.name);
  app.dataset.route = r.name;
  const views = {
    train: viewTrain, workout: viewWorkout, routine: viewRoutine, history: viewHistory, session: viewSession,
    progress: viewProgress, exercise: viewExercise, body: viewBody, settings: viewSettings, welcome: viewWelcome, plan: viewPlan, coach: viewCoach,
  };
  const fn = views[r.name] || viewTrain;
  const same = r.name === lastRoute.name && r.id === lastRoute.id;
  const keep = same ? main.scrollTop : 0;
  const node = await fn(r.id);
  if (!same) node.classList?.add('enter'); // one entrance per screen, not on every re-render
  fill(main, node);
  main.scrollTop = keep;
  lastRoute = r;
  afterRender();
}

/** One-shot effects for the set that was just checked off (row flash, PR stamp + chalk burst). */
function afterRender() {
  const pr = S.justPr;
  S.justDone = null;
  S.justPr = null;
  if (!pr) return;
  const row = document.querySelector(`[data-set="${pr}"]`);
  const btn = row?.querySelector('.check');
  if (btn) {
    const b = btn.getBoundingClientRect();
    fx.chalkBurst(b.left + b.width / 2, b.top + b.height / 2);
  }
  fx.pulseLight('pr');
}
let lastRoute = {};
const tabFor = (name) => ({ workout: 'train', routine: 'train', session: 'history', exercise: 'progress', plan: 'train', coach: 'train' }[name] || name);
function setTitle(t) {
  const span = titleEl.querySelector('.title-text');
  if (span.textContent === t) return fitTitle();
  span.textContent = t;
  span.classList.remove('enter');
  void span.offsetWidth;
  span.classList.add('enter');
  fitTitle();
}

/** Shrink the header title so long names ("Edit workout") fit beside the back and sync buttons. */
function fitTitle() {
  const span = titleEl.querySelector('.title-text');
  titleEl.style.fontSize = '';
  requestAnimationFrame(() => {
    const room = titleEl.clientWidth; const need = span.scrollWidth;
    if (room && need > room) titleEl.style.fontSize = `${Math.max(24, Math.floor(parseFloat(getComputedStyle(titleEl).fontSize) * room / need))}px`;
  });
}
addEventListener('resize', fitTitle);
document.fonts?.ready.then(fitTitle);

// ---------------------------------------------------------------- sync badge
const CLOUD = '<path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 6.2 11.2 3.7 3.7 0 0 0 7 18.5Z"/>';
function cloudIcon(kind) {
  const extra = {
    ok: '<path d="m9.2 14.2 2 2 3.8-3.9"/>',
    busy: '<path class="spin-arrows" d="M14.7 12.2a2.9 2.9 0 1 1-.9-2.1M14.9 9.2v1.9h-1.9"/>',
    err: '<path d="M12 10.2v3M12 15.6v.1"/>',
    off: '<path d="m9.5 11.5 5 5M14.5 11.5l-5 5"/>',
    setup: '<path d="M12 11v5M9.5 13.5h5"/>',
  }[kind] || '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sync-ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = CLOUD + extra; // static markup only
  return svg;
}

function syncState() {
  const st = sync.status();
  if (!st.configured) return { kind: 'off', label: 'Sync off' };
  if (!st.user) return { kind: 'setup', label: 'Turn on sync' };
  if (st.state === 'syncing') return { kind: 'busy', label: 'Syncing' };
  if (st.state === 'error') return { kind: 'err', label: 'Sync failed' };
  if (st.state === 'offline') return { kind: 'off', label: 'Offline' };
  return { kind: 'ok', label: 'Synced' };
}

/** Header button: one tap syncs when you're signed in; otherwise opens the sync sheet. */
function syncButton() {
  const { kind, label } = syncState();
  return h('button', { class: `sync-badge ${kind}`, onclick: onSyncTap, 'aria-label': sync.status().user ? `${label}. Tap to sync now.` : `${label}. Tap to set up sync.` },
    cloudIcon(kind), label);
}

async function onSyncTap() {
  const st = sync.status();
  if (!st.user) { openSyncSheet(); return; }
  if (!navigator.onLine) { toast('No connection — it will sync when you’re back online'); return; }
  if (st.state === 'syncing') return;
  await sync.syncNow();
  const after = sync.status();
  if (after.state === 'error') toast(after.error || 'Sync failed', 'err');
  else toast('Synced');
}

let closeSyncSheet = null;
function openSyncSheet() { closeSyncSheet = sheet(syncPanel(), { title: 'Cloud sync', onClose: () => { closeSyncSheet = null; } }); }

/** Sync controls used in the sheet and in Settings. Redraws itself when sync status changes. */
function syncPanel() {
  const wrap = h('div', { class: 'stack sync-panel' });
  let email = '';
  let pw = '';
  let mode = '';
  let busy = false;
  db.meta('lastEmail', '').then((v) => { if (!email && v) { email = v; const i = wrap.querySelector('input[type=email]'); if (i && !i.value) i.value = v; } });

  const draw = () => {
    const st = sync.status();
    const m = !st.configured ? 'na' : st.user ? 'in' : 'out';
    if (m === 'out' && mode === 'out' && !busy) return; // keep what's being typed
    mode = m;
    if (m === 'na') {
      fill(wrap,
        h('div', { class: 'sync-status off' }, cloudIcon('off'), h('div', null, h('strong', null, 'Sync isn’t connected yet'), h('div', { class: 'muted small' }, 'Your workouts are saved on this phone.'))),
        h('p', { class: 'muted small' }, 'Until sync is on, export a backup file now and then so a lost phone doesn’t mean a lost log.'),
        h('button', { class: 'btn primary block', onclick: exportBackup }, 'Export backup'));
      return;
    }
    if (m === 'in') {
      const k = syncState().kind;
      const line = {
        busy: ['Syncing…', 'Sending and fetching your latest workouts.'],
        err: ['Couldn’t sync', st.error || 'Try again in a moment.'],
        off: ['Offline', 'Everything is saved on this phone and syncs when you’re back online.'],
        ok: [st.lastSync ? `Synced ${relTime(st.lastSync)}` : 'Ready to sync', 'Syncs by itself after every change and when you open the app.'],
      }[k] || ['Ready', ''];
      fill(wrap,
        h('div', { class: `sync-status ${k}` }, cloudIcon(k), h('div', null, h('strong', null, line[0]), h('div', { class: 'muted small' }, line[1]))),
        h('button', { class: 'btn primary block big-cta', disabled: k === 'busy' ? true : null, onclick: onSyncTap }, k === 'busy' ? 'Syncing…' : 'Sync now'),
        h('div', { class: 'row between' },
          h('span', { class: 'muted small' }, 'Signed in as ', h('strong', null, st.user.email)),
          h('button', { class: 'btn small ghost', onclick: async () => { await sync.signOut(); toast('Signed out — your log stays on this phone'); } }, 'Sign out')));
      return;
    }
    const emailIn = h('input', { type: 'email', autocomplete: 'username', inputmode: 'email', placeholder: 'Email', 'aria-label': 'Email', value: email, oninput: (e) => (email = e.target.value) });
    const pwIn = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password (6+ characters)', 'aria-label': 'Password', value: pw, oninput: (e) => (pw = e.target.value) });
    const go1 = async () => {
      if (busy) return;
      busy = true; draw();
      try {
        const result = await sync.connect(email.trim(), pw);
        await db.setMeta('lastEmail', email.trim());
        pw = '';
        toast(result === 'created' ? 'Account created — sync is on' : 'Signed in — syncing your log');
      } catch (e) {
        toast(sync.friendlyError(e), 'err');
      } finally {
        busy = false; mode = ''; draw();
      }
    };
    pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go1(); });
    fill(wrap,
      h('div', { class: 'sync-status' }, cloudIcon('setup'), h('div', null, h('strong', null, 'Keep your log safe'), h('div', { class: 'muted small' }, 'Back it up to the cloud and get it on any phone.'))),
      emailIn, pwIn,
      h('button', { class: 'btn primary block big-cta', disabled: busy ? true : null, onclick: go1 }, busy ? 'Connecting…' : 'Turn on sync'),
      h('p', { class: 'muted small' }, 'New here? This creates your account. On another phone, enter the same email and password and everything comes back.'),
      h('button', { class: 'link', onclick: async () => { try { await sync.resetPassword(email.trim()); toast('Password reset email sent'); } catch (e) { toast(sync.friendlyError(e), 'err'); } } }, 'Forgot password?'));
  };
  const unsub = sync.onStatus(() => { if (!wrap.isConnected) { unsub(); return; } draw(); });
  draw();
  return wrap;
}

// ================================================================= TRAIN
async function viewTrain() {
  setTitle('Train');
  const active = activeWorkout();
  const lastDone = (rid) => S.workouts.find((w) => w.endedAt && w.routineId === rid);
  const lastExport = await db.meta('lastExport', 0);
  const needsBackup = !sync.status().user && realWorkouts().length > 0 && Date.now() - lastExport > 7 * 86400000;
  const next = nextRoutine();
  const showInstall = !install.isStandalone() && !(await db.meta('installDismissed', false));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  let hero = null;
  if (active) {
    const done = active.entries.reduce((n, e) => n + e.sets.filter((x) => x.done).length, 0);
    hero = h('div', { class: 'card hero live' },
      h('div', { class: 'eyebrow' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'Workout in progress'),
      h('div', { class: 'hero-name' }, active.name || 'Workout'),
      h('div', { class: 'hero-meta' }, `Started ${fmtDuration(Date.now() - active.startedAt)} ago, ${plural(done, 'set')} logged`),
      h('button', { class: 'btn primary block', onclick: () => go(`#/workout/${active.id}`) }, 'Resume workout'));
  } else if (next) {
    const last = lastDone(next.id);
    hero = h('div', { class: 'card hero' },
      h('div', { class: 'eyebrow' }, 'Up next'),
      h('div', { class: 'hero-name' }, next.name),
      h('div', { class: 'hero-meta' }, `${plural(next.items.length, 'exercise')}${last ? `, last done ${fmtDate(last.startedAt, { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}`),
      h('button', { class: 'btn primary block', onclick: () => startFromRoutine(next) }, `Start ${next.name}`));
  }

  return h('div', { class: 'page stack' },
    needsBackup ? h('div', { class: 'banner warn' },
      h('div', null, h('strong', null, 'Back up your log. '), 'Sync is off and your last backup file is over a week old.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: exportBackup }, 'Export now'),
        h('button', { class: 'btn small ghost', onclick: () => go('#/settings') }, 'Set up sync'))) : null,
    showInstall ? h('div', { class: 'card install-card' },
      h('div', { class: 'install-text' }, h('strong', null, 'Put it on your home screen'), h('div', { class: 'muted small' }, 'Opens full screen, like an app, and works with no signal.')),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary small', onclick: () => install.showInstallGuide() }, 'Show me how'),
        h('button', { class: 'icon-btn', 'aria-label': 'Hide this tip', onclick: async () => { await db.setMeta('installDismissed', true); render(); } }, '✕'))) : null,
    hero,
    S.settings.coachOnTrain === false ? null : coachTeaser(),
    planCard(),
    h('div', { class: 'section-head' }, h('h2', null, 'Routines'),
      h('button', { class: 'btn small ghost', onclick: () => go('#/routine/new') }, '+ New')),
    S.routines.length ? S.routines.map((rt) => {
      const last = lastDone(rt.id);
      return h('div', { class: 'card routine-card' },
        h('div', { class: 'routine-main', onclick: () => startFromRoutine(rt) },
          h('div', { class: 'card-title' }, rt.name),
          h('div', { class: 'muted small' }, rt.items.map((i) => exById(i.exerciseId).name).join(', ')),
          h('div', { class: 'muted small' }, last ? `Last done ${fmtDate(last.startedAt)}` : 'Not done yet')),
        h('div', { class: 'routine-actions' },
          h('button', { class: 'btn primary small', onclick: () => startFromRoutine(rt) }, 'Start'),
          h('button', { class: 'icon-btn', 'aria-label': `Edit ${rt.name}`, onclick: () => go(`#/routine/${rt.id}`) }, '✎')));
    }) : h('p', { class: 'muted' }, 'No routines yet. Tap + New to build one.'),
    h('button', { class: 'btn ghost block', onclick: () => startWorkout({ name: 'Workout', routineId: null, entries: [] }) }, 'Start empty workout'));
}

/** The routine after the one you did most recently, in your routine order (wraps around). */
function nextRoutine() {
  if (!S.routines.length) return null;
  const lastW = S.workouts.find((w) => w.endedAt && w.routineId && S.routines.some((r) => r.id === w.routineId));
  if (!lastW) return S.routines[0];
  const i = S.routines.findIndex((r) => r.id === lastW.routineId);
  return S.routines[(i + 1) % S.routines.length];
}

async function startFromRoutine(rt) {
  const entries = rt.items.filter((i) => S.exercises.has(i.exerciseId)).map((i) => buildEntry(i.exerciseId, i.sets, i.group, i.reps, i.note));
  await startWorkout({ name: rt.name, routineId: rt.id, entries });
}

/** New entry prefilled from the last time this exercise was done. */
function buildEntry(exerciseId, targetSets = 3, group = null, targetReps = '', note = '') {
  const ex = exById(exerciseId);
  const last = historyFor(exerciseId)[0];
  const lastWork = last ? last.entry.sets.filter((s) => s.done && s.type === 'work') : [];
  const n = Math.max(1, targetSets || lastWork.length || 1);
  const sets = [];
  for (let i = 0; i < n; i++) {
    const src = lastWork[i] || lastWork[lastWork.length - 1];
    sets.push(newSet(src, ex));
  }
  const target = [targetReps ? `${n} × ${targetReps}` : '', note || ''].filter(Boolean).join(', ');
  return { exerciseId, group: group || null, target, sets };
}

function newSet(src, ex, type = 'work') {
  const s = { id: db.uid('s'), type, weight: null, plates: [], count: null, reps: null, rir: null, minutes: null, hr: null, done: false, doneAt: null };
  if (src) {
    s.weight = src.weight ?? null;
    s.plates = [...(src.plates || [])];
    s.count = src.count ?? null;
    if (ex?.loadType === 'cardio') { s.minutes = src.minutes ?? null; } else s.reps = src.reps ?? null;
  }
  return s;
}

async function startWorkout({ name, routineId, entries }) {
  const active = activeWorkout();
  if (active) {
    const ok = await confirmSheet(`"${active.name}" is still in progress. Discard it and start "${name}"?`, { ok: 'Discard & start', danger: true });
    if (!ok) return go(`#/workout/${active.id}`);
    await db.remove('workouts', active.id);
  }
  timer.unlockAudio();
  const w = await db.put('workouts', { id: db.uid('wo-'), name, routineId, startedAt: Date.now(), endedAt: null, notes: '', entries });
  await loadAll();
  go(`#/workout/${w.id}`);
}

// ================================================================= WORKOUT EDITOR
const saveCurrent = debounce(() => flushCurrent(), 400);
/** For taps (add/remove/check a set): write straight away so closing the app right after can't lose it. */
const saveNow = () => flushCurrent();
addEventListener('pagehide', () => flushCurrent());
async function flushCurrent() {
  const cur = S.current;
  if (!cur) return;
  const saved = await db.put('workouts', cur);
  cur.updatedAt = saved.updatedAt;
  const i = S.workouts.findIndex((w) => w.id === saved.id);
  if (i >= 0) S.workouts[i] = cur;
  else S.workouts.unshift(cur);
  S.histIndex = null;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCurrent(); });

async function viewWorkout(id) {
  const w = S.workouts.find((x) => x.id === id) || (await db.get('workouts', id));
  if (!w) { setTitle('Workout'); return h('div', { class: 'page' }, h('p', null, 'Workout not found.'), h('button', { class: 'btn', onclick: () => go('#/train') }, 'Back')); }
  if (!S.current || S.current.id !== w.id) S.current = structuredClone(w);
  const cw = S.current;
  const live = !cw.endedAt;
  setTitle(live ? 'Workout' : 'Edit workout');
  if (live && S.settings.keepAwake) timer.keepAwake(true);

  const elapsed = h('span', { class: 'elapsed' }, fmtDuration(Date.now() - cw.startedAt));
  if (live) elapsedTick = setInterval(() => (elapsed.textContent = fmtDuration(Date.now() - cw.startedAt)), 15000);

  const nameInput = h('input', { class: 'title-input', value: cw.name || '', 'aria-label': 'Workout name', oninput: (e) => { cw.name = e.target.value; saveCurrent(); } });

  const blocks = calc.groupEntries(cw.entries);
  const body = h('div', { class: 'page stack workout' },
    h('div', { class: 'workout-head' },
      nameInput,
      h('div', { class: 'row between' },
        h('span', { class: 'muted' }, live ? h('span', null, 'Elapsed ', elapsed) : fmtDate(cw.startedAt, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })),
        h('div', { class: 'row gap' },
          S.plan ? h('button', { class: 'btn small ghost', onclick: () => openPlanSheet() }, 'Plan') : null,
          live
            ? h('button', { class: 'btn primary small', onclick: () => finishWorkout() }, 'Finish')
            : h('button', { class: 'btn primary small', onclick: async () => { await saveFinishedEdit(); } }, 'Save')))),
    blocks.map((b) => b.group && b.entries.length > 1
      ? h('div', { class: 'superset' }, h('div', { class: 'superset-label' }, `Superset ${b.group}`), b.entries.map(({ entry, index }) => entryCard(entry, index)))
      : b.entries.map(({ entry, index }) => entryCard(entry, index))),
    h('button', { class: 'btn ghost block', onclick: () => pickExercise((ex) => { cw.entries.push(buildEntry(ex.id, 3)); saveNow(); rerender(); }) }, '+ Add exercise'),
    h('label', { class: 'field' }, h('span', null, 'Notes'),
      h('textarea', { rows: 3, placeholder: 'How it felt, machine settings…', oninput: (e) => { cw.notes = e.target.value; saveCurrent(); } }, cw.notes || '')),
    live
      ? h('button', { class: 'btn danger-ghost block', onclick: () => discardWorkout() }, 'Discard workout')
      : h('button', { class: 'btn danger-ghost block', onclick: () => deleteWorkout(cw.id) }, 'Delete workout'));
  return body;
}

function rerender() { render(); }

function entryCard(entry, ei) {
  const cw = S.current;
  const ex = exById(entry.exerciseId);
  const last = historyFor(entry.exerciseId, cw.id)[0];
  const lastWork = last ? last.entry.sets.filter((s) => s.done && s.type === 'work') : [];
  const lastText = last ? `Last ${fmtDate(last.at, { month: 'short', day: 'numeric' })}: ${lastWork.map((s) => calc.formatSet(ex, s).replace(/ @\d+ RIR/, '')).join(', ')}` : 'First time — this session sets your baseline';

  const isCardio = ex.loadType === 'cardio';
  const unitHead = { total: 'lb', dumbbell: 'lb ea', plates: 'per side', stack: 'plates', bodyweight: '+lb', cardio: 'min' }[ex.loadType] || 'lb';

  let workNo = 0;
  const rows = entry.sets.map((s, si) => {
    if (s.type === 'work') workNo++;
    const prev = lastWork[si] || null;
    const row = setRow(ex, entry, ei, s, si, s.type === 'work' ? String(workNo) : s.type === 'warmup' ? 'W' : 'D', prev);
    return swipeToDelete(row, () => { try { localStorage.setItem('gt-swiped', '1'); } catch {} removeSet(entry, entry.sets.indexOf(s)); });
  });

  return h('section', { class: `card entry ${entry.group ? 'in-superset' : ''}`, id: `entry-${ei}` },
    h('div', { class: 'entry-head' },
      h('div', { class: 'entry-title-row' },
        h('button', { class: 'entry-name', onclick: () => entryMenu(ei) },
          h('span', null, ex.name), entry.group ? h('span', { class: 'pill' }, entry.group) : null, h('span', { class: 'chev', 'aria-hidden': 'true' }, '⋯')),
        h('button', { class: 'icon-btn sm entry-remove', 'aria-label': `Remove ${ex.name} from this workout`, onclick: () => removeEntry(ei) }, TRASH())),
      entry.target ? h('span', { class: 'muted small' }, `Target ${entry.target}`) : null),
    h('div', { class: 'muted small last-line' }, lastText),
    cw.endedAt ? null : nextHint(ex, entry),
    h('div', { class: `set-grid head ${isCardio ? 'cardio' : ''}` },
      h('span', null, 'Set'), h('span', null, unitHead), h('span', null, isCardio ? 'Avg HR' : 'Reps'), isCardio ? null : h('span', null, 'RIR'), h('span', null, h('span', { class: 'sr' }, 'Done'))),
    rows,
    h('div', { class: 'entry-actions' },
      h('button', { class: 'chip-btn', onclick: () => { const src = entry.sets.filter((x) => x.type === 'work').pop(); entry.sets.push(newSet(src, ex)); saveNow(); rerender(); } }, '+ Set'),
      isCardio ? null : h('button', { class: 'chip-btn', onclick: () => { const firstWork = entry.sets.findIndex((x) => x.type !== 'warmup'); entry.sets.splice(firstWork < 0 ? entry.sets.length : firstWork, 0, newSet(null, ex, 'warmup')); saveNow(); rerender(); } }, '+ Warm-up'),
      isCardio ? null : h('button', { class: 'chip-btn', onclick: () => addDrop(entry, ex) }, '+ Drop'),
      entry.sets.length ? h('button', { class: 'chip-btn minus', 'aria-label': 'Remove the last set', onclick: () => removeSet(entry, entry.sets.length - 1) }, '− Set') : null),
    ei === 0 && entry.sets.length && !localStorage.getItem('gt-swiped') ? h('div', { class: 'muted tiny swipe-hint' }, 'Tip: swipe any set left to delete it.') : null);
}

const TRASH = () => {
  const el = h('span', { class: 'ico', 'aria-hidden': 'true' });
  el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  return el;
};

const SET_NAME = { work: 'Set', warmup: 'Warm-up set', drop: 'Drop set' };

/** Delete one set from the current workout, with Undo. */
function removeSet(entry, si) {
  const cw = S.current;
  if (!cw || si < 0 || si >= entry.sets.length) return;
  const [gone] = entry.sets.splice(si, 1);
  saveNow();
  rerender();
  toast(`${SET_NAME[gone.type] || 'Set'} removed`, '', { action: { label: 'Undo', run: () => {
    if (S.current !== cw || !cw.entries.includes(entry)) return;
    entry.sets.splice(Math.min(si, entry.sets.length), 0, gone);
    saveNow(); rerender();
  } } });
}

/** Take an exercise out of the current workout, with Undo. */
function removeEntry(ei) {
  const cw = S.current;
  const [gone] = cw.entries.splice(ei, 1);
  saveNow();
  rerender();
  toast(`${exById(gone.exerciseId).name} removed`, '', { action: { label: 'Undo', run: () => {
    if (S.current !== cw) return;
    cw.entries.splice(Math.min(ei, cw.entries.length), 0, gone);
    saveNow(); rerender();
  } } });
}

/** Swipe a set row left to reveal Delete; a long swipe deletes straight away. */
function swipeToDelete(row, onDelete) {
  const del = h('button', { class: 'swipe-del', tabindex: '-1', 'aria-hidden': 'true', onclick: () => onDelete() }, 'Delete');
  const wrap = h('div', { class: 'swipe-wrap' }, del, row);
  let x0 = 0; let y0 = 0; let dx = 0; let mode = null; let open = false; let pid = null;
  const OPEN = -92; const FULL = -190;
  const place = (x, animate) => {
    row.style.transition = animate ? 'transform .25s var(--ease-out)' : 'none';
    row.style.transform = x ? `translateX(${x}px)` : '';
    del.style.opacity = String(Math.min(1, -x / 70));
    wrap.classList.toggle('swiping', x < 0);
  };
  const close = () => { open = false; place(0, true); };
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; mode = null; pid = e.pointerId;
  });
  row.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const mx = e.clientX - x0; const my = e.clientY - y0;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = Math.abs(mx) > Math.abs(my) * 1.2 ? 'swipe' : 'scroll';
      if (mode === 'swipe') { try { row.setPointerCapture(pid); } catch {} document.activeElement?.blur?.(); }
    }
    if (mode !== 'swipe') return;
    dx = Math.min(0, (open ? OPEN : 0) + mx);
    place(Math.max(dx, -260), false);
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (mode !== 'swipe') return;
    // swallow the click that follows a swipe so it doesn't tick the set or open a menu
    const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
    row.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => row.removeEventListener('click', swallow, { capture: true }), 350);
    if (dx <= FULL) { place(-400, true); setTimeout(onDelete, 160); return; }
    if (dx <= OPEN / 2) { open = true; place(OPEN, true); return; }
    close();
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', (e) => { if (e.pointerId === pid) { pid = null; close(); } });
  // Tapping anywhere else closes an open row
  const outside = (e) => {
    if (!wrap.isConnected) { document.removeEventListener('pointerdown', outside, { capture: true }); return; }
    if (open && !wrap.contains(e.target)) close();
  };
  document.addEventListener('pointerdown', outside, { capture: true });
  return wrap;
}

function addDrop(entry, ex) {
  // drop goes right after the last completed set (or the last set), lighter than it
  let at = -1;
  entry.sets.forEach((s, i) => { if (s.done) at = i; });
  if (at < 0) at = entry.sets.length - 1;
  const src = entry.sets[at];
  const d = newSet(src, ex, 'drop');
  d.reps = null;
  if (ex.loadType === 'total' || ex.loadType === 'dumbbell') d.weight = src?.weight ? Math.round(src.weight * 0.8 / 2.5) * 2.5 : null;
  if (ex.loadType === 'stack' && src?.count) d.count = Math.max(1, src.count - 1);
  if (ex.loadType === 'plates' && src?.plates?.length) d.plates = src.plates.slice(0, -1);
  entry.sets.splice(at + 1, 0, d);
  saveNow();
  rerender();
}

const parseNum = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function numInput({ value, placeholder, label, onInput, decimal = true, cls = '' }) {
  return h('input', {
    class: `num ${cls}`, type: 'text', inputmode: decimal ? 'decimal' : 'numeric', enterkeyhint: 'done', autocomplete: 'off',
    value: value ?? '', placeholder: placeholder ?? '', 'aria-label': label,
    onfocus: (e) => e.target.select(),
    oninput: (e) => onInput(parseNum(e.target.value)),
  });
}

function setRow(ex, entry, ei, s, si, badge, prev) {
  const cw = S.current;
  const t = ex.loadType;
  const isCardio = t === 'cardio';
  const onChange = () => saveCurrent();
  let loadCell;
  if (t === 'plates') {
    const L = calc.setLoad(ex, s);
    loadCell = h('button', { class: 'plate-btn', 'aria-label': 'Edit plates', onclick: () => platePicker(ex, entry, s) },
      h('span', { class: 'plate-side' }, s.plates?.length ? s.plates.join('+') : 'Tap to load'),
      L.value !== null ? h('span', { class: 'plate-total' }, `${calc.fmtNum(L.value)} lb`) : null);
  } else if (t === 'stack') {
    loadCell = numInput({ value: s.count, placeholder: prev?.count ?? '', label: 'Plates on stack', onInput: (v) => { s.count = v; onChange(); } });
  } else if (isCardio) {
    loadCell = numInput({ value: s.minutes, placeholder: prev?.minutes ?? 'min', label: 'Minutes', onInput: (v) => { s.minutes = v; onChange(); } });
  } else {
    loadCell = numInput({ value: s.weight, placeholder: prev?.weight ?? (t === 'bodyweight' ? '0' : ''), label: t === 'bodyweight' ? 'Added weight' : 'Weight', onInput: (v) => { s.weight = v; onChange(); } });
  }
  const repsCell = isCardio
    ? numInput({ value: s.hr, placeholder: 'bpm', label: 'Average heart rate', decimal: false, onInput: (v) => { s.hr = v; onChange(); } })
    : numInput({ value: s.reps, placeholder: prev?.reps ?? '', label: 'Reps', decimal: false, onInput: (v) => { s.reps = v; onChange(); } });
  const rirCell = isCardio ? null : h('select', { class: 'rir', 'aria-label': 'Reps in reserve', onchange: (e) => { s.rir = parseNum(e.target.value); onChange(); } },
    ['', 0, 1, 2, 3, 4, 5].map((v) => h('option', { value: String(v), selected: s.rir === v || (v === '' && s.rir === null) ? 'selected' : null }, v === '' ? '–' : v === 5 ? '5+' : String(v))));

  const done = h('button', {
    class: `check ${s.done ? 'on' : ''}`, 'aria-label': s.done ? 'Mark set not done' : 'Mark set done', 'aria-pressed': s.done ? 'true' : 'false',
    onclick: () => toggleDone(ex, entry, ei, s, si),
  }, '✓');

  const fresh = S.justDone === s.id ? ' just-done' : '';
  const freshPr = S.justPr === s.id ? ' just-pr' : '';
  return h('div', { class: `set-grid ${s.done ? 'done' : ''} ${s.type} ${isCardio ? 'cardio' : ''}${fresh}${freshPr}`, 'data-set': s.id },
    h('button', { class: `badge ${s.type}`, 'aria-label': `Set ${badge}, options`, onclick: () => setMenu(ex, entry, s, si) }, badge),
    loadCell, repsCell, rirCell, done,
    s.pr?.length ? h('span', { class: 'pr-tag', title: `PR: ${s.pr.join(', ')}` }, 'PR') : null);
}

function toggleDone(ex, entry, ei, s, si) {
  timer.unlockAudio();
  const cw = S.current;
  if (s.done) {
    s.done = false; s.doneAt = null; s.pr = [];
    saveNow(); rerender(); return;
  }
  // fill blanks from placeholders (previous session) so one tap logs "same as last time"
  if (ex.loadType !== 'cardio' && s.reps === null) {
    const last = historyFor(entry.exerciseId, cw.id)[0];
    const lw = last ? last.entry.sets.filter((x) => x.done && x.type === 'work') : [];
    const p = lw[entry.sets.filter((x, i) => i < si && x.type === 'work').length] || null;
    if (p && s.type === 'work') { s.reps = p.reps; if (s.weight === null) s.weight = p.weight; if (s.count === null) s.count = p.count; }
  }
  if (ex.loadType === 'cardio' && s.minutes === null) { toast('Enter minutes first'); return; }
  if (ex.loadType !== 'cardio' && s.reps === null) { toast('Enter reps first'); return; }
  if (ex.loadType === 'plates' && !s.plates?.length && !ex.baseWeight) { toast('Load the plates first'); return; }
  if (ex.loadType === 'stack' && s.count === null) { toast('Enter the plate / pin number first'); return; }
  if ((ex.loadType === 'total' || ex.loadType === 'dumbbell') && s.weight === null) { toast('Enter the weight first'); return; }
  s.done = true;
  s.doneAt = Date.now();
  S.justDone = s.id;

  // PR check vs previous sessions + earlier sets today
  const hist = historyFor(entry.exerciseId, cw.id).map((r) => calc.sessionBest(ex, r.entry));
  entry.sets.forEach((o, i) => { if (i !== si && o.done && o.type === 'work') hist.push(calc.sessionBest(ex, { sets: [o] })); });
  // Other entries of the same exercise earlier in this workout
  cw.entries.forEach((e2, j) => { if (j !== ei && e2.exerciseId === entry.exerciseId) hist.push(calc.sessionBest(ex, e2)); });
  s.pr = calc.prsForSet(ex, s, hist);
  if (s.pr.length) {
    S.justPr = s.id;
    const L = calc.setLoad(ex, s);
    const est = calc.e1rm(L.value, s.reps);
    toast(s.pr.includes('e1RM') && est ? `New PR! Est. 1RM ${calc.fmtNum(est)} ${L.unit === 'lb' ? 'lb' : L.unit}` : `New PR! Most ${s.pr.join(' + ')}`, 'pr');
  }

  const d = calc.restDecision(cw.entries, ei, si);
  if (d.rest) {
    const secs = s.type === 'warmup' ? S.settings.warmupRest : (ex.restSec ?? S.settings.defaultRest);
    const nextName = nextUpLabel(ei, si);
    if (secs > 0) timer.start(secs, nextName);
  } else if (d.next !== null && d.next !== ei) {
    timer.stop();
    toast(`Superset → ${exById(cw.entries[d.next].exerciseId).name}`);
    setTimeout(() => document.getElementById(`entry-${d.next}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  saveNow();
  rerender();
}

function nextUpLabel(ei, si) {
  const cw = S.current;
  const entry = cw.entries[ei];
  const name = (i) => `Next: ${exById(cw.entries[i].exerciseId).name}`;
  const pendingAfter = (idx) => cw.entries.findIndex((e, i) => i > idx && e.sets.some((x) => !x.done));
  if (entry.group) {
    const block = calc.groupEntries(cw.entries).find((b) => b.entries.some((e) => e.index === ei));
    if (block && block.entries.length > 1) {
      const pending = block.entries.find(({ entry: e }) => e.sets.some((x) => !x.done));
      if (pending) return name(pending.index);
      const after = pendingAfter(block.entries[block.entries.length - 1].index);
      return after >= 0 ? name(after) : 'All sets done';
    }
  }
  if (entry.sets.some((x, i) => i > si && !x.done)) return name(ei);
  const after = pendingAfter(ei);
  return after >= 0 ? name(after) : 'All sets done';
}

function setMenu(ex, entry, s, si) {
  sheet((close) => h('div', { class: 'stack' },
    h('div', { class: 'seg' }, [['warmup', 'Warm-up'], ['work', 'Working'], ['drop', 'Drop set']].map(([k, label]) =>
      h('button', { class: `seg-btn ${s.type === k ? 'on' : ''}`, onclick: () => { s.type = k; if (k !== 'work') s.pr = []; saveNow(); close(); rerender(); } }, label))),
    h('p', { class: 'muted small' }, 'Warm-ups and drop sets never count toward PRs or charts.'),
    h('button', { class: 'btn danger-ghost block', onclick: () => { close(); removeSet(entry, entry.sets.indexOf(s)); } }, 'Delete this set')),
  { title: 'Set options' });
}

function entryMenu(ei) {
  const cw = S.current;
  const entry = cw.entries[ei];
  const ex = exById(entry.exerciseId);
  sheet((close) => {
    const done = () => { saveNow(); close(); rerender(); };
    const restInput = numInput({ value: ex.restSec ?? S.settings.defaultRest, label: 'Rest seconds', decimal: false, onInput: () => {} });
    return h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('span', null, 'Superset with neighbours'),
        h('div', { class: 'seg' }, ['', 'A', 'B', 'C', 'D'].map((g) => h('button', { class: `seg-btn ${(entry.group || '') === g ? 'on' : ''}`, onclick: () => { entry.group = g || null; done(); } }, g || 'None')))),
      h('p', { class: 'muted small' }, 'Give the exercises you alternate the same letter and keep them next to each other. Rest starts after the last one in each round.'),
      h('label', { class: 'field' }, h('span', null, `Rest after a set (seconds) — saved to ${ex.name}`),
        h('div', { class: 'row gap' }, restInput,
          h('button', { class: 'btn small', onclick: async () => { const v = parseNum(restInput.value); if (v === null) return; await db.put('exercises', { ...ex, restSec: v }); await loadAll(); toast('Rest time saved'); close(); } }, 'Save'))),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost grow', disabled: ei === 0 ? true : null, onclick: () => { [cw.entries[ei - 1], cw.entries[ei]] = [cw.entries[ei], cw.entries[ei - 1]]; done(); } }, '↑ Move up'),
        h('button', { class: 'btn ghost grow', disabled: ei === cw.entries.length - 1 ? true : null, onclick: () => { [cw.entries[ei + 1], cw.entries[ei]] = [cw.entries[ei], cw.entries[ei + 1]]; done(); } }, '↓ Move down')),
      h('button', { class: 'btn ghost block', onclick: () => { close(); pickExercise((nx) => { const fresh = buildEntry(nx.id, entry.sets.filter((x) => x.type === 'work').length || 3, entry.group); cw.entries[ei] = fresh; saveCurrent(); rerender(); }); } }, 'Swap for another exercise'),
      ex.missing ? null : h('button', { class: 'btn ghost block', onclick: () => { close(); flushCurrent().then(() => go(`#/exercise/${ex.id}`)); } }, 'Progress & settings for this exercise'),
      h('button', { class: 'btn danger-ghost block', onclick: () => { close(); removeEntry(ei); } }, 'Remove from workout'));
  }, { title: ex.name });
}

function platePicker(ex, entry, s) {
  if (!s.plates?.length) {
    const idx = entry.sets.indexOf(s);
    const prevWithPlates = entry.sets.slice(0, idx).reverse().find((x) => x.plates?.length);
    if (prevWithPlates) s.plates = [...prevWithPlates.plates];
  }
  const inv = [...(S.settings.plates || [45, 35, 25, 10, 5, 2.5])].sort((a, b) => b - a);
  sheet((close) => {
    const wrap = h('div', { class: 'stack' });
    const draw = () => {
      const L = calc.setLoad(ex, s);
      const perSide = calc.sumPlates(s.plates);
      fill(wrap, 
        h('div', { class: 'plate-readout' },
          h('div', null, h('div', { class: 'big' }, `${calc.fmtNum(perSide)}`), h('div', { class: 'muted small' }, 'lb per side')),
          h('div', null, h('div', { class: 'big' }, L.value !== null ? calc.fmtNum(L.value) : '0'), h('div', { class: 'muted small' }, ex.baseWeight ? `lb total (incl. ${calc.fmtNum(ex.baseWeight)} base)` : 'lb total (plates)'))),
        h('div', { class: 'plate-stack', 'aria-label': 'Plates on one side' },
          s.plates.length ? s.plates.map((p, i) => h('button', { class: `plate p${String(p).replace('.', '_')}`, 'aria-label': `Remove ${p}`, onclick: () => { s.plates.splice(i, 1); draw(); } }, calc.fmtNum(p))) : h('span', { class: 'muted' }, 'Empty — tap plates below')),
        h('div', { class: 'muted small' }, 'Tap to add one plate to each side. Tap a loaded plate to take it off.'),
        h('div', { class: 'plate-keys' }, inv.map((p) => h('button', { class: 'plate-key', onclick: () => { s.plates.push(p); s.plates.sort((a, b) => b - a); draw(); } }, `+${calc.fmtNum(p)}`))),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost grow', onclick: () => { s.plates = []; draw(); } }, 'Clear'),
          h('button', { class: 'btn primary grow', onclick: () => close() }, 'Done')));
    };
    draw();
    return wrap;
  }, { title: `${ex.name}`, onClose: () => { saveNow(); rerender(); } });
}

async function finishWorkout() {
  const cw = S.current;
  const unchecked = cw.entries.reduce((n, e) => n + e.sets.filter((s) => !s.done).length, 0);
  const doneCount = cw.entries.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  if (!doneCount) {
    const ok = await confirmSheet('No sets are checked off. Discard this workout?', { ok: 'Discard', danger: true });
    if (ok) await discardWorkout(true);
    return;
  }
  if (unchecked) {
    const ok = await confirmSheet(`${unchecked} set${unchecked > 1 ? 's aren’t' : ' isn’t'} checked off. Finish anyway? Unchecked sets are removed.`, { ok: 'Finish' });
    if (!ok) return;
  }
  cw.entries = cw.entries.map((e) => ({ ...e, sets: e.sets.filter((s) => s.done) })).filter((e) => e.sets.length);
  cw.endedAt = Date.now();
  await flushCurrent();
  timer.stop();
  timer.keepAwake(false);
  const summary = summarize(cw);
  S.current = null;
  await loadAll();
  sync.schedule(0);
  go(`#/session/${cw.id}`);
  sheet(h('div', { class: 'stack summary' },
    h('div', { class: 'stat-row' },
      stat(fmtDuration(cw.endedAt - cw.startedAt), 'Duration'),
      stat(String(summary.sets), 'Sets'),
      stat(summary.volume ? `${Math.round(summary.volume).toLocaleString()}` : '—', 'Volume (lb)')),
    summary.prs.length ? h('div', { class: 'stack' }, h('h3', null, `${summary.prs.length} PR${summary.prs.length > 1 ? 's' : ''}`),
      summary.prs.map((p) => h('div', { class: 'pr-line' }, h('span', { class: 'pr-tag' }, 'PR'), p))) : h('p', { class: 'muted' }, 'No PRs this time.')),
  { title: `${cw.name} done` });
  document.querySelectorAll('.summary .stat-val').forEach((el) => {
    const n = Number(el.textContent.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) fx.countUp(el, n);
  });
  if (summary.prs.length) fx.pulseLight('pr');
}

function summarize(w) {
  let sets = 0; let volume = 0; const prs = [];
  for (const e of w.entries) {
    const ex = exById(e.exerciseId);
    sets += e.sets.filter((s) => s.done && s.type !== 'warmup').length;
    volume += calc.entryVolume(ex, e);
    for (const s of e.sets) if (s.pr?.length) prs.push(`${ex.name}: ${calc.formatSet(ex, s)}`);
  }
  return { sets, volume, prs };
}

const stat = (value, label) => h('div', { class: 'stat' }, h('div', { class: 'stat-val' }, value), h('div', { class: 'stat-label' }, label));

async function saveFinishedEdit() {
  const cw = S.current;
  // recompute PR flags isn't retroactive; keep as logged
  await flushCurrent();
  S.current = null;
  await loadAll();
  toast('Saved');
  go(`#/session/${cw.id}`);
}

async function discardWorkout(skipConfirm = false) {
  const cw = S.current;
  if (!skipConfirm) {
    const ok = await confirmSheet('Discard this workout? Nothing from it will be saved.', { ok: 'Discard', danger: true });
    if (!ok) return;
  }
  S.current = null; // stop pending autosaves from resurrecting it
  await db.remove('workouts', cw.id);
  timer.stop();
  timer.keepAwake(false);
  await loadAll();
  go('#/train');
}

async function deleteWorkout(id) {
  const ok = await confirmSheet('Delete this workout from your history?', { ok: 'Delete', danger: true });
  if (!ok) return;
  S.current = null;
  await db.remove('workouts', id);
  await loadAll();
  go('#/history');
}

// ================================================================= EXERCISE PICKER
function pickExercise(onPick, initialTerm = '') {
  sheet((close) => {
    const list = h('div', { class: 'pick-list' });
    const q = h('input', { class: 'search', type: 'search', value: initialTerm, placeholder: 'Search or type a new name', 'aria-label': 'Search exercises', oninput: () => draw() });
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const matches = sortedExercises().filter((e) => !term || e.name.toLowerCase().includes(term) || (e.muscle || '').toLowerCase().includes(term));
      fill(list, 
        ...matches.map((e) => h('button', { class: 'pick-item', onclick: () => { close(); onPick(e); } },
          h('span', null, e.name), h('span', { class: 'muted small' }, [e.muscle, calc.LOAD_TYPES[e.loadType]?.label].filter(Boolean).join(', ')))),
        term && !matches.some((m) => m.name.toLowerCase() === term)
          ? h('button', { class: 'pick-item create', onclick: () => { close(); exerciseForm({ name: q.value.trim() }, (ex) => onPick(ex)); } }, `+ Create “${q.value.trim()}”`)
          : null);
    };
    draw();
    setTimeout(() => q.focus(), 250);
    return h('div', { class: 'stack' }, q, list,
      h('button', { class: 'btn ghost block', onclick: () => { close(); exerciseForm({}, (ex) => onPick(ex)); } }, '+ New exercise'));
  }, { title: 'Add exercise' });
}

function exerciseForm(initial, onSaved) {
  const ex = { name: '', loadType: 'total', baseWeight: null, lbsPerPlate: null, restSec: S.settings.defaultRest, muscle: '', notes: '', ...initial };
  sheet((close) => {
    const wrap = h('div', { class: 'stack' });
    const draw = () => {
      fill(wrap, 
        h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { value: ex.name, oninput: (e) => (ex.name = e.target.value) })),
        h('div', { class: 'field' }, h('span', null, 'How is weight entered?'),
          h('div', { class: 'type-list' }, Object.entries(calc.LOAD_TYPES).map(([k, v]) =>
            h('button', { class: `type-opt ${ex.loadType === k ? 'on' : ''}`, onclick: () => { ex.loadType = k; if (k === 'plates' && ex.baseWeight === null) ex.baseWeight = 0; draw(); } }, v.label)))),
        ex.loadType === 'plates' ? h('label', { class: 'field' }, h('span', null, 'Base weight (empty bar or sled, lb)'),
          h('div', { class: 'row gap' },
            numInput({ value: ex.baseWeight ?? 0, label: 'Base weight', onInput: (v) => (ex.baseWeight = v ?? 0) }),
            h('button', { class: 'btn small ghost', onclick: () => { ex.baseWeight = S.settings.barWeight || 45; draw(); } }, `Barbell ${S.settings.barWeight || 45}`),
            h('button', { class: 'btn small ghost', onclick: () => { ex.baseWeight = 0; draw(); } }, 'Machine 0'))) : null,
        ex.loadType === 'stack' ? h('label', { class: 'field' }, h('span', null, 'Lbs per stack plate (optional — leave blank to track plates)'),
          numInput({ value: ex.lbsPerPlate, label: 'Pounds per plate', onInput: (v) => (ex.lbsPerPlate = v) })) : null,
        h('label', { class: 'field' }, h('span', null, 'Rest after a set (seconds)'), numInput({ value: ex.restSec, decimal: false, label: 'Rest seconds', onInput: (v) => (ex.restSec = v) })),
        ex.loadType !== 'cardio' && ex.loadType !== 'stack' ? h('label', { class: 'field' }, h('span', null, 'Strength level compares it to'),
          h('select', { onchange: (e) => (ex.standard = e.target.value) },
            h('option', { value: '', selected: !ex.standard ? 'selected' : null }, `Automatic${B.standardFor({ ...ex, standard: '' }) ? ` (${B.STANDARDS[B.standardFor({ ...ex, standard: '' }).key].name})` : ' (none found)'}`),
            h('option', { value: 'none', selected: ex.standard === 'none' ? 'selected' : null }, 'Don’t rate this exercise'),
            Object.entries(B.STANDARDS).map(([k, v]) => h('option', { value: k, selected: ex.standard === k ? 'selected' : null }, v.name)))) : null,
        h('label', { class: 'field' }, h('span', null, 'Muscle group (optional)'), h('input', { value: ex.muscle || '', oninput: (e) => (ex.muscle = e.target.value) })),
        h('label', { class: 'field' }, h('span', null, 'Notes (seat height, grip…)'), h('textarea', { rows: 2, oninput: (e) => (ex.notes = e.target.value) }, ex.notes || '')),
        h('button', { class: 'btn primary block', onclick: async () => {
          if (!ex.name.trim()) return toast('Give it a name');
          const saved = await db.put('exercises', { ...ex, name: ex.name.trim(), muscle: ex.muscle || coach.guessMuscle(ex.name), id: ex.id || db.uid('ex-') });
          await loadAll();
          close();
          onSaved && onSaved(saved);
        } }, ex.id ? 'Save exercise' : 'Create exercise'),
        ex.id ? h('button', { class: 'btn danger-ghost block', onclick: async () => {
          const used = (histIndex().get(ex.id) || []).length;
          const ok = await confirmSheet(used ? `Delete ${ex.name}? Its ${used} logged session(s) stay in History but it disappears from Progress and routines.` : `Delete ${ex.name}?`, { ok: 'Delete', danger: true });
          if (!ok) return;
          await db.remove('exercises', ex.id);
          for (const rt of S.routines) {
            if (rt.items.some((i) => i.exerciseId === ex.id)) await db.put('routines', { ...rt, items: rt.items.filter((i) => i.exerciseId !== ex.id) });
          }
          await loadAll();
          close();
          go('#/progress');
        } }, 'Delete exercise') : null);
    };
    draw();
    return wrap;
  }, { title: ex.id ? 'Edit exercise' : 'New exercise' });
}

// ================================================================= ROUTINE EDITOR
async function viewRoutine(id) {
  const existing = id && id !== 'new' ? S.routines.find((r) => r.id === id) : null;
  setTitle(existing ? 'Edit routine' : 'New routine');
  const rt = existing ? structuredClone(existing) : { id: db.uid('rt-'), name: '', order: S.routines.length + 1, items: [] };
  const wrap = h('div', { class: 'page stack' });
  const draw = () => {
    fill(wrap, 
      h('label', { class: 'field' }, h('span', null, 'Routine name'), h('input', { value: rt.name, placeholder: 'e.g. Upper A', oninput: (e) => (rt.name = e.target.value) })),
      rt.items.length ? rt.items.map((it, i) => {
        const ex = exById(it.exerciseId);
        return h('div', { class: 'card routine-item' },
          h('div', { class: 'row between' }, h('strong', null, ex.name),
            h('div', { class: 'row' },
              h('button', { class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0 ? true : null, onclick: () => { [rt.items[i - 1], rt.items[i]] = [rt.items[i], rt.items[i - 1]]; draw(); } }, '↑'),
              h('button', { class: 'icon-btn', 'aria-label': 'Move down', disabled: i === rt.items.length - 1 ? true : null, onclick: () => { [rt.items[i + 1], rt.items[i]] = [rt.items[i], rt.items[i + 1]]; draw(); } }, '↓'),
              h('button', { class: 'icon-btn', 'aria-label': 'Remove', onclick: () => { rt.items.splice(i, 1); draw(); } }, '✕'))),
          h('div', { class: 'routine-fields' },
            h('label', { class: 'field mini' }, h('span', null, 'Sets'), numInput({ value: it.sets, decimal: false, label: 'Sets', onInput: (v) => (it.sets = v || 1) })),
            h('label', { class: 'field mini' }, h('span', null, 'Reps'), h('input', { value: it.reps || '', placeholder: '8–10', oninput: (e) => (it.reps = e.target.value) })),
            h('label', { class: 'field mini' }, h('span', null, 'Superset'),
              h('select', { onchange: (e) => (it.group = e.target.value || null) }, ['', 'A', 'B', 'C', 'D'].map((g) => h('option', { value: g, selected: (it.group || '') === g ? 'selected' : null }, g || 'None'))))),
          h('label', { class: 'field mini' }, h('span', null, 'Note'), h('input', { value: it.note || '', placeholder: 'RPE 8, tempo 3-1-1…', oninput: (e) => (it.note = e.target.value) })));
      }) : h('p', { class: 'muted' }, 'No exercises yet.'),
      h('button', { class: 'btn ghost block', onclick: () => pickExercise((ex) => { rt.items.push({ exerciseId: ex.id, sets: 3, reps: '8–10', group: null }); draw(); }) }, '+ Add exercise'),
      h('button', { class: 'btn primary block', onclick: async () => {
        if (!rt.name.trim()) return toast('Name the routine');
        await db.put('routines', { ...rt, name: rt.name.trim() });
        await loadAll();
        toast('Routine saved');
        go('#/train');
      } }, 'Save routine'),
      existing ? h('button', { class: 'btn danger-ghost block', onclick: async () => {
        const ok = await confirmSheet(`Delete the routine "${rt.name}"? Past workouts stay in History.`, { ok: 'Delete', danger: true });
        if (!ok) return;
        await db.remove('routines', rt.id);
        await loadAll();
        go('#/train');
      } }, 'Delete routine') : null);
  };
  draw();
  return wrap;
}

// ================================================================= TRAINING PLAN (PDF / photo)
const planMeta = (p) => `${p.pages} page${p.pages === 1 ? '' : 's'}, added ${fmtDate(p.addedAt || p.updatedAt, { month: 'short', day: 'numeric', year: 'numeric' })}`;

function planCard() {
  if (S.plan) {
    return h('button', { class: 'card plan-card', onclick: () => go('#/plan') },
      h('span', { class: 'plan-ico', 'aria-hidden': 'true' }, DOC_ICON()),
      h('span', { class: 'plan-text' }, h('span', { class: 'card-title' }, 'Your plan'), h('span', { class: 'muted small ellip' }, S.plan.name)),
      h('span', { class: 'btn small ghost' }, 'Open'));
  }
  return h('div', { class: 'card plan-card empty' },
    h('span', { class: 'plan-ico', 'aria-hidden': 'true' }, DOC_ICON()),
    h('span', { class: 'plan-text' }, h('span', { class: 'card-title' }, 'Have a written plan?'), h('span', { class: 'muted small' }, 'Add the PDF or a photo so it’s one tap away at the gym.')),
    h('button', { class: 'btn small primary', onclick: pickPlanFile }, 'Add plan'));
}

function DOC_ICON() {
  const el = h('span', { class: 'ico' });
  el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
  return el;
}

function pickPlanFile(after = null) {
  if (typeof after !== 'function') after = null; // used directly as an onclick handler, it gets the click event
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf,image/*', style: { display: 'none' } });
  input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) importPlanFile(f, after); });
  document.body.appendChild(input);
  input.click();
}

async function importPlanFile(file, after = null) {
  if (typeof after !== 'function') after = null;
  const bad = plan.checkFile(file);
  if (bad) return toast(bad, 'err');
  if (S.plan && !after) {
    const ok = await confirmSheet(`Replace "${S.plan.name}" with "${file.name}"?`, { ok: 'Replace' });
    if (!ok) return;
  }
  const step = h('p', { class: 'muted' }, 'Reading file…');
  const close = sheet(h('div', { class: 'stack plan-progress' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), step), { title: 'Adding your plan' });
  try {
    const rec = await plan.importPlan(file, (t) => (step.textContent = t));
    step.textContent = 'Looking for workouts…';
    const found = await plan.readWorkouts(rec).catch((e) => { console.warn('plan read', e); return { days: [] }; });
    await loadAll();
    close();
    if (after) { await after(rec, found); return; }
    go('#/plan');
    if (found.days.length) openPlanReview(found, rec);
    else toast(noWorkoutsMsg(found), '');
  } catch (e) {
    console.error(e);
    close();
    toast(/password/i.test(e?.message || '') ? 'That PDF is password-protected. Save a copy without a password and try again.' : `Couldn’t read that file: ${e?.message || e}`, 'err');
  }
}

let planUrls = null;
function releasePlanUrls() { planUrls?.revoke(); planUrls = null; }

/** Page images for the plan, filled in once they're ready. */
function planPages() {
  const box = h('div', { class: 'plan-pages' }, h('p', { class: 'muted' }, 'Loading pages…'));
  const p = S.plan;
  releasePlanUrls();
  plan.pageUrls(p, (t) => fill(box, h('p', { class: 'muted' }, t))).then((res) => {
    planUrls = res;
    if (res.missing) {
      fill(box, h('div', { class: 'card stack' },
        h('h3', null, 'Your plan is still on its way'),
        h('p', { class: 'muted small' }, sync.status().user
          ? 'It was added on another phone and hasn’t downloaded yet. It needs a connection.'
          : 'It was added on another phone. Turn on sync in Settings to bring it here.'),
        sync.status().user ? h('button', { class: 'btn small', onclick: onSyncTap }, 'Sync now') : null));
      return;
    }
    fill(box, res.urls.map((u, i) => h('button', { class: 'plan-page', 'aria-label': `Page ${i + 1} of ${res.urls.length}. Tap to zoom.`, onclick: () => zoomPage(u) },
      h('img', { src: u, alt: `Plan page ${i + 1}`, decoding: 'async', loading: i > 1 ? 'lazy' : 'eager' }))));
  }).catch((e) => { console.error(e); fill(box, h('p', { class: 'muted' }, `Couldn’t show the plan: ${e?.message || e}`)); });
  return box;
}

function zoomPage(url) {
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => e.key === 'Escape' && close();
  const ov = h('div', { class: 'zoom-overlay', role: 'dialog', 'aria-label': 'Zoomed page' },
    h('div', { class: 'zoom-scroll' }, h('img', { src: url, alt: 'Plan page, zoomed' })),
    h('button', { class: 'icon-btn zoom-x', 'aria-label': 'Close', onclick: close }, '✕'));
  document.body.appendChild(ov);
  document.addEventListener('keydown', esc);
}

async function sharePlan() {
  const f = await plan.originalFile(S.plan);
  if (!f) return toast('The file isn’t on this phone yet');
  try {
    if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: S.plan.name }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  const url = URL.createObjectURL(f);
  const a = h('a', { href: url, download: f.name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function viewPlan() {
  setTitle('Plan');
  if (!S.plan) {
    return h('div', { class: 'page stack' },
      h('div', { class: 'card stack' },
        h('h3', null, 'No plan added yet'),
        h('p', { class: 'muted small' }, 'Add your program as a PDF, or a photo or screenshot of it. It’s saved on this phone and, with sync on, on your account too.'),
        h('button', { class: 'btn primary block', onclick: pickPlanFile }, 'Add plan')));
  }
  const p = S.plan;
  return h('div', { class: 'page stack' },
    h('div', { class: 'plan-head' },
      h('div', { class: 'plan-title' }, h('h2', { class: 'big-title' }, p.name.replace(/\.pdf$/i, '')), h('div', { class: 'muted small' }, planMeta(p))),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn small', onclick: sharePlan }, 'Share / Save'),
        h('button', { class: 'btn small ghost', onclick: pickPlanFile }, 'Replace'),
        h('button', { class: 'btn small danger-ghost', onclick: async () => {
          const ok = await confirmSheet(`Remove "${p.name}" from the app? Your workouts aren't affected.`, { ok: 'Remove', danger: true });
          if (!ok) return;
          releasePlanUrls();
          await plan.removePlan();
          await loadAll();
          toast('Plan removed');
          render();
        } }, 'Remove'))),
    /pdf/.test(p.type || '') ? h('div', { class: 'card plan-routines' },
      h('div', { class: 'stack tight' },
        h('strong', null, planRoutineCount() ? `${planRoutineCount()} routine${planRoutineCount() === 1 ? '' : 's'} made from this plan` : 'Turn this plan into routines'),
        h('span', { class: 'muted small' }, 'Reads the workouts, exercises, sets and reps so they’re ready to start on the Train tab.')),
      h('button', { class: 'btn small primary', onclick: () => readPlanIntoRoutines() }, planRoutineCount() ? 'Update' : 'Set up')) : null,
    h('p', { class: 'muted tiny' }, 'Tap a page to zoom in.'),
    planPages());
}

const planRoutineCount = () => (S.plan ? S.routines.filter((r) => r.fromPlan === S.plan.hash).length : 0);
const noWorkoutsMsg = (found) => found.hasText === false
  ? 'Plan saved. It looks like a scan or photo, so it can’t be read into routines. You can still view it here.'
  : 'Plan saved, but no sets and reps were found to turn into routines. You can still view it here.';

async function readPlanIntoRoutines() {
  const step = h('p', { class: 'muted' }, 'Reading your plan…');
  const close = sheet(h('div', { class: 'stack plan-progress' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), step), { title: 'Reading your plan' });
  const found = await plan.readWorkouts(S.plan).catch((e) => { console.warn(e); return { days: [] }; });
  close();
  if (!found.days.length) return toast(noWorkoutsMsg(found).replace(/^Plan saved(, but|\.)\s*/i, '').replace(/^./, (c) => c.toUpperCase()));
  openPlanReview(found, S.plan);
}

/** Show what was read from the plan; the person fixes anything off, then routines are made. */
function openPlanReview(found, planRec, { onDone } = {}) {
  const lib = [...S.exercises.values()].filter((e) => !e.deleted);
  const days = found.days.map((d) => ({
    name: PP.tidyName(d.name), include: true,
    items: d.items.map((it) => {
      const name = PP.tidyName(it.name);
      return { ...it, name, match: it.cardio ? (lib.find((e) => e.loadType === 'cardio' && PP.similarity(name, e.name) >= 0.5) || PP.matchExercise(name, lib)?.ex || null) : (PP.matchExercise(name, lib)?.ex || null) };
    }),
  }));
  const fromLast = S.routines.filter((r) => r.fromPlan);
  let mode = fromLast.length ? 'plan' : realWorkouts().length ? 'add' : 'all';
  sheet((close) => {
    const wrap = h('div', { class: 'stack plan-review' });
    const draw = () => {
      const included = days.filter((d) => d.include && d.items.length);
      const newCount = new Set(included.flatMap((d) => d.items.filter((i) => !i.match).map((i) => i.name.toLowerCase()))).size;
      const modes = [
        fromLast.length ? ['plan', `Replace the ${fromLast.length} routine${fromLast.length === 1 ? '' : 's'} from your last plan`, 'Routines you made yourself stay.'] : null,
        ['all', 'Replace all my routines', 'Past workouts stay in History.'],
        ['add', 'Add them next to my routines', null],
      ].filter(Boolean);
      fill(wrap,
        h('p', { class: 'muted small' }, `Found ${days.length} workout${days.length === 1 ? '' : 's'} in “${planRec.name}”.${found.weeks > 1 ? ` It covers ${found.weeks} weeks; these are the first week’s workouts.` : ''} Check them over: tap an exercise to change what it’s matched to.`),
        days.map((d, di) => h('div', { class: `card stack review-day ${d.include ? '' : 'off'}` },
          h('div', { class: 'row gap' },
            h('input', { type: 'checkbox', checked: d.include, 'aria-label': `Include ${d.name}`, onchange: (e) => { d.include = e.target.checked; draw(); } }),
            h('input', { class: 'review-day-name', value: d.name, 'aria-label': 'Routine name', oninput: (e) => (d.name = e.target.value) })),
          d.items.length ? h('div', { class: 'review-item head', 'aria-hidden': 'true' }, h('span', null, 'Exercise'), h('span', null, 'Sets'), h('span', null, 'Reps'), h('span')) : null,
          d.items.map((it, ii) => h('div', { class: 'review-item' },
            h('button', { class: 'review-ex', onclick: () => pickExercise((ex) => { it.match = ex; draw(); }, it.name) },
              h('span', { class: 'review-name' }, it.name),
              h('span', { class: `review-match ${it.match ? '' : 'new'}` }, it.match ? (it.match.name.toLowerCase() === it.name.toLowerCase() ? 'In your library' : `→ ${it.match.name}`) : 'New exercise'),
              it.group || it.note ? h('span', { class: 'muted tiny' }, [it.group ? `Superset ${it.group}` : '', it.note].filter(Boolean).join(', ')) : null),
            h('input', { class: 'num mini-num', inputmode: 'numeric', value: it.sets, 'aria-label': `${it.name} sets`, oninput: (e) => (it.sets = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 1))) }),
            h('input', { class: 'mini-reps', value: it.reps, 'aria-label': `${it.name} reps`, oninput: (e) => (it.reps = e.target.value) }),
            h('button', { class: 'icon-btn sm', 'aria-label': `Remove ${it.name}`, onclick: () => { d.items.splice(ii, 1); draw(); } }, '✕'))),
          d.items.length ? null : h('p', { class: 'muted small' }, 'No exercises left in this one.'))),
        h('div', { class: 'opt-list' }, modes.map(([k, label, hint]) => h('button', { class: `opt ${mode === k ? 'on' : ''}`, onclick: () => { mode = k; draw(); } },
          h('strong', null, label), hint ? h('span', null, hint) : null))),
        newCount ? h('p', { class: 'muted small' }, `${newCount} new exercise${newCount === 1 ? '' : 's'} will be added to your library. You can set how the weight is entered later in Progress → exercise → Edit.`) : null,
        h('button', { class: 'btn primary block big-cta', disabled: included.length ? null : true, onclick: async () => {
          const n = await saveRoutinesFromPlan(included, mode, planRec);
          close();
          toast(`${n} routine${n === 1 ? '' : 's'} ready on the Train tab`);
          if (onDone) onDone(); else go('#/train');
        } }, `Create ${included.length} routine${included.length === 1 ? '' : 's'}`),
        h('button', { class: 'link center', onclick: () => { close(); if (onDone) onDone(); } }, 'Not now'));
    };
    draw();
    return wrap;
  }, { title: 'Set up routines from your plan' });
}

async function saveRoutinesFromPlan(days, mode, planRec) {
  const created = new Map(); // new exercise name → id, so a lift used on two days is created once
  const toRemove = mode === 'all' ? S.routines : mode === 'plan' ? S.routines.filter((r) => r.fromPlan) : [];
  let order = mode === 'add' ? Math.max(0, ...S.routines.map((r) => r.order || 0)) + 1 : 1;
  for (const d of days) {
    const items = [];
    for (const it of d.items) {
      let id = it.match?.id;
      if (!id) {
        const key = it.name.toLowerCase();
        id = created.get(key);
        if (!id) {
          const g = PP.guessLoadType(it.name);
          const ex = await db.put('exercises', { id: db.uid('ex-'), name: it.name, loadType: g.loadType, baseWeight: g.baseWeight, lbsPerPlate: null,
            restSec: it.restSec ?? (g.loadType === 'cardio' ? 0 : S.settings.defaultRest), muscle: coach.guessMuscle(it.name), notes: '' });
          id = ex.id; created.set(key, id);
        }
      }
      const isCardio = (it.match?.loadType || PP.guessLoadType(it.name).loadType) === 'cardio';
      items.push({ exerciseId: id, sets: isCardio ? 1 : it.sets, reps: it.reps || '', group: it.group || null, note: it.note || '' });
    }
    await db.put('routines', { id: db.uid('rt-'), name: d.name.trim() || 'Workout', order: order++, items, fromPlan: planRec.hash });
  }
  for (const r of toRemove) await db.remove('routines', r.id);
  await loadAll();
  return days.length;
}

function openPlanSheet() {
  sheet(h('div', { class: 'stack plan-sheet' }, h('div', { class: 'muted small' }, planMeta(S.plan)), planPages()), { title: S.plan.name.replace(/\.pdf$/i, '') });
}

// ================================================================= COACH
function coachData() {
  if (S.coach) return S.coach;
  S.coach = coach.analyze({
    now: Date.now(), profile: S.profile, settings: S.settings, exercises: S.exercises, routines: S.routines,
    workouts: S.workouts, bodyweight: S.bodyweight, measurements: S.measurements, nextRoutineId: nextRoutine()?.id,
  });
  return S.coach;
}
const visibleItems = () => coachData().items.filter((it) => !(S.snooze[it.id] > Date.now()));
const AREA = { training: 'Training', nutrition: 'Diet', body: 'Body', planning: 'Planning' };

async function snoozeItem(id) {
  S.snooze = { ...S.snooze, [id]: Date.now() + 7 * 86400000 };
  for (const [k, v] of Object.entries(S.snooze)) if (v < Date.now()) delete S.snooze[k];
  await db.setMeta('coachSnooze', S.snooze);
  render();
  toast('Hidden for a week', '', { action: { label: 'Undo', run: async () => { delete S.snooze[id]; await db.setMeta('coachSnooze', S.snooze); render(); } } });
}

function runCoachAction(a) {
  if (!a) return;
  if (a.kind === 'route') go(a.to);
  else if (a.kind === 'start') { const rt = S.routines.find((r) => r.id === a.routineId); if (rt) startFromRoutine(rt); }
  else if (a.kind === 'profile') openProfileSheet();
  else if (a.kind === 'measure') { go('#/body'); setTimeout(() => openMeasureSheet(), 150); }
}

function coachCard(it, { compact = false } = {}) {
  const why = it.why ? h('details', { class: 'coach-why' }, h('summary', null, 'Why'), h('p', null, it.why)) : null;
  const lines = !compact && it.list
    ? h('div', { class: 'coach-list' }, it.list.map((l) => h('div', { class: 'coach-li' }, h('strong', null, l.name), h('span', null, l.text.replace(/^Try /, '')), h('span', { class: 'muted tiny' }, l.detail))))
    : h('p', { class: 'coach-body' }, it.body);
  return h('div', { class: `card coach-card tone-${it.tone}` },
    h('div', { class: 'coach-top' }, h('span', { class: 'coach-area' }, compact ? AREA[it.area] || '' : ''), h('button', { class: 'link coach-hide', 'aria-label': `Hide “${it.title}” for a week`, onclick: () => snoozeItem(it.id) }, 'Not now')),
    h('h3', { class: 'coach-title' }, it.title),
    lines,
    it.action || why ? h('div', { class: 'coach-actions' },
      it.action ? h('button', { class: 'btn small primary', onclick: () => runCoachAction(it.action) }, it.action.label) : null, why) : null);
}

function coachTeaser() {
  const items = visibleItems().filter((it) => it.id !== 'start'); // the hero card already offers the first workout
  if (!items.length) return null;
  const top = items.slice(0, 2);
  return h('div', { class: 'stack coach-teaser' },
    h('div', { class: 'section-head' }, h('h2', null, 'For you'),
      h('button', { class: 'btn small ghost', onclick: () => go('#/coach') }, items.length > 2 ? `All ${items.length}` : 'Coach')),
    top.map((it) => coachCard(it, { compact: true })));
}

async function viewCoach() {
  setTitle('Coach');
  const data = coachData();
  const items = visibleItems();
  const hidden = data.items.length - items.length;
  const areas = ['training', 'nutrition', 'body', 'planning'];
  const unlocked = data.unlocks.filter((u) => u.have >= u.need).length;
  return h('div', { class: 'page stack' },
    h('p', { class: 'muted' }, 'Built from your own workouts, weigh-ins and measurements. The more you log, the more specific it gets.'),
    h('div', { class: 'card stack coach-level' },
      h('div', { class: 'row between' }, h('h3', null, 'What the coach can see'), h('span', { class: 'muted small' }, `${unlocked} of ${data.unlocks.length}`)),
      h('div', { class: 'level-bar coach-bar', role: 'img', 'aria-label': `${unlocked} of ${data.unlocks.length} unlocked` }, data.unlocks.map((u) => h('span', { class: `lseg ${u.have >= u.need ? 'on' : ''}` }))),
      data.unlocks.map((u) => h('div', { class: `unlock ${u.have >= u.need ? 'done' : ''}` },
        h('span', { class: 'unlock-mark', 'aria-hidden': 'true' }, u.have >= u.need ? '✓' : `${u.have}/${u.need}`),
        h('span', null, u.label),
        u.have >= u.need ? null : h('span', { class: 'muted tiny' }, u.hint)))),
    items.length ? null : h('p', { class: 'muted' }, 'Nothing to change right now. Keep logging.'),
    areas.map((a) => {
      const list = items.filter((it) => it.area === a);
      return list.length ? h('div', { class: 'stack' }, h('h2', { class: 'month' }, AREA[a]), list.map((it) => coachCard(it))) : null;
    }),
    hidden ? h('button', { class: 'link center', onclick: async () => { S.snooze = {}; await db.setMeta('coachSnooze', {}); render(); } }, `Show ${hidden} hidden suggestion${hidden === 1 ? '' : 's'}`) : null,
    h('p', { class: 'muted tiny' }, 'Suggestions are general training and nutrition guidance from published research applied to your logs, not medical advice.'));
}

/** "Try 60 lb ea × 6–8" under an exercise in a live workout, with a button that fills it in. */
function nextHint(ex, entry) {
  const hist = historyFor(entry.exerciseId, S.current?.id);
  if (!hist.length) return null;
  const reps = /×\s*([^,]+)/.exec(entry.target || '')?.[1]?.trim() || coach.targetRepsFor(entry.exerciseId, hist, S.routines);
  const nt = coach.nextTarget(ex, hist, reps, S.settings);
  if (!nt || nt.kind === 'reps') return null;
  const open = entry.sets.filter((x) => !x.done && x.type === 'work');
  const a = nt.apply;
  const already = a && open.length && open.every((x) => (a.weight != null && Number(x.weight) === a.weight) || (a.count != null && Number(x.count) === a.count) || (a.plates && calc.sumPlates(x.plates) === calc.sumPlates(a.plates)));
  return h('div', { class: `next-hint kind-${nt.kind}` },
    h('span', { class: 'next-text' }, h('strong', null, nt.title), h('span', { class: 'muted tiny' }, nt.detail)),
    a && open.length && !already ? h('button', { class: 'btn small', onclick: () => {
      for (const x of open) {
        if (a.weight != null) x.weight = a.weight;
        if (a.count != null) x.count = a.count;
        if (a.plates) x.plates = [...a.plates];
      }
      saveNow(); rerender();
    } }, 'Use') : null);
}

// ================================================================= HISTORY
async function viewHistory() {
  setTitle('History');
  const done = S.workouts.filter((w) => w.endedAt);
  if (!done.length) return h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Finished workouts show up here.'));
  let month = '';
  const items = [];
  for (const w of done) {
    const m = new Date(w.startedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (m !== month) { month = m; items.push(h('h2', { class: 'month' }, m)); }
    const sm = summarize(w);
    items.push(h('button', { class: 'card history-card', onclick: () => go(`#/session/${w.id}`) },
      h('div', { class: 'row between' }, h('span', { class: 'card-title' }, w.name || 'Workout'), h('span', { class: 'muted small' }, fmtDate(w.startedAt))),
      h('div', { class: 'muted small' }, `${fmtDuration(w.endedAt - w.startedAt)}, ${sm.sets} sets${sm.volume ? `, ${Math.round(sm.volume).toLocaleString()} lb moved` : ''}`),
      sm.prs.length ? h('div', { class: 'small' }, h('span', { class: 'pr-tag' }, 'PR'), ` ${sm.prs.length} personal record${sm.prs.length > 1 ? 's' : ''}`) : null));
  }
  return h('div', { class: 'page stack' }, items);
}

async function viewSession(id) {
  const w = S.workouts.find((x) => x.id === id);
  setTitle('Workout');
  if (!w) return h('div', { class: 'page' }, h('p', null, 'Not found.'));
  const sm = summarize(w);
  return h('div', { class: 'page stack' },
    h('div', null, h('h2', { class: 'big-title' }, w.name || 'Workout'), h('div', { class: 'muted' }, fmtDate(w.startedAt, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))),
    h('div', { class: 'stat-row' },
      stat(fmtDuration((w.endedAt || Date.now()) - w.startedAt), 'Duration'), stat(String(sm.sets), 'Sets'),
      stat(sm.volume ? Math.round(sm.volume).toLocaleString() : '—', 'Volume (lb)')),
    calc.groupEntries(w.entries).map((b) => h('div', { class: b.group && b.entries.length > 1 ? 'superset' : '' },
      b.group && b.entries.length > 1 ? h('div', { class: 'superset-label' }, `Superset ${b.group}`) : null,
      b.entries.map(({ entry }) => {
        const ex = exById(entry.exerciseId);
        let n = 0;
        return h('div', { class: 'card' },
          h('button', { class: 'link-title', onclick: () => !ex.missing && go(`#/exercise/${ex.id}`) }, ex.name),
          entry.sets.map((s) => h('div', { class: `hist-set ${s.type}` },
            h('span', { class: `badge sm ${s.type}` }, s.type === 'work' ? String(++n) : s.type === 'warmup' ? 'W' : 'D'),
            h('span', null, calc.formatSet(ex, s)),
            s.pr?.length ? h('span', { class: 'pr-tag' }, 'PR') : null)));
      }))),
    w.notes ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Notes'), h('p', { class: 'pre' }, w.notes)) : null,
    h('div', { class: 'row gap' },
      h('button', { class: 'btn ghost grow', onclick: () => { S.current = null; go(`#/workout/${w.id}`); } }, 'Edit'),
      h('button', { class: 'btn ghost grow', onclick: () => startWorkout({ name: w.name, routineId: w.routineId, entries: w.entries.map((e) => buildEntry(e.exerciseId, e.sets.filter((s) => s.type === 'work').length, e.group)) }) }, 'Repeat')),
    h('button', { class: 'btn danger-ghost block', onclick: () => deleteWorkout(w.id) }, 'Delete workout'));
}

// ================================================================= PROGRESS
function seriesFor(ex) {
  const metric = calc.progressMetric(ex);
  const rows = [...(histIndex().get(ex.id) || [])].reverse(); // oldest first
  const points = [];
  let unit = metric.unit;
  for (const r of rows) {
    const b = calc.sessionBest(ex, r.entry);
    const y = b[metric.key];
    if (y === null || y === undefined) continue;
    if (!unit) unit = b.unit === 'plates' ? 'plates' : 'lb';
    const top = r.entry.sets.filter(calc.isCompletedWorkSet).sort((a, b2) => (calc.e1rm(calc.setLoad(ex, b2).value, b2.reps) || 0) - (calc.e1rm(calc.setLoad(ex, a).value, a.reps) || 0))[0];
    points.push({ x: r.at, y, note: top ? `Best set: ${calc.formatSet(ex, top)}` : '' });
  }
  return { metric, unit: unit || 'lb', points };
}

async function viewProgress() {
  setTitle('Progress');
  const list = h('div', { class: 'stack' });
  const q = h('input', { class: 'search', type: 'search', placeholder: 'Search exercises', 'aria-label': 'Search exercises', oninput: () => draw() });
  const rows = sortedExercises().map((ex) => {
    const sr = seriesFor(ex);
    const hist = histIndex().get(ex.id) || [];
    return { ex, sr, lastAt: hist[0]?.at || 0 };
  });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const filt = rows.filter((r) => !term || r.ex.name.toLowerCase().includes(term));
    const logged = filt.filter((r) => r.sr.points.length).sort((a, b) => b.lastAt - a.lastAt);
    const unlogged = filt.filter((r) => !r.sr.points.length);
    fill(list, 
      logged.length ? h('h2', { class: 'month' }, 'Logged') : null,
      logged.map(({ ex, sr, lastAt }) => {
        const lvl = levelFor(ex);
        const first = sr.points[0].y; const last = sr.points[sr.points.length - 1].y;
        const best = Math.max(...sr.points.map((p) => p.y));
        const delta = last - first;
        return h('button', { class: 'card progress-row', onclick: () => go(`#/exercise/${ex.id}`) },
          h('div', null, h('div', { class: 'card-title' }, ex.name), h('div', { class: 'muted small' }, `Last ${fmtDate(lastAt, { month: 'short', day: 'numeric' })}, ${sr.points.length} session${sr.points.length > 1 ? 's' : ''}`),
            lvl ? h('span', { class: `level-chip lv${lvl.idx}` }, lvl.level) : null),
          h('div', { class: 'progress-num' },
            h('div', { class: 'big-num' }, `${calc.fmtNum(best)}`, h('span', { class: 'unit' }, ` ${sr.unit}`)),
            h('div', { class: `small ${delta > 0 ? 'up' : 'muted'}` }, sr.points.length > 1 ? `${delta > 0 ? '▲ +' : delta < 0 ? '▼ −' : '± '}${calc.fmtNum(Math.round(Math.abs(delta) * 10) / 10)} since first` : sr.metric.key === 'e1rm' ? 'best est. 1RM' : 'best')));
      }),
      unlogged.length ? h('h2', { class: 'month' }, 'Not logged yet') : null,
      unlogged.map(({ ex }) => h('button', { class: 'pick-item', onclick: () => go(`#/exercise/${ex.id}`) }, h('span', null, ex.name), h('span', { class: 'muted small' }, calc.LOAD_TYPES[ex.loadType]?.label || ''))));
  };
  draw();
  return h('div', { class: 'page stack' }, q, list,
    h('button', { class: 'btn ghost block', onclick: () => exerciseForm({}, () => render()) }, '+ New exercise'));
}

async function viewExercise(id) {
  const ex = S.exercises.get(id);
  setTitle('Exercise');
  if (!ex) return h('div', { class: 'page' }, h('p', null, 'Exercise not found.'));
  const sr = seriesFor(ex);
  const hist = histIndex().get(ex.id) || [];
  const fmt = (v) => `${calc.fmtNum(v)} ${sr.unit}`;

  // records
  let bestE = null; let heavy = null; let mostReps = null;
  for (const r of hist) {
    for (const s of r.entry.sets) {
      if (!calc.isCompletedWorkSet(s)) continue;
      const L = calc.setLoad(ex, s);
      const est = calc.e1rm(L.value, s.reps);
      if (est !== null && (!bestE || est > bestE.v)) bestE = { v: est, s, at: r.at };
      if (L.value !== null && (!heavy || L.value > heavy.v || (L.value === heavy.v && s.reps > heavy.s.reps))) heavy = { v: L.value, s, at: r.at };
      if (s.reps !== null && (!mostReps || s.reps > mostReps.v)) mostReps = { v: s.reps, s, at: r.at };
    }
  }
  const rec = (label, r, valueText) => r ? h('div', { class: 'record' },
    h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-val' }, valueText),
    h('div', { class: 'muted small' }, `${calc.formatSet(ex, r.s)} on ${fmtDate(r.at, { month: 'short', day: 'numeric', year: 'numeric' })}`)) : null;

  const isCardio = ex.loadType === 'cardio';
  return h('div', { class: 'page stack' },
    h('div', { class: 'row between' },
      h('div', null, h('h2', { class: 'big-title' }, ex.name), h('div', { class: 'muted small' }, [ex.muscle, calc.LOAD_TYPES[ex.loadType]?.label, ex.loadType === 'plates' ? `base ${calc.fmtNum(ex.baseWeight || 0)} lb` : null, ex.loadType === 'stack' && ex.lbsPerPlate ? `${ex.lbsPerPlate} lb/plate` : null].filter(Boolean).join(', '))),
      h('button', { class: 'btn small ghost', onclick: () => exerciseForm(structuredClone(ex), () => render()) }, 'Edit')),
    ex.notes ? h('p', { class: 'muted pre' }, ex.notes) : null,
    strengthCard(ex),
    h('div', { class: 'card' },
      h('div', { class: 'chart-title' }, sr.metric.key === 'e1rm' ? `Estimated 1-rep max (${sr.unit}) per session` : `${sr.metric.label} per session`),
      sr.metric.key === 'e1rm' ? h('div', { class: 'muted small' }, 'Best working set each session, Epley formula. Warm-ups and drops excluded.') : null,
      lineChart({ series: [{ name: sr.metric.label, color: 'var(--series-1)', points: sr.points }], fmt, ariaLabel: `${ex.name} ${sr.metric.label}` })),
    isCardio ? null : h('div', { class: 'records' },
      rec('Best est. 1RM', bestE, bestE ? fmt(bestE.v) : ''),
      rec('Heaviest set', heavy, heavy ? fmt(heavy.v) : ''),
      rec('Most reps', mostReps, mostReps ? `${mostReps.v} reps` : '')),
    h('h2', { class: 'month' }, 'Sessions'),
    hist.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Working sets'), h('th', { class: 'num-col' }, sr.metric.key === 'e1rm' ? 'e1RM' : 'Best'))),
      h('tbody', null, hist.map((r) => {
        const b = calc.sessionBest(ex, r.entry);
        return h('tr', { onclick: () => go(`#/session/${r.workout.id}`) },
          h('td', null, fmtDate(r.at, { month: 'short', day: 'numeric' })),
          h('td', null, r.entry.sets.filter(calc.isCompletedWorkSet).map((s) => calc.formatSet(ex, s)).join(', ')),
          h('td', { class: 'num-col' }, b[sr.metric.key] !== null ? calc.fmtNum(b[sr.metric.key]) : '—'));
      })))) : h('p', { class: 'muted' }, 'Not logged yet.'));
}

// ================================================================= PROFILE
const LEN_UNIT = () => (S.profile.units === 'imperial' ? 'in' : 'cm');
const toCm = (v) => (v === null ? null : S.profile.units === 'imperial' ? B.inToCm(v) : v);
const fromCm = (cm) => (cm === null || cm === undefined ? null : Math.round((S.profile.units === 'imperial' ? B.cmToIn(cm) : cm) * 10) / 10);

/** Profile editor used by the welcome flow and the Settings/Body sheets. Calls onSave(patch, weightLb). */
function profileEditor({ submitLabel = 'Save', onSave, onSkip } = {}) {
  const p = { ...S.profile };
  const st = {
    name: p.name || '', sex: p.sex || '', age: B.ageOf(p) ?? null, units: p.units || 'metric',
    cm: p.heightCm || null, weight: latestBW(), goal: p.goal || 'maintain', activity: p.activity || 'moderate',
  };
  const wrap = h('div', { class: 'stack profile-editor' });
  const draw = () => {
    const ftIn = st.cm ? Math.round(B.cmToIn(st.cm)) : null;
    const heightField = st.units === 'imperial'
      ? h('div', { class: 'row gap' },
        numInput({ value: ftIn !== null ? Math.floor(ftIn / 12) : null, placeholder: 'ft', label: 'Height feet', decimal: false, onInput: (v) => { const inch = ftIn !== null ? ftIn % 12 : 0; st.cm = v !== null ? B.inToCm(v * 12 + inch) : null; } }),
        numInput({ value: ftIn !== null ? ftIn % 12 : null, placeholder: 'in', label: 'Height inches', decimal: false, onInput: (v) => { const ft = st.cm ? Math.floor(Math.round(B.cmToIn(st.cm)) / 12) : 0; st.cm = B.inToCm(ft * 12 + (v || 0)); } }))
      : numInput({ value: st.cm ? Math.round(st.cm) : null, placeholder: 'cm', label: 'Height in centimetres', decimal: false, onInput: (v) => (st.cm = v) });
    fill(wrap,
      h('label', { class: 'field' }, h('span', null, 'Name (optional)'), h('input', { value: st.name, autocomplete: 'given-name', oninput: (e) => (st.name = e.target.value) })),
      h('div', { class: 'field' }, h('span', null, 'Sex (for calorie and strength formulas)'),
        h('div', { class: 'seg' }, [['male', 'Male'], ['female', 'Female']].map(([k, l]) => h('button', { class: `seg-btn ${st.sex === k ? 'on' : ''}`, onclick: () => { st.sex = k; draw(); } }, l)))),
      h('div', { class: 'row gap' },
        h('label', { class: 'field grow' }, h('span', null, 'Age'), numInput({ value: st.age, placeholder: 'years', label: 'Age', decimal: false, onInput: (v) => (st.age = v) })),
        h('label', { class: 'field grow' }, h('span', null, 'Weight (lb)'), numInput({ value: st.weight, placeholder: 'lb', label: 'Bodyweight in pounds', onInput: (v) => (st.weight = v) }))),
      h('div', { class: 'field' },
        h('div', { class: 'row between' }, h('span', null, 'Height'),
          h('div', { class: 'seg mini' }, [['metric', 'cm'], ['imperial', 'ft/in']].map(([k, l]) => h('button', { class: `seg-btn ${st.units === k ? 'on' : ''}`, onclick: () => { st.units = k; draw(); } }, l)))),
        heightField),
      h('div', { class: 'field' }, h('span', null, 'Goal'),
        h('div', { class: 'opt-grid' }, Object.entries(B.GOALS).map(([k, g]) => h('button', { class: `opt ${st.goal === k ? 'on' : ''}`, onclick: () => { st.goal = k; draw(); } },
          h('strong', null, g.label), h('span', null, g.note))))),
      h('div', { class: 'field' }, h('span', null, 'How active are you outside the gym?'),
        h('div', { class: 'opt-list' }, Object.entries(B.ACTIVITY).map(([k, a]) => h('button', { class: `opt ${st.activity === k ? 'on' : ''}`, onclick: () => { st.activity = k; draw(); } },
          h('strong', null, a.label), h('span', null, a.note))))),
      h('button', { class: 'btn primary block big-cta', onclick: async () => {
        if (st.age !== null && (st.age < 13 || st.age > 100)) return toast('Check your age');
        if (st.cm !== null && (st.cm < 120 || st.cm > 230)) return toast('Check your height');
        if (st.weight !== null && (st.weight < 60 || st.weight > 700)) return toast('Enter your weight in lb');
        const patch = {
          name: st.name.trim(), sex: st.sex, units: st.units, heightCm: st.cm ? Math.round(st.cm * 10) / 10 : null,
          birthYear: st.age ? new Date().getFullYear() - st.age : null, goal: st.goal, activity: st.activity,
        };
        await onSave(patch, st.weight);
      } }, submitLabel),
      onSkip ? h('button', { class: 'link center', onclick: onSkip }, 'Skip for now') : null);
  };
  draw();
  return wrap;
}

async function saveProfileAndWeight(patch, weightLb) {
  await db.saveProfile(patch);
  if (weightLb && weightLb !== latestBW()) {
    const d = todayISO();
    const existing = S.bodyweight.find((b) => b.date === d);
    await db.put('bodyweight', { id: existing?.id || `bw-${d}`, date: d, weight: weightLb });
  }
  await loadAll();
}

function openProfileSheet() {
  sheet((close) => profileEditor({
    onSave: async (patch, w) => { await saveProfileAndWeight(patch, w); close(); toast('Profile saved'); render(); },
  }), { title: 'Your profile' });
}

// ================================================================= WELCOME (first launch)
const W = { step: 0, plan: 'upperlower' };
async function viewWelcome() {
  setTitle('Welcome');
  if (S.seeded) { location.replace('#/train'); return h('div'); }
  const finish = async () => {
    if (W.plan === 'mine') {
      // pick the file inside this tap (iOS only opens the picker from a direct tap)
      pickPlanFile(async (rec, found) => {
        await seedNewUser('empty');
        S.seeded = true;
        await loadAll();
        W.step = 0;
        if (found.days.length) { location.replace('#/train'); openPlanReview(found, rec); }
        else { location.replace('#/plan'); toast(noWorkoutsMsg(found)); }
      });
      return;
    }
    await seedNewUser(W.plan);
    S.seeded = true;
    await loadAll();
    W.step = 0;
    location.replace('#/train');
    toast(S.profile.name ? `You’re set, ${S.profile.name}` : 'You’re set — start your first workout');
  };
  if (W.step === 0) {
    return h('div', { class: 'page stack welcome' },
      h('div', { class: 'welcome-hero' },
        h('div', { class: 'hero-name' }, 'Lift. Log. Level up.'),
        h('p', { class: 'hero-meta' }, 'Track every set, see your strength level, and get calorie targets that fit your goal. Everything is saved on this phone first.')),
      h('button', { class: 'btn primary block big-cta', onclick: () => { W.step = 1; render(); } }, 'Set me up'),
      h('div', { class: 'card stack' },
        h('strong', null, 'Already use Gym Tracker?'),
        h('p', { class: 'muted small' }, 'Bring your log over from your other phone.'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn grow', onclick: openSyncSheet }, 'Sign in to sync'),
          h('button', { class: 'btn ghost grow', onclick: importBackup }, 'Import backup'))));
  }
  if (W.step === 1) {
    return h('div', { class: 'page stack welcome' },
      h('div', { class: 'step-dots', 'aria-label': 'Step 1 of 2' }, h('span', { class: 'on' }), h('span')),
      h('h2', { class: 'big-title' }, 'About you'),
      h('p', { class: 'muted' }, 'Used for calorie and protein targets and to rate your lifts against people your size. You can change it any time in Settings.'),
      profileEditor({
        submitLabel: 'Continue',
        onSave: async (patch, w) => { await saveProfileAndWeight(patch, w); W.step = 2; render(); },
        onSkip: () => { W.step = 2; render(); },
      }));
  }
  return h('div', { class: 'page stack welcome' },
    h('div', { class: 'step-dots', 'aria-label': 'Step 2 of 2' }, h('span', { class: 'on' }), h('span', { class: 'on' })),
    h('h2', { class: 'big-title' }, 'Pick a starter plan'),
    h('p', { class: 'muted' }, 'You can edit every routine, or build your own later.'),
    h('div', { class: 'opt-list' }, Object.entries(TEMPLATES).map(([k, t]) => h('button', { class: `opt plan ${W.plan === k ? 'on' : ''}`, onclick: () => { W.plan = k; render(); } },
      h('strong', null, t.label), h('span', null, t.desc),
      t.routines.length ? h('span', { class: 'plan-days' }, t.routines.map((r) => r.name).join(', ')) : null)),
      h('button', { class: `opt plan ${W.plan === 'mine' ? 'on' : ''}`, onclick: () => { W.plan = 'mine'; render(); } },
        h('strong', null, 'Use my own plan'), h('span', null, 'Upload your program as a PDF. The app reads the workouts, sets and reps into routines you can check first.'))),
    h('button', { class: 'btn primary block big-cta', onclick: finish }, W.plan === 'mine' ? 'Choose my plan PDF' : 'Start training'),
    h('button', { class: 'link center', onclick: () => { W.step = 1; render(); } }, 'Back'));
}

// ================================================================= STRENGTH LEVEL
/** Best estimated max for comparing against standards (pull-ups include bodyweight). */
function levelValue(ex, bw) {
  const std = B.standardFor(ex);
  if (!std) return null;
  let best = null;
  for (const r of histIndex().get(ex.id) || []) {
    for (const s of r.entry.sets) {
      if (!calc.isCompletedWorkSet(s) || !s.reps) continue;
      const L = calc.setLoad(ex, s);
      if (L.unit !== 'lb' || L.value === null) continue;
      const load = std.key === 'pullup' ? bw + L.value : L.value;
      const est = calc.e1rm(load, Math.min(s.reps, 15));
      if (est !== null && (best === null || est > best)) best = est;
    }
  }
  return best;
}

function levelFor(ex) {
  const std = B.standardFor(ex);
  const bw = latestBW();
  const sex = S.profile.sex;
  if (!std || !bw || !sex) return null;
  const v = levelValue(ex, bw);
  return v ? { ...B.strengthLevel(std.key, sex, bw, v, std.factor), std, value: v, bw } : null;
}

function strengthCard(ex) {
  const std = B.standardFor(ex);
  if (!std) return null;
  const bw = latestBW();
  if (!S.profile.sex || !bw) {
    return h('div', { class: 'card stack' }, h('h3', null, 'Strength level'),
      h('p', { class: 'muted small' }, 'Add your sex and bodyweight to see how this lift compares with lifters your size.'),
      h('button', { class: 'btn small', onclick: openProfileSheet }, 'Set up profile'));
  }
  const L = levelFor(ex);
  if (!L) return h('div', { class: 'card stack' }, h('h3', null, 'Strength level'), h('p', { class: 'muted small' }, 'Log a working set to see your level.'));
  const isPull = std.key === 'pullup';
  const pos = Math.max(0, Math.min(5, L.idx + 1 + (L.idx < 4 ? L.pctToNext : 0))) / 5;
  const nextText = L.next
    ? isPull
      ? `Next: ${L.nextLevel} at about +${Math.max(0, Math.round(L.next - bw))} lb for 1 rep (or ${Math.max(1, Math.round((L.next / bw - 1) * 30))} bodyweight reps)`
      : `Next: ${L.nextLevel} at ${Math.round(L.next)} lb est. 1RM${ex.loadType === 'dumbbell' ? ' per dumbbell' : ''}`
    : 'Top level. Elite for your bodyweight.';
  return h('div', { class: 'card stack level-card' },
    h('div', { class: 'row between' }, h('h3', null, 'Strength level'), h('span', { class: 'muted small' }, `${L.ratio.toFixed(2)}× bodyweight`)),
    h('div', { class: `level-name lv${L.idx}` }, L.level),
    h('div', { class: 'level-bar', role: 'img', 'aria-label': `${L.level}, ${Math.round(pos * 100)}% of the way to Elite` },
      B.LEVELS.map((n, i) => h('span', { class: `lseg ${i <= L.idx ? 'on' : ''}` }, h('em', null, n.slice(0, 3)))),
      h('i', { class: 'marker', style: { left: `${pos * 100}%` } })),
    h('div', { class: 'small' }, nextText),
    h('div', { class: 'muted small' }, `Compared with ${S.profile.sex} lifters at ${calc.fmtNum(bw)} lb (StrengthLevel.com data${L.approx ? ', estimated' : ''}). Best est. 1RM: ${Math.round(L.value)} lb${isPull ? ' incl. bodyweight' : ''}.`));
}

// ================================================================= BODY (weight, targets, measurements)
function targetsCard() {
  const bw = latestBW();
  const p = S.profile;
  if (!B.profileComplete(p, bw)) {
    return h('div', { class: 'card stack' }, h('h3', null, 'Daily targets'),
      h('p', { class: 'muted small' }, 'Add your sex, age, height and weight to get calorie and protein targets for your goal.'),
      h('button', { class: 'btn primary block', onclick: openProfileSheet }, 'Set up profile'));
  }
  const t = B.targets(p, bw);
  const pts = [...S.bodyweight].sort((a, b) => a.date.localeCompare(b.date));
  const rate = B.weeklyRate(pts);
  const adv = B.trendAdvice(rate, t);
  const fmtRate = (r) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} lb/week`;
  const [lo, hi] = t.rateRange;
  let trend;
  if (rate === null) trend = h('div', { class: 'trend muted small' }, 'Weigh in 3 or more times a week. After 2 weeks this checks your real rate against your goal.');
  else if (adv.status === 'on') trend = h('div', { class: 'trend good small' }, `On track: ${fmtRate(rate)} (goal ${fmtRate(lo)} to ${fmtRate(hi)}).`);
  else trend = h('div', { class: 'trend warn small' }, `${fmtRate(rate)} over 4 weeks. Goal is ${fmtRate(lo)} to ${fmtRate(hi)}. ${adv.adjust > 0 ? `Eat about ${adv.adjust} kcal more a day.` : `Eat about ${-adv.adjust} kcal less a day.`}`);
  const macro = (label, g, kcalPer) => h('div', { class: 'macro' }, h('div', { class: 'macro-val' }, `${g}`, h('span', null, 'g')), h('div', { class: 'stat-label' }, label), h('div', { class: 'muted tiny' }, `${Math.round((g * kcalPer / t.kcal) * 100)}%`));
  return h('div', { class: 'card stack targets' },
    h('div', { class: 'row between' }, h('h3', null, 'Daily targets'), h('button', { class: 'btn small ghost', onclick: openProfileSheet }, 'Edit')),
    h('div', { class: 'kcal-row' }, h('div', { class: 'kcal' }, t.kcal.toLocaleString()), h('div', { class: 'muted small' }, `calories a day, goal: ${t.goal.label.toLowerCase()}`)),
    h('div', { class: 'macro-row' }, macro('Protein', t.protein, 4), macro('Carbs', t.carbs, 4), macro('Fat', t.fat, 9)),
    trend,
    h('div', { class: 'muted tiny' }, `Maintenance about ${t.tdee.toLocaleString()} kcal (resting ${t.bmr.toLocaleString()}), from ${B.fmtHeight(p.heightCm, p.units)}, ${B.ageOf(p)} years, ${calc.fmtNum(bw)} lb, ${t.act.label.toLowerCase()}. Estimates: let your weekly trend be the judge.${t.floored ? ' Capped at a safe minimum.' : ''}`));
}

let measureKey = 'waist';
function measurementsSection() {
  const ms = S.measurements; // newest first
  const units = S.profile.units;
  const unit = LEN_UNIT();
  const header = h('div', { class: 'section-head' }, h('h2', null, 'Measurements'), h('button', { class: 'btn small primary', onclick: () => openMeasureSheet() }, '+ Log'));
  if (!ms.length) {
    return h('div', { class: 'stack' }, header,
      h('p', { class: 'muted small' }, 'Track arms, chest, shoulders and waist to see where you’re growing. Measure every 2–4 weeks, same time of day, tape snug but not tight. Waist + neck gives a body-fat estimate.'));
  }
  const latestOf = (k) => ms.find((m) => m[k]);
  const prevOf = (k) => ms.filter((m) => m[k])[1];
  const logged = B.MEASURES.filter((m) => latestOf(m.key));
  if (!logged.some((m) => m.key === measureKey)) measureKey = logged[0]?.key || 'waist';
  // body fat from the newest entry that has what the formula needs
  const bfPoints = [...ms].reverse().map((m) => ({ m, bf: B.navyBodyFat({ sex: S.profile.sex, heightCm: S.profile.heightCm, neck: m.neck, waist: m.waist, hips: m.hips }) })).filter((x) => x.bf !== null);
  const bfNow = bfPoints[bfPoints.length - 1];
  const bfFirst = bfPoints[0];
  const toMs = (d) => Date.parse(d + 'T12:00:00');
  const series = [...ms].reverse().filter((m) => m[measureKey]).map((m) => ({ x: toMs(m.date), y: fromCm(m[measureKey]) }));
  return h('div', { class: 'stack' }, header,
    bfNow ? h('div', { class: 'card bf-card' },
      h('div', null, h('div', { class: 'stat-label' }, 'Est. body fat'), h('div', { class: 'stat-val' }, `${bfNow.bf}%`)),
      h('div', { class: 'muted small' }, bfPoints.length > 1 ? `${bfNow.bf - bfFirst.bf <= 0 ? '▼' : '▲'} ${Math.abs(Math.round((bfNow.bf - bfFirst.bf) * 10) / 10)} since ${fmtDate(toMs(bfFirst.m.date), { month: 'short', day: 'numeric' })}. US Navy tape method, about ±3–4%.` : 'US Navy tape method, about ±3–4%. Track the trend, not the exact number.'))
      : (!S.profile.sex || !S.profile.heightCm) ? h('p', { class: 'muted small' }, 'Add your sex and height in your profile to get a body-fat estimate from waist and neck.') : null,
    h('div', { class: 'measure-grid' }, logged.map((m) => {
      const cur = latestOf(m.key)[m.key];
      const prev = prevOf(m.key)?.[m.key];
      const d = prev ? fromCm(cur) - fromCm(prev) : null;
      return h('button', { class: `measure ${measureKey === m.key ? 'on' : ''}`, onclick: () => { measureKey = m.key; render(); } },
        h('div', { class: 'stat-label' }, m.label),
        h('div', { class: 'measure-val' }, `${fromCm(cur)}`, h('span', null, ` ${unit}`)),
        d !== null && Math.abs(d) >= 0.05 ? h('div', { class: `tiny ${d > 0 ? 'up' : 'muted'}` }, `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d * 10) / 10)}`) : h('div', { class: 'tiny muted' }, ' '));
    })),
    series.length ? h('div', { class: 'card' },
      h('div', { class: 'chart-title' }, `${B.MEASURES.find((m) => m.key === measureKey)?.label || ''} (${unit})`),
      lineChart({ series: [{ name: measureKey, color: 'var(--series-1)', points: series }], fmt: (v) => `${calc.fmtNum(v)} ${unit}`, ariaLabel: `${measureKey} over time` })) : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Logged'), h('th', null, h('span', { class: 'sr' }, 'Actions')))),
      h('tbody', null, ms.map((m) => h('tr', null,
        h('td', null, fmtDate(toMs(m.date), { month: 'short', day: 'numeric', year: '2-digit' })),
        h('td', { class: 'muted' }, B.MEASURES.filter((x) => m[x.key]).map((x) => `${x.label.replace(' (flexed)', '')} ${fromCm(m[x.key])}`).join(', ')),
        h('td', { class: 'num-col' },
          h('button', { class: 'icon-btn sm', 'aria-label': `Edit ${m.date}`, onclick: () => openMeasureSheet(m) }, '✎'),
          h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${m.date}`, onclick: async () => { const ok = await confirmSheet(`Delete the measurements from ${m.date}?`, { ok: 'Delete', danger: true }); if (ok) { await db.remove('measurements', m.id); await loadAll(); render(); } } }, '✕'))))))));
}

function openMeasureSheet(existing = null) {
  const last = S.measurements[0] || {};
  const rec = existing ? { ...existing } : { date: todayISO() };
  const unit = LEN_UNIT();
  sheet((close) => h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', null, 'Date'), h('input', { type: 'date', value: rec.date, max: todayISO(), onchange: (e) => (rec.date = e.target.value || todayISO()) })),
    h('p', { class: 'muted small' }, `Fill in what you measured (${unit}). Leave the rest blank.`),
    h('div', { class: 'measure-form' }, B.MEASURES.filter((m) => m.key !== 'hips' || S.profile.sex !== 'male').map((m) => h('label', { class: 'field' },
      h('span', null, m.label), numInput({ value: fromCm(rec[m.key]), placeholder: last[m.key] ? String(fromCm(last[m.key])) : unit, label: `${m.label} in ${unit}`, onInput: (v) => (rec[m.key] = v === null ? null : Math.round(toCm(v) * 10) / 10) }),
      h('small', { class: 'muted tiny' }, m.hint)))),
    h('button', { class: 'btn primary block big-cta', onclick: async () => {
      const vals = B.MEASURES.map((m) => rec[m.key]).filter((v) => v);
      if (!vals.length) return toast('Enter at least one measurement');
      if (vals.some((v) => v < 10 || v > 250)) return toast(`Check the numbers are in ${unit}`);
      await db.put('measurements', { ...rec, id: existing?.id || `ms-${rec.date}` });
      await loadAll();
      close();
      toast('Measurements saved');
      render();
    } }, 'Save measurements')),
  { title: existing ? 'Edit measurements' : 'Log measurements' });
}

async function viewBody() {
  setTitle('Body');
  const date = h('input', { type: 'date', value: todayISO(), 'aria-label': 'Date', max: todayISO() });
  const weight = numInput({ value: null, placeholder: S.bodyweight[0]?.weight ?? 'lb', label: 'Bodyweight in pounds', onInput: () => {} });
  const save = async () => {
    const v = parseNum(weight.value);
    if (v === null || v < 50 || v > 700) return toast('Enter your weight in lb');
    const d = date.value || todayISO();
    const existing = S.bodyweight.find((b) => b.date === d);
    await db.put('bodyweight', { id: existing?.id || `bw-${d}`, date: d, weight: v });
    await loadAll();
    toast('Logged');
    render();
  };
  const pts = [...S.bodyweight].sort((a, b) => a.date.localeCompare(b.date));
  const avg = calc.rollingAverage(pts, 7);
  const toMs = (d) => Date.parse(d + 'T12:00:00');
  const latest = pts[pts.length - 1];
  const latestAvg = avg[avg.length - 1];
  const monthAgo = avg.filter((a) => toMs(a.date) <= Date.now() - 28 * 86400000).pop();

  return h('div', { class: 'page stack' },
    targetsCard(),
    h('div', { class: 'section-head' }, h('h2', null, 'Weight')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row gap' }, h('label', { class: 'field grow' }, h('span', null, 'Weight (lb)'), weight), h('label', { class: 'field grow' }, h('span', null, 'Date'), date)),
      h('button', { class: 'btn primary block', onclick: save }, 'Log weight'),
      h('p', { class: 'muted small' }, 'Weigh in the same way each time (morning, after the bathroom). The 7-day average smooths out water swings.')),
    pts.length ? h('div', { class: 'stat-row' },
      stat(`${calc.fmtNum(latest.weight)}`, 'Latest (lb)'),
      stat(`${calc.fmtNum(latestAvg.avg)}`, '7-day avg'),
      stat(monthAgo ? `${latestAvg.avg - monthAgo.avg > 0 ? '+' : ''}${calc.fmtNum(Math.round((latestAvg.avg - monthAgo.avg) * 10) / 10)}` : '—', '4-week change')) : null,
    pts.length ? h('div', { class: 'card' },
      h('div', { class: 'chart-title' }, 'Bodyweight (lb)'),
      lineChart({
        series: [
          { name: '7-day average', color: 'var(--series-1)', points: avg.map((a) => ({ x: toMs(a.date), y: a.avg })), dots: false },
          { name: 'Weigh-in', color: 'var(--series-2)', points: pts.map((p) => ({ x: toMs(p.date), y: p.weight })), line: false },
        ],
        fmt: (v) => `${calc.fmtNum(v)} lb`, ariaLabel: 'Bodyweight trend',
      })) : h('p', { class: 'muted' }, 'No weigh-ins yet.'),
    pts.length ? h('details', { class: 'card log-details' }, h('summary', null, `All weigh-ins (${pts.length})`),
      h('div', { class: 'table-wrap flat' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num-col' }, 'Weight'), h('th', { class: 'num-col' }, '7-day avg'), h('th', null, h('span', { class: 'sr' }, 'Delete')))),
        h('tbody', null, [...pts].reverse().map((p) => h('tr', null,
          h('td', null, fmtDate(toMs(p.date), { weekday: 'short', month: 'short', day: 'numeric' })),
          h('td', { class: 'num-col' }, calc.fmtNum(p.weight)),
          h('td', { class: 'num-col muted' }, calc.fmtNum(avg.find((a) => a.date === p.date)?.avg)),
          h('td', { class: 'num-col' }, h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${p.date}`, onclick: () => removeWeighIn(p) }, '✕')))))))) : null,
    measurementsSection());
}

async function removeWeighIn(p) {
  const rec = S.bodyweight.find((b) => b.id === p.id) || p;
  await db.remove('bodyweight', rec.id);
  await loadAll();
  render();
  toast(`Weigh-in from ${fmtDate(Date.parse(rec.date + 'T12:00:00'), { month: 'short', day: 'numeric' })} deleted`, '', { action: { label: 'Undo', run: async () => {
    const { deleted, _dirty, ...keep } = rec;
    await db.put('bodyweight', keep);
    await loadAll();
    render();
  } } });
}

async function shareApp() {
  const url = location.href.split('#')[0].split('?')[0];
  try {
    if (navigator.share) { await navigator.share({ title: 'Gym Tracker', text: 'Track your lifts, PRs and progress with Gym Tracker:', url }); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied — paste it in a text');
  } catch (e) {
    if (e?.name !== 'AbortError') toast(url);
  }
}

// ================================================================= SETTINGS
async function exportBackup() {
  try {
    const data = await db.exportAll();
    const name = `gym-tracker-backup-${todayISO()}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Gym Tracker backup' });
    } else {
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    await db.setMeta('lastExport', Date.now());
    toast('Backup exported — save it to Files / iCloud Drive');
    if (route().name === 'train' || route().name === 'settings') render();
  } catch (e) {
    if (e?.name !== 'AbortError') toast(`Export failed: ${e.message || e}`, 'err');
  }
}

function importBackup() {
  const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const n = await db.importAll(data);
      await loadAll();
      toast(`Imported ${n} record${n === 1 ? '' : 's'}`);
      sync.schedule(0);
      if (!S.seeded) { await db.setMeta('seeded', true); S.seeded = true; location.replace('#/train'); } // hashchange renders
      else render();
    } catch (e) {
      toast(`Import failed: ${e.message || e}`, 'err');
    }
  });
  document.body.appendChild(input);
  input.click();
}

async function viewSettings() {
  setTitle('Settings');
  const lastExport = await db.meta('lastExport', 0);
  const set = async (patch) => { await db.saveSettings(patch); await loadAll(); render(); };

  const plateInv = S.settings.plates || [];
  const allPlates = [...new Set([55, 45, 35, 25, 10, 5, 2.5, 1.25, ...plateInv])].sort((a, b) => b - a);

  const p = S.profile;
  const bw = latestBW();
  const summary = [p.name, p.sex ? (p.sex === 'male' ? 'Male' : 'Female') : null, B.ageOf(p) ? `${B.ageOf(p)} yrs` : null, p.heightCm ? B.fmtHeight(p.heightCm, p.units) : null, bw ? `${calc.fmtNum(bw)} lb` : null, B.GOALS[p.goal]?.label].filter(Boolean).join(', ');
  return h('div', { class: 'page stack' },
    h('div', { class: 'card stack' }, h('h3', null, 'Your profile'),
      h('p', { class: 'muted small' }, B.profileComplete(p, bw) ? summary : 'Add your details to get calorie targets, body-fat estimates and strength levels.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary grow', onclick: openProfileSheet }, B.profileComplete(p, bw) ? 'Edit profile' : 'Set up profile'),
        h('div', { class: 'seg mini' }, [['metric', 'cm'], ['imperial', 'in']].map(([k, l]) => h('button', { class: `seg-btn ${(p.units || 'metric') === k ? 'on' : ''}`, 'aria-label': `Body measurements in ${l}`, onclick: async () => { await db.saveProfile({ units: k }); await loadAll(); render(); } }, l))))),
    h('div', { class: 'card stack' }, h('h3', null, 'Cloud sync'), syncPanel()),
    h('div', { class: 'card stack' }, h('h3', null, 'Share Gym Tracker'),
      h('p', { class: 'muted small' }, 'Send the app to a friend. They get their own setup, and their workouts stay on their phone and their own sync account.'),
      h('button', { class: 'btn block', onclick: shareApp }, 'Share app link')),
    h('div', { class: 'card stack' }, h('h3', null, 'Home Screen'),
      install.isStandalone()
        ? h('p', { class: 'muted small' }, 'You’re using the Home Screen app. It opens full screen and works offline.')
        : h('p', { class: 'muted small' }, 'Put Gym Tracker on your home screen so it opens like an app, full screen and offline.'),
      install.isStandalone() ? null : h('button', { class: 'btn primary block', onclick: () => install.showInstallGuide() }, 'Add to Home Screen')),
    h('div', { class: 'card stack' }, h('h3', null, 'Backup file'),
      h('p', { class: 'muted small' }, lastExport ? `Last export ${new Date(lastExport).toLocaleDateString()}` : 'Never exported'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn grow', onclick: exportBackup }, 'Export'),
        h('button', { class: 'btn ghost grow', onclick: importBackup }, 'Import'))),
    h('div', { class: 'card stack' }, h('h3', null, 'Workout'),
      settingNum('Default rest (seconds)', S.settings.defaultRest, (v) => set({ defaultRest: v })),
      settingNum('Warm-up rest (seconds)', S.settings.warmupRest, (v) => set({ warmupRest: v })),
      toggle('Keep screen awake during workouts', S.settings.keepAwake, (v) => set({ keepAwake: v }),
        timer.wakeLockSupported() ? null : 'Not supported on this iOS version (needs iOS 18.4+). Set Auto-Lock to 5 min in iPhone Settings as a fallback.'),
      toggle('Beep when rest is over', S.settings.sound !== false, (v) => set({ sound: v }), 'The beep is muted when your iPhone is on silent. The bar and the overhead light also flash green.'),
      toggle('Show coach suggestions on Train', S.settings.coachOnTrain !== false, (v) => set({ coachOnTrain: v }), 'The full list is always under Train → Coach.')),
    h('div', { class: 'card stack' }, h('h3', null, 'Theme'),
      h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }, Object.entries(fx.THEMES).map(([key, t]) => {
        const on = (S.settings.theme || fx.DEFAULT_THEME) === key;
        return h('button', { class: `theme-opt ${on ? 'on' : ''}`, role: 'radio', 'aria-checked': on ? 'true' : 'false',
          onclick: async () => { fx.setTheme(key); await db.saveSettings({ theme: key }); await loadAll(); render(); } },
          h('span', { class: `sw sw-${key}`, 'aria-hidden': 'true' }), h('span', { class: 'nm' }, t.label), on ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null);
      })),
      toggle('Moving background', S.settings.animatedBg !== false, (v) => { fx.setBackground(v); set({ animatedBg: v }); },
        'Turn it off to save battery. It also holds still when Reduce Motion is on in iPhone Settings.')),
    h('div', { class: 'card stack' }, h('h3', null, 'Plates at your gym'),
      h('div', { class: 'chip-row' }, allPlates.map((p) => h('button', { class: `chip ${plateInv.includes(p) ? 'on' : ''}`, 'aria-pressed': plateInv.includes(p) ? 'true' : 'false',
        onclick: () => set({ plates: plateInv.includes(p) ? plateInv.filter((x) => x !== p) : [...plateInv, p].sort((a, b) => b - a) }) }, `${p} lb`))),
      settingNum('Barbell weight (lb)', S.settings.barWeight, (v) => set({ barWeight: v }))),
    h('div', { class: 'card stack' }, h('h3', null, 'Danger zone'),
      h('button', { class: 'btn danger-ghost block', onclick: async () => {
        const ok = await confirmSheet('Erase everything on this phone? If sync is on, signing back in restores it; otherwise only a backup file can.', { ok: 'Erase', danger: true });
        if (!ok) return;
        await sync.signOut().catch(() => {});
        await db.clearAll();
        location.reload();
      } }, 'Erase all data on this phone')),
    h('p', { class: 'muted small center' }, `Gym Tracker ${APP_VERSION}`));
}

function settingNum(label, value, onSave) {
  const inp = numInput({ value, label, decimal: false, onInput: () => {} });
  inp.addEventListener('change', () => { const v = parseNum(inp.value); if (v !== null && v >= 0) onSave(v); });
  return h('label', { class: 'field row between' }, h('span', null, label), inp);
}

function toggle(label, on, onSet, note) {
  return h('div', { class: 'stack tight' },
    h('label', { class: 'toggle' }, h('span', null, label),
      h('input', { type: 'checkbox', role: 'switch', checked: !!on, onchange: (e) => onSet(e.target.checked) })),
    note ? h('div', { class: 'muted small' }, note) : null);
}

// ================================================================= BOOT
async function boot() {
  try {
    S.seeded = (await seedIfNeeded()) !== 'onboard';
    await loadAll();
  } catch (e) {
    fill(main, h('div', { class: 'page' }, h('p', null, `Couldn’t open storage: ${e.message || e}`)));
    return;
  }
  db.requestPersistence();
  fx.initBackground(S.settings.animatedBg !== false, S.settings.theme || fx.DEFAULT_THEME);
  timer.onDone(() => fx.pulseLight('go'));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(`#/${t.dataset.tab}`)));
  navStack.push(location.hash || '#/train');
  window.addEventListener('hashchange', () => {
    const hsh = location.hash || '#/train';
    if (navStack.length > 1 && navStack[navStack.length - 2] === hsh) navStack.pop();
    else navStack.push(hsh);
    if (navStack.length > 50) navStack.splice(0, navStack.length - 50);
    if (S.current && !route().name.startsWith('workout')) { flushCurrent(); S.current = null; }
    render();
  });
  sync.onStatus(async (_st, changed) => {
    if (changed) await loadAll();
    if (changed && !S.seeded && S.exercises.size) {
      await db.setMeta('seeded', true);
      S.seeded = true;
      closeSyncSheet && closeSyncSheet();
      location.replace('#/train');
      toast('Your log is back on this phone');
      return;
    }
    // New data from another phone: redraw (but never under a workout you're logging). The sync
    // panels redraw themselves, so typing in the sign-in form is never wiped.
    if (changed && !S.current) render();
    else fill(headRight, syncButton());
  });
  db.onChange(() => sync.schedule());
  await render();
  sync.init().catch((e) => console.warn('sync init', e));
  registerSW();
}

let updateRequested = false;
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    if (!reg) return;
    const promptUpdate = (worker) => {
      if (document.querySelector('.update-bar')) return;
      const bar = h('div', { class: 'update-bar' }, 'Update ready', h('button', { class: 'btn small', onclick: async () => { await flushCurrent(); updateRequested = true; worker.postMessage('skipWaiting'); } }, 'Reload'));
      document.body.appendChild(bar);
    };
    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(nw); });
    });
  }).catch((e) => console.warn('SW', e));
  // Only reload when the user tapped "Reload" — never on first install or mid-workout.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) { updateRequested = false; location.reload(); } });
}

boot();
