// Pure calculation helpers — no DOM, no storage. Unit-tested in tests/calc.test.mjs.

export const LOAD_TYPES = {
  total: { label: 'Total lbs', short: 'lb' },
  plates: { label: 'Plates per side', short: 'plates/side' },
  stack: { label: 'Stack plates / pin #', short: 'plates' },
  dumbbell: { label: 'Per dumbbell', short: 'lb ea' },
  bodyweight: { label: 'Bodyweight (+ added lbs)', short: 'BW' },
  cardio: { label: 'Cardio (minutes / avg HR)', short: 'min' },
};

export const SET_TYPES = ['warmup', 'work', 'drop'];

const round1 = (n) => Math.round(n * 10) / 10;
const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function sumPlates(plates) {
  if (!Array.isArray(plates)) return 0;
  return plates.reduce((a, p) => a + (Number(p) || 0), 0);
}

/**
 * Normalised load for one set.
 * Returns { value, unit } where unit is 'lb', 'plates' (stack with unknown lbs/plate) or null.
 * - total:     the entered weight
 * - dumbbell:  weight of ONE dumbbell (kept per-hand so numbers match the rack)
 * - plates:    base (bar / sled) + 2 × plates on one side
 * - stack:     plate count × lbs-per-plate if set, otherwise the plate count itself
 * - bodyweight:added weight (0 = bodyweight only)
 */
export function setLoad(exercise, set) {
  const t = exercise?.loadType || 'total';
  switch (t) {
    case 'plates': {
      const perSide = sumPlates(set.plates);
      const base = num(exercise.baseWeight) || 0;
      if (!perSide && !base) return { value: null, unit: 'lb' };
      return { value: round1(base + 2 * perSide), unit: 'lb' };
    }
    case 'stack': {
      const c = num(set.count);
      if (c === null) return { value: null, unit: 'plates' };
      const per = num(exercise.lbsPerPlate);
      return per ? { value: round1(c * per), unit: 'lb' } : { value: c, unit: 'plates' };
    }
    case 'bodyweight':
      return { value: num(set.weight) ?? 0, unit: 'lb' };
    case 'cardio':
      return { value: null, unit: null };
    default:
      return { value: num(set.weight), unit: 'lb' };
  }
}

/** Epley estimated 1-rep max. Only trusted up to 15 reps. */
export function e1rm(weight, reps) {
  const w = num(weight);
  const r = num(reps);
  if (w === null || r === null || w <= 0 || r <= 0 || r > 15) return null;
  if (r === 1) return round1(w);
  return round1(w * (1 + r / 30));
}

export function isCompletedWorkSet(set) {
  return !!set && set.done && (set.type || 'work') === 'work';
}

/** Human label for a set's load, e.g. "140 lb (45+25/side)" or "3 plates". */
export function formatLoad(exercise, set) {
  const t = exercise?.loadType || 'total';
  const L = setLoad(exercise, set);
  if (t === 'cardio') {
    const parts = [];
    if (num(set.minutes) !== null) parts.push(`${num(set.minutes)} min`);
    if (num(set.hr) !== null) parts.push(`${num(set.hr)} bpm`);
    return parts.join(', ') || '—';
  }
  if (t === 'plates') {
    const p = (set.plates || []).filter((x) => Number(x));
    const side = p.length ? p.join('+') : '0';
    return L.value === null ? '—' : `${fmtNum(L.value)} lb (${side}/side)`;
  }
  if (t === 'stack') {
    if (num(set.count) === null) return '—';
    const c = num(set.count);
    return L.unit === 'lb' ? `${fmtNum(L.value)} lb (${fmtNum(c)} pl)` : `${fmtNum(c)} ${c === 1 ? 'plate' : 'plates'}`;
  }
  if (t === 'bodyweight') return L.value ? `BW +${fmtNum(L.value)}` : 'BW';
  if (t === 'dumbbell') return L.value === null ? '—' : `${fmtNum(L.value)} lb ea`;
  return L.value === null ? '—' : `${fmtNum(L.value)} lb`;
}

export function formatSet(exercise, set) {
  if (exercise?.loadType === 'cardio') return formatLoad(exercise, set);
  const reps = num(set.reps);
  const base = `${formatLoad(exercise, set)} × ${reps ?? '—'}`;
  return num(set.rir) !== null ? `${base} @${num(set.rir)} RIR` : base;
}

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(round1(n));
}

/** Working-set volume for a workout entry, in lb (only when unit is lb; dumbbells count both hands). */
export function entryVolume(exercise, entry) {
  let v = 0;
  for (const s of entry.sets || []) {
    if (!s.done || s.type === 'warmup') continue;
    const L = setLoad(exercise, s);
    const reps = num(s.reps);
    if (L.unit !== 'lb' || L.value === null || reps === null) continue;
    const mult = exercise.loadType === 'dumbbell' ? 2 : 1;
    v += L.value * reps * mult;
  }
  return v;
}

/**
 * Per-session best for one exercise.
 * Returns { e1rm, topWeight, topReps, bestReps, unit, minutes } — fields may be null.
 * Bodyweight-only work (added 0) is tracked by reps.
 */
export function sessionBest(exercise, entry) {
  const out = { e1rm: null, topWeight: null, topReps: null, bestReps: null, unit: null, minutes: null, hr: null };
  for (const s of entry.sets || []) {
    if (!isCompletedWorkSet(s)) continue;
    if (exercise.loadType === 'cardio') {
      const m = num(s.minutes);
      if (m !== null) out.minutes = (out.minutes || 0) + m;
      const hr = num(s.hr);
      if (hr !== null) out.hr = hr;
      continue;
    }
    const L = setLoad(exercise, s);
    const reps = num(s.reps);
    if (reps === null) continue;
    out.unit = L.unit;
    if (out.bestReps === null || reps > out.bestReps) out.bestReps = reps;
    if (L.value !== null && (out.topWeight === null || L.value > out.topWeight || (L.value === out.topWeight && reps > out.topReps))) {
      out.topWeight = L.value;
      out.topReps = reps;
    }
    if (exercise.loadType !== 'bodyweight' || L.value > 0) {
      const est = e1rm(L.value, reps);
      if (est !== null && (out.e1rm === null || est > out.e1rm)) out.e1rm = est;
    }
  }
  return out;
}

/** The single number that represents progress for an exercise. */
export function progressMetric(exercise) {
  if (exercise.loadType === 'cardio') return { key: 'minutes', label: 'Minutes per session', unit: 'min' };
  if (exercise.loadType === 'bodyweight') return { key: 'bestReps', label: 'Best set (reps)', unit: 'reps' };
  return { key: 'e1rm', label: 'Estimated 1-rep max', unit: null };
}

/**
 * Check whether a just-completed set beats the history.
 * history: array of { e1rm, topWeight, bestReps } from previous sessions (and earlier sets today).
 * Returns array of PR labels.
 */
export function prsForSet(exercise, set, history) {
  if (!isCompletedWorkSet(set) || exercise.loadType === 'cardio') return [];
  const L = setLoad(exercise, set);
  const reps = num(set.reps);
  if (reps === null) return [];
  const prs = [];
  const best = (k) => history.reduce((m, h) => (h[k] !== null && h[k] !== undefined && (m === null || h[k] > m) ? h[k] : m), null);
  if (!history.length) return []; // first time doing it isn't a PR, it's a baseline
  if (exercise.loadType === 'bodyweight' && !(L.value > 0)) {
    const b = best('bestReps');
    if (b !== null && reps > b) prs.push('reps');
    return prs;
  }
  const est = e1rm(L.value, reps);
  const bE = best('e1rm');
  if (est !== null && bE !== null && est > bE) prs.push('e1RM');
  const bW = best('topWeight');
  if (L.value !== null && bW !== null && L.value > bW) prs.push('weight');
  return prs;
}

/** Group consecutive entries that share a superset letter. Returns [{group, entries:[{entry, index}]}]. */
export function groupEntries(entries) {
  const out = [];
  entries.forEach((entry, index) => {
    const g = entry.group || null;
    const last = out[out.length - 1];
    if (g && last && last.group === g) last.entries.push({ entry, index });
    else out.push({ group: g, entries: [{ entry, index }] });
  });
  return out;
}

/**
 * Decide whether finishing set `setIndex` of entry `entryIndex` should start the rest timer.
 * - next set is a drop set → no rest (keep going)
 * - superset: only rest when every exercise in the group has finished this round
 * Returns { rest: boolean, next: entryIndex|null } (next = which superset partner is up).
 */
export function restDecision(entries, entryIndex, setIndex) {
  const entry = entries[entryIndex];
  const nextSet = entry.sets[setIndex + 1];
  if (nextSet && nextSet.type === 'drop' && !nextSet.done) return { rest: false, next: entryIndex };
  if (!entry.group) return { rest: true, next: null };
  const blocks = groupEntries(entries);
  const block = blocks.find((b) => b.entries.some((e) => e.index === entryIndex));
  if (!block || block.entries.length < 2) return { rest: true, next: null };
  // round number = how many non-warmup sets of this entry are done
  const round = entry.sets.filter((s) => s.done && s.type !== 'warmup' && s.type !== 'drop').length;
  for (const { entry: other, index } of block.entries) {
    if (index === entryIndex) continue;
    const otherWork = other.sets.filter((s) => s.type !== 'warmup' && s.type !== 'drop');
    const otherDone = otherWork.filter((s) => s.done).length;
    if (otherDone < round && otherWork.length >= round) return { rest: false, next: index };
  }
  return { rest: true, next: null };
}

/** Rolling mean over the previous `days` days (inclusive) for date-sorted [{date:'YYYY-MM-DD', weight}] */
export function rollingAverage(points, days = 7) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((p, i) => {
    const t = Date.parse(p.date + 'T00:00:00');
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0; j--) {
      const tj = Date.parse(sorted[j].date + 'T00:00:00');
      if ((t - tj) / 86400000 > days - 1) break;
      sum += sorted[j].weight;
      n++;
    }
    return { date: p.date, avg: round1(sum / n) };
  });
}

/** Split a plate total for one side into the fewest plates from inventory (greedy). */
export function platesFor(perSide, inventory = [45, 35, 25, 10, 5, 2.5]) {
  const out = [];
  let rem = round1(perSide);
  const inv = [...inventory].sort((a, b) => b - a);
  for (const p of inv) {
    while (rem >= p - 1e-9) {
      out.push(p);
      rem = round1(rem - p);
    }
  }
  return rem > 0 ? null : out;
}

export function todayISO(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
