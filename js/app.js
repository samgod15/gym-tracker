import * as db from './db.js';
import * as calc from './calc.js';
import * as timer from './timer.js';
import * as sync from './sync.js';
import { seedIfNeeded } from './seed.js';
import * as fx from './fx.js';
import { lineChart } from './charts.js';
import { h, fill, toast, sheet, confirmSheet, fmtDate, fmtDuration, debounce } from './ui.js';
const { todayISO } = calc;

export const APP_VERSION = '1.1.0';

// ---------------------------------------------------------------- state
const S = {
  exercises: new Map(),
  routines: [],
  workouts: [],
  settings: { ...db.DEFAULT_SETTINGS },
  bodyweight: [],
  histIndex: null, // exerciseId -> [{workout, entry, at}] newest first (finished workouts only)
  current: null, // workout open in the editor
};

const exById = (id) => S.exercises.get(id) || { id, name: 'Deleted exercise', loadType: 'total', restSec: null, missing: true };
const sortedExercises = () => [...S.exercises.values()].sort((a, b) => a.name.localeCompare(b.name));

async function loadAll() {
  const [ex, rt, wo, bw, settings] = await Promise.all([
    db.all('exercises'), db.all('routines'), db.all('workouts'), db.all('bodyweight'), db.getSettings(),
  ]);
  S.exercises = new Map(ex.map((e) => [e.id, e]));
  S.routines = rt.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
  S.workouts = wo.sort((a, b) => b.startedAt - a.startedAt);
  S.bodyweight = bw.sort((a, b) => b.date.localeCompare(a.date));
  S.settings = settings;
  S.histIndex = null;
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

function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'train').split('/');
  return { name: parts[0], id: parts[1] ? decodeURIComponent(parts[1]) : null };
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

let elapsedTick = null;

async function render() {
  const r = route();
  clearInterval(elapsedTick);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabFor(r.name)));
  fill(headRight, syncBadge());
  app.dataset.route = r.name;
  const views = {
    train: viewTrain, workout: viewWorkout, routine: viewRoutine, history: viewHistory, session: viewSession,
    progress: viewProgress, exercise: viewExercise, body: viewBody, settings: viewSettings,
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
const tabFor = (name) => ({ workout: 'train', routine: 'train', session: 'history', exercise: 'progress' }[name] || name);
function setTitle(t) {
  const span = titleEl.querySelector('.title-text');
  if (span.textContent === t) return;
  span.textContent = t;
  span.classList.remove('enter');
  void span.offsetWidth;
  span.classList.add('enter');
}

// ---------------------------------------------------------------- sync badge
function syncBadge() {
  const st = sync.status();
  let cls = 'off';
  let label = 'Sync off';
  if (st.user) {
    if (st.state === 'syncing') { cls = 'busy'; label = 'Syncing'; }
    else if (st.state === 'error') { cls = 'err'; label = 'Sync error'; }
    else if (st.state === 'offline') { cls = 'off'; label = 'Offline'; }
    else { cls = 'ok'; label = 'Synced'; }
  }
  return h('button', { class: `sync-badge ${cls}`, onclick: () => go('#/settings'), 'aria-label': `${label}. Open settings.` },
    h('span', { class: 'dot', 'aria-hidden': 'true' }), label);
}

// ================================================================= TRAIN
async function viewTrain() {
  setTitle('Train');
  const active = activeWorkout();
  const lastDone = (rid) => S.workouts.find((w) => w.endedAt && w.routineId === rid);
  const lastExport = await db.meta('lastExport', 0);
  const needsBackup = !sync.status().user && realWorkouts().length > 0 && Date.now() - lastExport > 7 * 86400000;
  const next = nextRoutine();
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
    hero,
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
  const entries = rt.items.filter((i) => S.exercises.has(i.exerciseId)).map((i) => buildEntry(i.exerciseId, i.sets, i.group, i.reps));
  await startWorkout({ name: rt.name, routineId: rt.id, entries });
}

/** New entry prefilled from the last time this exercise was done. */
function buildEntry(exerciseId, targetSets = 3, group = null, targetReps = '') {
  const ex = exById(exerciseId);
  const last = historyFor(exerciseId)[0];
  const lastWork = last ? last.entry.sets.filter((s) => s.done && s.type === 'work') : [];
  const n = Math.max(1, targetSets || lastWork.length || 1);
  const sets = [];
  for (let i = 0; i < n; i++) {
    const src = lastWork[i] || lastWork[lastWork.length - 1];
    sets.push(newSet(src, ex));
  }
  return { exerciseId, group: group || null, target: targetReps ? `${n} × ${targetReps}` : '', sets };
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
        live
          ? h('button', { class: 'btn primary small', onclick: () => finishWorkout() }, 'Finish')
          : h('button', { class: 'btn primary small', onclick: async () => { await saveFinishedEdit(); } }, 'Save'))),
    blocks.map((b) => b.group && b.entries.length > 1
      ? h('div', { class: 'superset' }, h('div', { class: 'superset-label' }, `Superset ${b.group}`), b.entries.map(({ entry, index }) => entryCard(entry, index)))
      : b.entries.map(({ entry, index }) => entryCard(entry, index))),
    h('button', { class: 'btn ghost block', onclick: () => pickExercise((ex) => { cw.entries.push(buildEntry(ex.id, 3)); saveCurrent(); rerender(); }) }, '+ Add exercise'),
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
    return setRow(ex, entry, ei, s, si, s.type === 'work' ? String(workNo) : s.type === 'warmup' ? 'W' : 'D', prev);
  });

  return h('section', { class: `card entry ${entry.group ? 'in-superset' : ''}`, id: `entry-${ei}` },
    h('div', { class: 'entry-head' },
      h('button', { class: 'entry-name', onclick: () => entryMenu(ei) },
        h('span', null, ex.name), entry.group ? h('span', { class: 'pill' }, entry.group) : null, h('span', { class: 'chev', 'aria-hidden': 'true' }, '⋯')),
      entry.target ? h('span', { class: 'muted small' }, `Target ${entry.target}`) : null),
    h('div', { class: 'muted small last-line' }, lastText),
    h('div', { class: `set-grid head ${isCardio ? 'cardio' : ''}` },
      h('span', null, 'Set'), h('span', null, unitHead), h('span', null, isCardio ? 'Avg HR' : 'Reps'), isCardio ? null : h('span', null, 'RIR'), h('span', null, h('span', { class: 'sr' }, 'Done'))),
    rows,
    h('div', { class: 'entry-actions' },
      h('button', { class: 'chip-btn', onclick: () => { const src = entry.sets.filter((x) => x.type === 'work').pop(); entry.sets.push(newSet(src, ex)); saveCurrent(); rerender(); } }, '+ Set'),
      isCardio ? null : h('button', { class: 'chip-btn', onclick: () => { const firstWork = entry.sets.findIndex((x) => x.type !== 'warmup'); entry.sets.splice(firstWork < 0 ? entry.sets.length : firstWork, 0, newSet(null, ex, 'warmup')); saveCurrent(); rerender(); } }, '+ Warm-up'),
      isCardio ? null : h('button', { class: 'chip-btn', onclick: () => addDrop(entry, ex) }, '+ Drop')));
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
  saveCurrent();
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
    saveCurrent(); rerender(); return;
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
  saveCurrent();
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
      h('button', { class: `seg-btn ${s.type === k ? 'on' : ''}`, onclick: () => { s.type = k; if (k !== 'work') s.pr = []; saveCurrent(); close(); rerender(); } }, label))),
    h('p', { class: 'muted small' }, 'Warm-ups and drop sets never count toward PRs or charts.'),
    h('button', { class: 'btn danger-ghost block', onclick: () => { entry.sets.splice(si, 1); saveCurrent(); close(); rerender(); } }, 'Delete this set')),
  { title: 'Set options' });
}

function entryMenu(ei) {
  const cw = S.current;
  const entry = cw.entries[ei];
  const ex = exById(entry.exerciseId);
  sheet((close) => {
    const done = () => { saveCurrent(); close(); rerender(); };
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
      h('button', { class: 'btn danger-ghost block', onclick: () => { cw.entries.splice(ei, 1); done(); } }, 'Remove from workout'));
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
  }, { title: `${ex.name}`, onClose: () => { saveCurrent(); rerender(); } });
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
function pickExercise(onPick) {
  sheet((close) => {
    const list = h('div', { class: 'pick-list' });
    const q = h('input', { class: 'search', type: 'search', placeholder: 'Search or type a new name', 'aria-label': 'Search exercises', oninput: () => draw() });
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
        h('label', { class: 'field' }, h('span', null, 'Muscle group (optional)'), h('input', { value: ex.muscle || '', oninput: (e) => (ex.muscle = e.target.value) })),
        h('label', { class: 'field' }, h('span', null, 'Notes (seat height, grip…)'), h('textarea', { rows: 2, oninput: (e) => (ex.notes = e.target.value) }, ex.notes || '')),
        h('button', { class: 'btn primary block', onclick: async () => {
          if (!ex.name.trim()) return toast('Give it a name');
          const saved = await db.put('exercises', { ...ex, name: ex.name.trim(), id: ex.id || db.uid('ex-') });
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
              h('select', { onchange: (e) => (it.group = e.target.value || null) }, ['', 'A', 'B', 'C', 'D'].map((g) => h('option', { value: g, selected: (it.group || '') === g ? 'selected' : null }, g || 'None'))))));
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
        const first = sr.points[0].y; const last = sr.points[sr.points.length - 1].y;
        const best = Math.max(...sr.points.map((p) => p.y));
        const delta = last - first;
        return h('button', { class: 'card progress-row', onclick: () => go(`#/exercise/${ex.id}`) },
          h('div', null, h('div', { class: 'card-title' }, ex.name), h('div', { class: 'muted small' }, `Last ${fmtDate(lastAt, { month: 'short', day: 'numeric' })}, ${sr.points.length} session${sr.points.length > 1 ? 's' : ''}`)),
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

// ================================================================= BODYWEIGHT
async function viewBody() {
  setTitle('Bodyweight');
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
    h('div', { class: 'card stack' },
      h('div', { class: 'row gap' }, h('label', { class: 'field grow' }, h('span', null, 'Weight (lb)'), weight), h('label', { class: 'field grow' }, h('span', null, 'Date'), date)),
      h('button', { class: 'btn primary block', onclick: save }, 'Log weight'),
      h('p', { class: 'muted small' }, 'Weigh in the same way each time (morning, after the bathroom) — the 7-day average smooths out water swings.')),
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
    pts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num-col' }, 'Weight'), h('th', { class: 'num-col' }, '7-day avg'), h('th', null, h('span', { class: 'sr' }, 'Delete')))),
      h('tbody', null, [...pts].reverse().map((p) => h('tr', null,
        h('td', null, fmtDate(toMs(p.date), { weekday: 'short', month: 'short', day: 'numeric' })),
        h('td', { class: 'num-col' }, calc.fmtNum(p.weight)),
        h('td', { class: 'num-col muted' }, calc.fmtNum(avg.find((a) => a.date === p.date)?.avg)),
        h('td', { class: 'num-col' }, h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${p.date}`, onclick: async () => { await db.remove('bodyweight', p.id); await loadAll(); render(); } }, '✕'))))))) : null);
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
      render();
    } catch (e) {
      toast(`Import failed: ${e.message || e}`, 'err');
    }
  });
  document.body.appendChild(input);
  input.click();
}

async function viewSettings() {
  setTitle('Settings');
  const st = sync.status();
  const lastExport = await db.meta('lastExport', 0);
  const set = async (patch) => { await db.saveSettings(patch); await loadAll(); render(); };

  // --- sync card
  let syncCard;
  if (!st.configured) {
    syncCard = h('div', { class: 'card stack' }, h('h3', null, 'Cloud sync'),
      h('p', { class: 'muted' }, 'Not set up yet. Paste your Firebase config into js/firebase-config.js (README step 3), upload it to GitHub, then reopen the app.'));
  } else if (st.user) {
    syncCard = h('div', { class: 'card stack' }, h('h3', null, 'Cloud sync'),
      h('div', null, 'Signed in as ', h('strong', null, st.user.email)),
      h('div', { class: 'muted small' }, st.lastSync ? `Last synced ${new Date(st.lastSync).toLocaleString()}` : 'Not synced yet'),
      st.error ? h('div', { class: 'banner err small' }, st.error) : null,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary grow', onclick: async () => { await sync.syncNow(); await loadAll(); render(); } }, st.state === 'syncing' ? 'Syncing…' : 'Sync now'),
        h('button', { class: 'btn ghost grow', onclick: async () => { await sync.signOut(); render(); } }, 'Sign out')));
  } else {
    const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'Email', 'aria-label': 'Email', value: (await db.meta('lastEmail', '')) || '' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password (6+ characters)', 'aria-label': 'Password' });
    const run = async (fn) => {
      try { await fn(email.value.trim(), pw.value); await db.setMeta('lastEmail', email.value.trim()); toast('Signed in — syncing'); await loadAll(); render(); }
      catch (e) { toast(sync.friendlyError(e), 'err'); }
    };
    syncCard = h('div', { class: 'card stack' }, h('h3', null, 'Cloud sync'),
      h('p', { class: 'muted small' }, 'Your log is saved on this phone first. Signing in mirrors it to your Firebase database so it survives a lost phone.'),
      st.state === 'error' && st.error ? h('div', { class: 'banner err small' }, st.error) : null,
      email, pw,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary grow', onclick: () => run(sync.signIn) }, 'Sign in'),
        h('button', { class: 'btn ghost grow', onclick: () => run(sync.signUp) }, 'Create account')),
      h('button', { class: 'link', onclick: async () => { try { await sync.resetPassword(email.value.trim()); toast('Reset email sent'); } catch (e) { toast(sync.friendlyError(e), 'err'); } } }, 'Forgot password'));
  }

  const plateInv = S.settings.plates || [];
  const allPlates = [...new Set([55, 45, 35, 25, 10, 5, 2.5, 1.25, ...plateInv])].sort((a, b) => b - a);

  return h('div', { class: 'page stack' },
    syncCard,
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
      toggle('Beep when rest is over', S.settings.sound !== false, (v) => set({ sound: v }), 'The beep is muted when your iPhone is on silent. The bar and the overhead light also flash green.')),
    h('div', { class: 'card stack' }, h('h3', null, 'Look'),
      toggle('Animated background', S.settings.animatedBg !== false, (v) => { fx.setBackground(v); set({ animatedBg: v }); },
        'The drifting chalk dust. Turn it off to save a little battery. It also stops when Reduce Motion is on in iPhone Settings.')),
    h('div', { class: 'card stack' }, h('h3', null, 'Plates at your gym'),
      h('div', { class: 'chip-row' }, allPlates.map((p) => h('button', { class: `chip ${plateInv.includes(p) ? 'on' : ''}`, 'aria-pressed': plateInv.includes(p) ? 'true' : 'false',
        onclick: () => set({ plates: plateInv.includes(p) ? plateInv.filter((x) => x !== p) : [...plateInv, p].sort((a, b) => b - a) }) }, `${p} lb`))),
      settingNum('Barbell weight (lb)', S.settings.barWeight, (v) => set({ barWeight: v }))),
    h('div', { class: 'card stack' }, h('h3', null, 'Install on your iPhone'),
      h('p', { class: 'muted small' }, 'In Safari: Share → Add to Home Screen → open from the new icon. Data saved in Safari and in the Home Screen app are separate on iOS, so log from the icon.')),
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
    await seedIfNeeded();
    await loadAll();
  } catch (e) {
    fill(main, h('div', { class: 'page' }, h('p', null, `Couldn’t open storage: ${e.message || e}`)));
    return;
  }
  db.requestPersistence();
  fx.initBackground(S.settings.animatedBg !== false);
  timer.onDone(() => fx.pulseLight('go'));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(`#/${t.dataset.tab}`)));
  window.addEventListener('hashchange', () => {
    if (S.current && !route().name.startsWith('workout')) { flushCurrent(); S.current = null; }
    render();
  });
  let prevSig = '';
  sync.onStatus(async (st, changed) => {
    const sig = `${st.configured}|${st.user?.uid || ''}`;
    const authChanged = sig !== prevSig;
    prevSig = sig;
    if (changed) await loadAll();
    const onSettings = route().name === 'settings';
    // Re-render when data arrived, or when the Settings page needs to show new sync/sign-in state.
    if ((changed && !S.current) || (onSettings && (authChanged || st.user))) render();
    else fill(headRight, syncBadge());
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
