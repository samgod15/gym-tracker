// First-run data: Sam's exercises, starter routines and the numbers he's logged so far.
// IDs are fixed so a second phone seeds the same records and sync merges instead of duplicating.
// updatedAt = 1 so anything already in the cloud always wins over the seed.

import * as db from './db.js';

const E = (id, name, loadType, opts = {}) => ({
  id, name, loadType,
  baseWeight: opts.base ?? (loadType === 'plates' ? 0 : null),
  lbsPerPlate: null,
  restSec: opts.rest ?? 120,
  muscle: opts.muscle || '',
  notes: opts.notes || '',
  updatedAt: 1, _dirty: 0,
});

export const SEED_EXERCISES = [
  // Sam's current lifts
  E('ex-incline-db-press', 'Incline DB press', 'dumbbell', { rest: 150, muscle: 'Chest' }),
  E('ex-plate-chest-press', 'Chest press (plate-loaded)', 'plates', { rest: 150, muscle: 'Chest', notes: 'Base = machine weight with no plates, if known' }),
  E('ex-pull-up', 'Pull-up', 'bodyweight', { rest: 150, muscle: 'Back' }),
  E('ex-lat-pulldown', 'Lat pulldown', 'total', { rest: 120, muscle: 'Back' }),
  E('ex-cs-row', 'Chest-supported row (plate-loaded)', 'plates', { rest: 120, muscle: 'Back' }),
  E('ex-cable-lateral', 'Cable lateral raise', 'stack', { rest: 75, muscle: 'Shoulders' }),
  E('ex-reverse-pec-deck', 'Reverse pec deck', 'total', { rest: 75, muscle: 'Rear delts' }),
  E('ex-oh-cable-tri', 'Overhead cable triceps extension', 'total', { rest: 90, muscle: 'Triceps' }),
  E('ex-incline-db-curl', 'Incline DB curl', 'dumbbell', { rest: 90, muscle: 'Biceps' }),
  E('ex-cable-crunch', 'Cable crunch', 'total', { rest: 60, muscle: 'Abs' }),
  E('ex-rdl', 'Romanian deadlift (barbell)', 'plates', { base: 45, rest: 150, muscle: 'Hamstrings' }),
  E('ex-leg-press', 'Leg press', 'plates', { rest: 150, muscle: 'Quads', notes: 'Base = sled weight, if posted on the machine' }),
  E('ex-seated-leg-curl', 'Seated leg curl', 'stack', { rest: 90, muscle: 'Hamstrings' }),
  E('ex-smith-calf', 'Calf raise (Smith machine)', 'plates', { rest: 60, muscle: 'Calves' }),
  E('ex-hack-squat', 'Hack squat', 'plates', { rest: 150, muscle: 'Quads' }),
  E('ex-zone2', 'Zone 2 cardio', 'cardio', { rest: 0, muscle: 'Cardio' }),
  // Library extras
  E('ex-db-shoulder-press', 'Seated DB shoulder press', 'dumbbell', { rest: 120, muscle: 'Shoulders' }),
  E('ex-db-bench', 'Flat DB press', 'dumbbell', { rest: 150, muscle: 'Chest' }),
  E('ex-bench', 'Bench press (barbell)', 'plates', { base: 45, rest: 180, muscle: 'Chest' }),
  E('ex-pec-deck', 'Pec deck', 'total', { rest: 75, muscle: 'Chest' }),
  E('ex-seated-cable-row', 'Seated cable row', 'total', { rest: 120, muscle: 'Back' }),
  E('ex-face-pull', 'Face pull', 'total', { rest: 60, muscle: 'Rear delts' }),
  E('ex-tri-pushdown', 'Triceps pushdown', 'total', { rest: 75, muscle: 'Triceps' }),
  E('ex-hammer-curl', 'Hammer curl', 'dumbbell', { rest: 75, muscle: 'Biceps' }),
  E('ex-bb-squat', 'Back squat', 'plates', { base: 45, rest: 180, muscle: 'Quads' }),
  E('ex-deadlift', 'Deadlift', 'plates', { base: 45, rest: 180, muscle: 'Back' }),
  E('ex-hip-thrust', 'Hip thrust (barbell)', 'plates', { base: 45, rest: 120, muscle: 'Glutes' }),
  E('ex-leg-extension', 'Leg extension', 'stack', { rest: 75, muscle: 'Quads' }),
  E('ex-hanging-leg-raise', 'Hanging leg raise', 'bodyweight', { rest: 60, muscle: 'Abs' }),
];

const item = (exerciseId, sets, reps, group = null) => ({ exerciseId, sets, reps, group });

export const SEED_ROUTINES = [
  {
    id: 'rt-upper-a', name: 'Upper A', order: 1, updatedAt: 1, _dirty: 0,
    items: [
      item('ex-incline-db-press', 3, '6–8'),
      item('ex-lat-pulldown', 3, '8–10'),
      item('ex-cs-row', 3, '8–10'),
      item('ex-cable-lateral', 3, '10–15'),
      item('ex-reverse-pec-deck', 2, '12–15'),
      item('ex-oh-cable-tri', 3, '10–12', 'A'),
      item('ex-incline-db-curl', 3, '8–10', 'A'),
      item('ex-cable-crunch', 3, '8–12'),
    ],
  },
  {
    id: 'rt-lower-a', name: 'Lower A', order: 2, updatedAt: 1, _dirty: 0,
    items: [
      item('ex-rdl', 3, '6–8'),
      item('ex-leg-press', 3, '8–10'),
      item('ex-seated-leg-curl', 3, '8–10'),
      item('ex-smith-calf', 3, '10–15'),
    ],
  },
  {
    id: 'rt-zone2', name: 'Zone 2', order: 3, updatedAt: 1, _dirty: 0,
    items: [item('ex-zone2', 1, '30–45 min')],
  },
  {
    id: 'rt-upper-b', name: 'Upper B', order: 4, updatedAt: 1, _dirty: 0,
    items: [
      item('ex-pull-up', 3, 'max'),
      item('ex-plate-chest-press', 3, '6–8'),
      item('ex-cs-row', 3, '6–8'),
      item('ex-cable-lateral', 3, '12–15'),
      item('ex-reverse-pec-deck', 3, '12–15'),
      item('ex-incline-db-curl', 3, '8–10', 'A'),
      item('ex-oh-cable-tri', 3, '10–12', 'A'),
      item('ex-cable-crunch', 3, '8–12'),
    ],
  },
  {
    id: 'rt-lower-b', name: 'Lower B', order: 5, updatedAt: 1, _dirty: 0,
    items: [
      item('ex-leg-press', 3, '10–12'),
      item('ex-rdl', 3, '8–10'),
      item('ex-seated-leg-curl', 3, '10–12'),
      item('ex-smith-calf', 4, '12–15'),
    ],
  },
];

let sid = 0;
const S = (fields) => ({ id: `seed-s${++sid}`, type: 'work', weight: null, plates: [], count: null, reps: null, rir: null, minutes: null, hr: null, done: true, doneAt: null, ...fields });

// Numbers Sam reported in Nov 2026, stored as one "baseline" session so prefill and charts have a start point.
function baselineWorkout() {
  const t = new Date('2026-11-21T18:00:00').getTime();
  const entry = (exerciseId, sets) => ({ exerciseId, group: null, sets: sets.map((s) => S({ ...s, doneAt: t })) });
  return {
    id: 'wo-baseline-2026-11', name: 'Baseline (numbers from chat)', routineId: null,
    startedAt: t, endedAt: t + 60 * 60000, notes: 'Imported starting numbers. Edit or delete anytime.',
    updatedAt: 1, _dirty: 0,
    entries: [
      entry('ex-incline-db-press', [{ weight: 50, reps: 8 }, { weight: 55, reps: 7 }]),
      entry('ex-pull-up', [{ weight: 0, reps: 6 }, { weight: 0, reps: 5 }]),
      entry('ex-plate-chest-press', [{ plates: [45, 10], reps: 5 }, { plates: [45, 25], reps: 1 }]),
      entry('ex-cs-row', [{ plates: [45, 35], reps: 8 }, { plates: [45, 35], reps: 7 }]),
      entry('ex-lat-pulldown', [{ weight: 120, reps: 8 }, { weight: 130, reps: 7 }]),
      entry('ex-cable-lateral', [{ count: 1, reps: 10 }, { count: 2, reps: 7 }, { count: 2, reps: 6 }]),
      entry('ex-reverse-pec-deck', [{ weight: 20, reps: 10 }]),
      entry('ex-oh-cable-tri', [{ weight: 40, reps: 10 }]),
      entry('ex-incline-db-curl', [{ weight: 22.5, reps: 9 }, { weight: 22.5, reps: 8 }]),
      entry('ex-cable-crunch', [{ weight: 45, reps: 8 }, { weight: 50, reps: 7 }]),
      entry('ex-rdl', [{ plates: [45, 45], reps: 8 }, { plates: [45, 45, 10], reps: 7 }]),
      entry('ex-leg-press', [{ plates: [45, 45, 45, 45, 45, 45], reps: 10 }, { plates: [45, 45, 45, 45, 45, 45, 45], reps: 5 }]),
      entry('ex-seated-leg-curl', [{ count: 3, reps: 8 }, { count: 3, reps: 7 }]),
    ],
  };
}

export async function seedIfNeeded() {
  if (await db.meta('seeded')) return false;
  const existingEx = await db.all('exercises', { includeDeleted: true });
  if (!existingEx.length) {
    await db.putRaw('exercises', SEED_EXERCISES, { silent: true });
    await db.putRaw('routines', SEED_ROUTINES, { silent: true });
    await db.putRaw('workouts', [baselineWorkout()], { silent: true });
  }
  await db.setMeta('seeded', true);
  return true;
}
