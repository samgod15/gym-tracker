import assert from 'node:assert/strict';
import { nextTarget, analyze, guessMuscle, parseRange } from '../js/coach.js';

let n = 0;
const test = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };
const DAY = 86400000;
const NOW = Date.parse('2026-11-25T18:00:00');
let sid = 0;
const S = (f) => ({ id: 's' + (++sid), type: 'work', weight: null, plates: [], count: null, reps: null, rir: null, minutes: null, hr: null, done: true, ...f });
const W = (daysAgo, entries, extra = {}) => ({ id: 'w' + (++sid), name: 'W', routineId: extra.routineId || null, startedAt: NOW - daysAgo * DAY, endedAt: NOW - daysAgo * DAY + 3600000, entries });
const E = (exerciseId, sets) => ({ exerciseId, sets: sets.map(S) });
const EX = {
  db: { id: 'db', name: 'Incline DB press', loadType: 'dumbbell', muscle: 'Chest' },
  rdl: { id: 'rdl', name: 'Romanian deadlift (barbell)', loadType: 'plates', baseWeight: 45, muscle: 'Hamstrings' },
  stack: { id: 'stack', name: 'Seated leg curl', loadType: 'stack', muscle: 'Hamstrings' },
  pd: { id: 'pd', name: 'Lat pulldown', loadType: 'total', muscle: 'Back' },
  sq: { id: 'sq', name: 'Back squat', loadType: 'plates', baseWeight: 45, muscle: 'Quads' },
  ohp: { id: 'ohp', name: 'Seated DB shoulder press', loadType: 'dumbbell', muscle: 'Shoulders' },
  pu: { id: 'pu', name: 'Pull-up', loadType: 'bodyweight', muscle: 'Back' },
};
const settings = { plates: [45, 35, 25, 10, 5, 2.5] };
const hist = (...ws) => ws.map((w) => ({ at: w.startedAt, entry: w.entries[0], workout: w }));

test('parseRange', () => {
  assert.deepEqual(parseRange('6–8'), [6, 8]);
  assert.deepEqual(parseRange('10'), [10, 10]);
  assert.deepEqual(parseRange('12 each'), [12, 12]);
  assert.equal(parseRange('AMRAP'), null);
  assert.equal(parseRange('45s'), null);
  assert.equal(parseRange('30–45 min'), null);
});

test('dumbbell: all sets at the top of the range → next dumbbell up', () => {
  const t = nextTarget(EX.db, hist(W(2, [E('db', [{ weight: 55, reps: 8 }, { weight: 55, reps: 8 }, { weight: 55, reps: 9 }])])), '6–8', settings);
  assert.equal(t.kind, 'up');
  assert.deepEqual(t.apply, { weight: 60 });
  assert.match(t.title, /60 lb ea × 6–8/);
});

test('below the top → add reps first; under the bottom twice → come down', () => {
  assert.equal(nextTarget(EX.db, hist(W(2, [E('db', [{ weight: 55, reps: 8 }, { weight: 55, reps: 7 }])])), '6–8', settings).kind, 'reps');
  const two = hist(W(2, [E('db', [{ weight: 60, reps: 5 }, { weight: 60, reps: 4 }])]), W(6, [E('db', [{ weight: 60, reps: 5 }])]));
  const t = nextTarget(EX.db, two, '6–8', settings);
  assert.equal(t.kind, 'down');
  assert.deepEqual(t.apply, { weight: 52.5 });
  assert.equal(nextTarget(EX.db, two.slice(0, 1), '6–8', settings).kind, 'hold');
});

test('easy sets by RIR count as ready', () => {
  const t = nextTarget(EX.pd, hist(W(1, [E('pd', [{ weight: 120, reps: 8, rir: 3 }, { weight: 120, reps: 8, rir: 4 }])])), '8–12', settings);
  assert.equal(t.kind, 'up');
  assert.deepEqual(t.apply, { weight: 125 });
});

test('plates add the smallest plate per side; stack goes up one pin', () => {
  const t = nextTarget(EX.rdl, hist(W(1, [E('rdl', [{ plates: [45, 45], reps: 8 }, { plates: [45, 45], reps: 8 }])])), '6–8', settings);
  assert.equal(t.next, 235); // 4% jump at 225 lb
  assert.deepEqual(t.apply, { plates: [45, 45, 5] });
  const light = nextTarget(EX.rdl, hist(W(1, [E('rdl', [{ plates: [25], reps: 8 }, { plates: [25], reps: 8 }])])), '6–8', settings);
  assert.deepEqual(light.apply, { plates: [25, 2.5] }); // 95 lb → 100
  const s = nextTarget(EX.stack, hist(W(1, [E('stack', [{ count: 3, reps: 15 }, { count: 3, reps: 15 }])])), '10–15', settings);
  assert.deepEqual(s.apply, { count: 4 });
});

test('bodyweight: past the top of the range → suggest adding weight', () => {
  const t = nextTarget(EX.pu, hist(W(1, [E('pu', [{ weight: 0, reps: 12 }, { weight: 0, reps: 12 }])])), '8–12', settings);
  assert.equal(t.kind, 'up');
});

test('muscle guesses', () => {
  assert.equal(guessMuscle('Chest-supported row'), 'Back');
  assert.equal(guessMuscle('Seated leg curl'), 'Hamstrings');
  assert.equal(guessMuscle('Leg extension'), 'Quads');
  assert.equal(guessMuscle('Overhead cable triceps extension'), 'Triceps');
  assert.equal(guessMuscle('Reverse pec deck'), 'Rear delts');
  assert.equal(guessMuscle('Hanging leg raise'), 'Abs');
  assert.equal(guessMuscle('Incline DB curl'), 'Biceps');
});

const ctxBase = (workouts, extra = {}) => ({
  now: NOW, settings, exercises: new Map(Object.values(EX).map((e) => [e.id, e])),
  routines: [{ id: 'r1', name: 'Upper A', order: 1, items: [{ exerciseId: 'db', sets: 3, reps: '6–8' }, { exerciseId: 'pd', sets: 3, reps: '8–12' }] }],
  workouts: [...workouts].sort((a, b) => b.startedAt - a.startedAt), bodyweight: [], measurements: [], profile: {}, nextRoutineId: 'r1', ...extra,
});

test('new user: first suggestion is to log a workout; unlocks start at zero', () => {
  const r = analyze(ctxBase([]));
  assert.equal(r.items[0].id, 'start');
  assert.ok(r.unlocks.every((u) => u.have < u.need || u.key === 'profile'));
});

test('two weeks of logs: low chest volume, missing legs, ready-to-progress list', () => {
  const ws = [];
  for (const d of [1, 4, 8, 11, 15]) ws.push(W(d, [E('db', [{ weight: 55, reps: 8 }, { weight: 55, reps: 8 }]), E('pd', [{ weight: 120, reps: 10 }, { weight: 120, reps: 10 }, { weight: 120, reps: 9 }])], { routineId: 'r1' }));
  const r = analyze(ctxBase(ws, { profile: { goal: 'bulk' } }));
  const ids = r.items.map((i) => i.id);
  assert.ok(ids.some((i) => i.startsWith('up:')), 'progress card');
  assert.ok(ids.some((i) => i.startsWith('missing:') && /Quads/.test(i)), 'missing legs');
  const low = r.items.find((i) => i.id.startsWith('lowvol:'));
  assert.ok(low && /Chest/.test(low.id), 'low chest');
  assert.ok(r.stats.volume.Chest.sets > 3 && r.stats.volume.Chest.sets < 10);
  assert.ok(r.stats.volume.Biceps.sets > 0, 'indirect biceps from pulldowns');
});

test('cut losing too fast → warning with more calories', () => {
  const bw = [];
  for (let d = 0; d <= 21; d += 3) bw.push({ date: new Date(NOW - d * DAY).toISOString().slice(0, 10), weight: 180 - (21 - d) * (3 / 7) });
  const r = analyze(ctxBase([W(1, [E('db', [{ weight: 50, reps: 6 }])])], { bodyweight: bw.sort((a, b) => b.date.localeCompare(a.date)), profile: { sex: 'male', birthYear: 2005, heightCm: 178, goal: 'cut', activity: 'active' } }));
  const w = r.items.find((i) => i.id.startsWith('rate:'));
  assert.equal(w.tone, 'warn');
  assert.match(w.title, /too fast/);
  assert.match(w.body, /kcal more/);
});

test('plateau: 6+ sessions over 3+ weeks with no new best', () => {
  const ws = [];
  for (let k = 0; k < 7; k++) ws.push(W(2 + k * 4, [E('sq', [{ plates: [45, 45], reps: 5 }, { plates: [45, 45], reps: 5 }])]));
  const r = analyze(ctxBase(ws, { profile: { goal: 'bulk' } }));
  assert.ok(r.items.some((i) => i.id === 'plateau:sq'), r.items.map((i) => i.id).join());
});

test('long gap nudges the next routine; waist over half of height is flagged', () => {
  const r = analyze(ctxBase([W(9, [E('db', [{ weight: 50, reps: 6 }])]), W(12, [E('db', [{ weight: 50, reps: 6 }])])], {
    profile: { heightCm: 170, goal: 'maintain' }, measurements: [{ date: '2026-11-20', waist: 92 }] }));
  const gap = r.items.find((i) => i.id.startsWith('gap:'));
  assert.equal(gap.action.kind, 'start');
  assert.ok(r.items.some((i) => i.id.startsWith('whtr:0.54')));
});

console.log(`${n} tests passed`);
