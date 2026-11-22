import assert from 'node:assert/strict';
import * as c from '../js/calc.js';

const ex = (loadType, extra = {}) => ({ loadType, ...extra });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('plates: base + 2x per side', () => {
  assert.deepEqual(c.setLoad(ex('plates', { baseWeight: 45 }), { plates: [45, 45, 10] }), { value: 245, unit: 'lb' });
  assert.deepEqual(c.setLoad(ex('plates', { baseWeight: 0 }), { plates: [45, 25] }), { value: 140, unit: 'lb' });
  assert.equal(c.setLoad(ex('plates', { baseWeight: 0 }), { plates: [] }).value, null);
});
t('stack: plates unless lbs/plate set', () => {
  assert.deepEqual(c.setLoad(ex('stack'), { count: 3 }), { value: 3, unit: 'plates' });
  assert.deepEqual(c.setLoad(ex('stack', { lbsPerPlate: 12.5 }), { count: 3 }), { value: 37.5, unit: 'lb' });
});
t('dumbbell & total', () => {
  assert.equal(c.setLoad(ex('dumbbell'), { weight: '22.5' }).value, 22.5);
  assert.equal(c.setLoad(ex('total'), { weight: '' }).value, null);
});
t('e1rm epley', () => {
  assert.equal(c.e1rm(225, 8), 285);
  assert.equal(c.e1rm(100, 1), 100);
  assert.equal(c.e1rm(100, 20), null);
  assert.equal(c.e1rm(0, 5), null);
});
t('format', () => {
  assert.equal(c.formatLoad(ex('plates', { baseWeight: 45 }), { plates: [45, 45] }), '225 lb (45+45/side)');
  assert.equal(c.formatLoad(ex('stack'), { count: 1 }), '1 plate');
  assert.equal(c.formatSet(ex('dumbbell'), { weight: 50, reps: 8, rir: 1 }), '50 lb ea × 8 @1 RIR');
  assert.equal(c.formatLoad(ex('bodyweight'), { weight: 0 }), 'BW');
  assert.equal(c.formatLoad(ex('cardio'), { minutes: 40, hr: 132 }), '40 min, 132 bpm');
});
t('sessionBest ignores warmups and drops', () => {
  const e = ex('total');
  const b = c.sessionBest(e, { sets: [
    { type: 'warmup', weight: 300, reps: 5, done: true },
    { type: 'work', weight: 130, reps: 7, done: true },
    { type: 'drop', weight: 200, reps: 8, done: true },
    { type: 'work', weight: 140, reps: 3, done: false },
  ] });
  assert.equal(b.topWeight, 130);
  assert.equal(b.e1rm, c.e1rm(130, 7));
});
t('prs', () => {
  const e = ex('total');
  const hist = [{ e1rm: 160, topWeight: 130, bestReps: 8 }];
  assert.deepEqual(c.prsForSet(e, { type: 'work', done: true, weight: 135, reps: 7 }, hist), ['e1RM', 'weight']);
  assert.deepEqual(c.prsForSet(e, { type: 'work', done: true, weight: 120, reps: 8 }, hist), []);
  assert.deepEqual(c.prsForSet(e, { type: 'work', done: true, weight: 120, reps: 8 }, []), []);
  assert.deepEqual(c.prsForSet(ex('bodyweight'), { type: 'work', done: true, weight: 0, reps: 7 }, [{ bestReps: 6 }]), ['reps']);
});
t('rest decision: superset + drop', () => {
  const mk = (group, sets) => ({ group, sets });
  const entries = [
    mk('A', [{ type: 'work', done: true }, { type: 'work', done: false }]),
    mk('A', [{ type: 'work', done: false }, { type: 'work', done: false }]),
    mk(null, [{ type: 'work', done: true }, { type: 'drop', done: false }]),
  ];
  assert.deepEqual(c.restDecision(entries, 0, 0), { rest: false, next: 1 });
  entries[1].sets[0].done = true;
  assert.deepEqual(c.restDecision(entries, 1, 0), { rest: true, next: null });
  assert.deepEqual(c.restDecision(entries, 2, 0), { rest: false, next: 2 });
});
t('rolling avg', () => {
  const r = c.rollingAverage([{ date: '2026-11-01', weight: 170 }, { date: '2026-11-03', weight: 172 }, { date: '2026-11-10', weight: 168 }]);
  assert.deepEqual(r.map((x) => x.avg), [170, 171, 168]);
});
t('platesFor', () => {
  assert.deepEqual(c.platesFor(70), [45, 25]);
  assert.deepEqual(c.platesFor(57.5), [45, 10, 2.5]);
  assert.equal(c.platesFor(1), null);
});
t('groupEntries', () => {
  const g = c.groupEntries([{ group: null }, { group: 'A' }, { group: 'A' }, { group: 'B' }]);
  assert.equal(g.length, 3);
  assert.equal(g[1].entries.length, 2);
});
console.log(`\n${n} tests passed`);
