import assert from 'node:assert/strict';
import { parsePlan, matchExercise, guessLoadType, similarity, linesFromItems, tidyName } from '../js/planparse.js';

let n = 0;
const test = (name, fn) => { fn(); n++; };
const L = (text, size = 12, cells) => ({ text, size, cells: cells || [{ text, x: 50, w: text.length * 6 }] });
const row = (...cols) => { // [text, x] pairs → a table line
  const cells = cols.map(([text, x]) => ({ text, x, w: text.length * 6 }));
  return { text: cells.map((c) => c.text).join('  '), size: 11, cells };
};

test('list format with headings and set x rep lines', () => {
  const r = parsePlan([
    L('12-WEEK PROGRAM', 10), L('Upper A', 30),
    L('Incline DB press 3 x 6-8', 16), L('Pull-up 3 x AMRAP', 16), L('Cable lateral raise 3 x 12-15', 16),
    L('Rest 2-3 min on compounds, 60-90 s on accessories.', 13),
    L('Lower A', 30), L('Romanian deadlift 3 x 6-8', 16), L('Leg press 3 x 10-12', 16),
  ]);
  assert.equal(r.days.length, 2);
  assert.deepEqual(r.days.map((d) => d.name), ['Upper A', 'Lower A']);
  assert.deepEqual(r.days[0].items.map((i) => [i.name, i.sets, i.reps]), [['Incline DB press', 3, '6–8'], ['Pull-up', 3, 'AMRAP'], ['Cable lateral raise', 3, '12–15']]);
});

test('"sets of" wording, A1/A2 supersets, rest and notes', () => {
  const r = parsePlan([
    L('Day 1 – Push', 18),
    L('1. Barbell bench press – 4 sets of 6-8 reps, rest 2 min'),
    L('A1. Overhead triceps extension 3 sets x 12'),
    L('A2) Lateral raises: 3x15 @ RPE 9'),
    L('Plank 3 x 45s'),
  ]);
  const it = r.days[0].items;
  assert.equal(r.days[0].name, 'Push');
  assert.deepEqual([it[0].name, it[0].sets, it[0].reps, it[0].restSec], ['Barbell bench press', 4, '6–8', 120]);
  assert.deepEqual([it[1].name, it[1].group, it[2].name, it[2].group], ['Overhead triceps extension', 'A', 'Lateral raises', 'A']);
  assert.equal(it[2].note, '@ RPE 9');
  assert.deepEqual([it[3].name, it[3].reps], ['Plank', '45s']);
});

test('name on one line, sets on the next', () => {
  const r = parsePlan([L('Lower Body', 20), L('Romanian deadlift'), L('3 x 8'), L('Walking lunges'), L('3 sets of 12 each')]);
  assert.deepEqual(r.days[0].items.map((i) => [i.name, i.sets, i.reps]), [['Romanian deadlift', 3, '8'], ['Walking lunges', 3, '12 each']]);
});

test('table with Exercise / Sets / Reps / Rest columns', () => {
  const r = parsePlan([
    L('Day 2: Pull', 18),
    row(['Exercise', 50], ['Sets', 300], ['Reps', 360], ['Rest', 420], ['Notes', 480]),
    row(['Lat pulldown', 50], ['3', 302], ['8-10', 358], ['90s', 420], ['Slow negatives', 480]),
    row(['Seated cable row', 50], ['3', 302], ['10-12', 358], ['90s', 420]),
    row(['Hammer curl', 50], ['2', 302], ['12', 362], ['60s', 420]),
  ]);
  assert.deepEqual(r.days[0].items.map((i) => [i.name, i.sets, i.reps, i.restSec]), [['Lat pulldown', 3, '8–10', 90], ['Seated cable row', 3, '10–12', 90], ['Hammer curl', 2, '12', 60]]);
  assert.equal(r.days[0].items[0].note, 'Slow negatives');
});

test('multi-week plan keeps each day once', () => {
  const lines = [];
  for (let w = 1; w <= 3; w++) {
    lines.push(L(`Week ${w}`, 20), L(`Week ${w} - Day 1: Upper`, 16), L('Bench press 3 x 8'), L(`Week ${w} - Day 2: Lower`, 16), L('Back squat 3 x 5'));
  }
  const r = parsePlan(lines);
  assert.deepEqual(r.days.map((d) => [d.name, d.items.length]), [['Upper', 1], ['Lower', 1]]);
  assert.equal(r.weeks, 3);
});

test('cardio minutes and weekday headings; rest days skipped', () => {
  const r = parsePlan([L('Monday', 18), L('Squat 5x5'), L('Tuesday', 18), L('Zone 2 cardio 30-45 min'), L('Wednesday', 18), L('Rest day'), L('Thursday', 18), L('Treadmill incline walk: 20 min')]);
  assert.deepEqual(r.days.map((d) => d.name), ['Monday', 'Tuesday', 'Thursday']);
  assert.deepEqual([r.days[1].items[0].reps, r.days[1].items[0].cardio], ['30–45 min', true]);
});

test('no sets or reps anywhere → no days (scanned or prose PDF)', () => {
  assert.equal(parsePlan([L('My fitness journey', 20), L('Train hard, eat well and sleep eight hours every night.')]).days.length, 0);
});

test('exercise matching', () => {
  const lib = ['Incline DB press', 'Bench press (barbell)', 'Lat pulldown', 'Pull-up', 'Incline DB curl', 'Overhead cable triceps extension', 'Back squat', 'Leg press', 'Romanian deadlift (barbell)', 'Cable lateral raise', 'Hammer curl'].map((name, i) => ({ id: `e${i}`, name }));
  const m = (n) => matchExercise(n, lib)?.ex.name ?? null;
  assert.equal(m('Incline Dumbbell Press'), 'Incline DB press');
  assert.equal(m('Barbell Bench Press'), 'Bench press (barbell)');
  assert.equal(m('Bench'), 'Bench press (barbell)');
  assert.equal(m('Pull ups'), 'Pull-up');
  assert.equal(m('Wide grip lat pull-down'), 'Lat pulldown');
  assert.equal(m('RDL'), 'Romanian deadlift (barbell)');
  assert.equal(m('Overhead triceps extension'), 'Overhead cable triceps extension');
  assert.equal(m('Squat'), 'Back squat');
  assert.equal(m('Dumbbell curl'), null, 'standing curl is not the incline curl');
  assert.equal(m('Dumbbell bench press'), null, 'dumbbell vs barbell');
  assert.equal(m('Hammer curls'), 'Hammer curl');
  assert.ok(similarity('Leg press', 'Leg extension') < 0.75);
});

test('load type guesses', () => {
  assert.equal(guessLoadType('Dumbbell bench press').loadType, 'dumbbell');
  assert.deepEqual(guessLoadType('Barbell row'), { loadType: 'plates', baseWeight: 45 });
  assert.equal(guessLoadType('Hack squat').baseWeight, 0);
  assert.equal(guessLoadType('Chin-ups').loadType, 'bodyweight');
  assert.equal(guessLoadType('Cable fly').loadType, 'total');
  assert.equal(guessLoadType('Zone 2 bike').loadType, 'cardio');
  assert.equal(tidyName('BARBELL BENCH PRESS'), 'Barbell Bench Press');
});

test('lines rebuilt from pdf.js items: same baseline joins, wide gaps make cells', () => {
  const it = (str, x, y, size = 12) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size });
  const lines = linesFromItems([[it('Bench', 50, 700), it('press', 86, 700), it('3', 300, 700.5), it('8', 360, 700), it('Upper', 50, 740, 24)]]);
  assert.equal(lines[0].text, 'Upper');
  assert.equal(lines[1].cells.length, 3);
  assert.equal(lines[1].cells[0].text, 'Bench press');
});

console.log(`${n} tests passed`);
