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
  E('ex-ohp', 'Overhead press (barbell)', 'plates', { base: 45, rest: 150, muscle: 'Shoulders' }),
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

// Starter plans offered to every new user. Routine ids are fixed per plan so two phones that pick
// the same plan merge cleanly when they sync.
const R = (id, name, order, items) => ({ id, name, order, items, updatedAt: 1, _dirty: 0 });

export const TEMPLATES = {
  upperlower: {
    label: 'Upper / Lower',
    desc: '4 lifting days plus an optional Zone 2 cardio day. Good if you can train 4 times a week.',
    routines: SEED_ROUTINES,
  },
  ppl: {
    label: 'Push / Pull / Legs',
    desc: '3 days, or run it twice through for 6. Each muscle group gets its own day.',
    routines: [
      R('rt-push', 'Push', 1, [item('ex-bench', 3, '5–8'), item('ex-db-shoulder-press', 3, '8–10'), item('ex-incline-db-press', 3, '8–12'), item('ex-cable-lateral', 3, '12–15'), item('ex-tri-pushdown', 3, '10–12', 'A'), item('ex-oh-cable-tri', 3, '10–12', 'A')]),
      R('rt-pull', 'Pull', 2, [item('ex-pull-up', 3, 'max'), item('ex-lat-pulldown', 3, '8–10'), item('ex-seated-cable-row', 3, '8–12'), item('ex-face-pull', 3, '12–15'), item('ex-incline-db-curl', 3, '8–12', 'A'), item('ex-hammer-curl', 3, '10–12', 'A')]),
      R('rt-legs', 'Legs', 3, [item('ex-bb-squat', 3, '5–8'), item('ex-rdl', 3, '8–10'), item('ex-leg-press', 3, '10–12'), item('ex-seated-leg-curl', 3, '10–12'), item('ex-leg-extension', 3, '12–15'), item('ex-smith-calf', 4, '10–15')]),
    ],
  },
  fullbody: {
    label: 'Full Body A / B',
    desc: '3 days a week, alternating A and B. Best for beginners or a busy schedule.',
    routines: [
      R('rt-full-a', 'Full Body A', 1, [item('ex-bb-squat', 3, '5–8'), item('ex-bench', 3, '5–8'), item('ex-seated-cable-row', 3, '8–12'), item('ex-db-shoulder-press', 2, '8–12'), item('ex-cable-crunch', 3, '10–15')]),
      R('rt-full-b', 'Full Body B', 2, [item('ex-rdl', 3, '6–10'), item('ex-incline-db-press', 3, '8–12'), item('ex-lat-pulldown', 3, '8–12'), item('ex-leg-press', 3, '10–12'), item('ex-hammer-curl', 2, '10–12')]),
    ],
  },
  empty: {
    label: 'Start empty',
    desc: 'No routines. Build your own from the exercise library.',
    routines: [],
  },
};

/**
 * First launch: returns 'onboard' when this phone has no data yet (show the welcome flow),
 * otherwise false. Phones that already have data (or got it from sync) are left alone.
 */
export async function seedIfNeeded() {
  if (await db.meta('seeded')) return false;
  const existingEx = await db.all('exercises', { includeDeleted: true });
  if (existingEx.length) {
    await db.setMeta('seeded', true);
    return false;
  }
  return 'onboard';
}

/** Called at the end of the welcome flow. */
export async function seedNewUser(templateKey = 'upperlower') {
  const existingEx = new Set((await db.all('exercises', { includeDeleted: true })).map((e) => e.id));
  await db.putRaw('exercises', SEED_EXERCISES.filter((e) => !existingEx.has(e.id)), { silent: true });
  const tpl = TEMPLATES[templateKey] || TEMPLATES.empty;
  const existingRt = new Set((await db.all('routines', { includeDeleted: true })).map((r) => r.id));
  await db.putRaw('routines', tpl.routines.filter((r) => !existingRt.has(r.id)), { silent: true });
  await db.setMeta('seeded', true);
}
