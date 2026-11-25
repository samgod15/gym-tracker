// Personal coach: suggestions that get more specific the more someone logs.
// Pure functions over the app's data (no DOM, no storage) so they can be unit-tested in Node.
//
// Rules and where their numbers come from:
//   • add load when every set reaches the top of the rep range: ACSM 2009 progression models
//     ("2–10% increase in load … when the individual can perform the current workload for one to two
//     repetitions over the desired number")
//   • ≥10 hard sets per muscle per week: Schoenfeld 2017; more volume helps with diminishing returns: Pelland 2024
//   • train each muscle at least twice a week: Schoenfeld 2016
//   • fat loss at 0.5–1% of body weight a week: Helms 2014 and later reviews
//   • lean gain at 0.25–0.5% of body weight a week: Iraki 2019
//   • 0.4–0.5 g/kg protein per meal: Helms 2014
//   • waist under half your height: NICE 2022
// Plateau and deload detection are judgment calls built on those, not single published cut-offs.

import * as calc from './calc.js';
import * as B from './body.js';

const DAY = 86400000;
const LB = 2.20462;

export const SOURCES = {
  progression: 'ACSM position stand: add 2–10% load once you beat the target reps',
  volume: 'Schoenfeld 2017, Pelland 2024: ~10+ hard sets per muscle per week grows more muscle',
  frequency: 'Schoenfeld 2016: training a muscle twice a week beats once',
  cut: 'Helms 2014 and later reviews: lose 0.5–1% of body weight a week to keep muscle',
  bulk: 'Iraki 2019: gain about 0.25–0.5% of body weight a week',
  protein: 'Helms 2014: 0.4–0.5 g of protein per kg of body weight per meal',
  whtr: 'NICE 2022: keep your waist to less than half your height',
  sessions: 'ACSM: 2–3 sessions a week for newer lifters, 3–4 for intermediate',
  judgment: 'Coach rule of thumb, based on your own logs',
};

// ---------------------------------------------------------------- muscles
const MUSCLE_RULES = [
  [/rear delt|reverse (pec|fly)|face pull/i, 'Rear delts'],
  [/lateral raise|side raise|upright row|lat raise/i, 'Shoulders'],
  [/overhead press|shoulder press|military|\bohp\b|arnold|front raise|landmine press/i, 'Shoulders'],
  [/leg curl|hamstring|nordic|\brdl\b|romanian|stiff[\s-]?leg|good morning|glute[\s-]?ham/i, 'Hamstrings'],
  [/leg extension|squat|leg press|lunge|step[\s-]?up|hack|sissy|pendulum/i, 'Quads'],
  [/hip thrust|glute|bridge|kickback|abduct/i, 'Glutes'],
  [/calf/i, 'Calves'],
  [/crunch|plank|\babs?\b|core|leg raise|knee raise|sit[\s-]?up|pallof|wheel|rollout|dead bug/i, 'Abs'],
  [/pulldown|pull[\s-]?down|pull[\s-]?up|chin[\s-]?up|\brow\b|rows\b|\blat\b|lats\b|pullover/i, 'Back'],
  [/bench|chest|\bpec|fly|flye|push[\s-]?up|\bdips?\b/i, 'Chest'],
  [/curl/i, 'Biceps'],
  [/tricep|pushdown|push[\s-]?down|skull|close[\s-]?grip|extension|kickback/i, 'Triceps'],
  [/deadlift|back extension|hyperextension/i, 'Back'],
  [/shrug/i, 'Traps'],
  [/zone ?2|cardio|run|jog|walk|bike|cycl|elliptical|stair|treadmill|rower|erg|swim|hiit/i, 'Cardio'],
];

/** Best guess of the main muscle an exercise works, from its name. */
export function guessMuscle(name) {
  for (const [re, m] of MUSCLE_RULES) if (re.test(name || '')) return m;
  return '';
}

const GROUP = { 'Rear delts': 'Shoulders', Traps: 'Back', Glutes: 'Glutes', Abs: 'Abs', Cardio: null };
const groupOf = (ex) => {
  const m = ex.muscle || guessMuscle(ex.name);
  if (!m) return null;
  const key = Object.keys(GROUP).find((k) => k.toLowerCase() === m.toLowerCase());
  if (key) return GROUP[key];
  const cap = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  return ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Quads', 'Hamstrings', 'Calves'].includes(cap) ? cap : null;
};
/** Half-credit for muscles that help in compound lifts (the "fractional sets" idea in Pelland 2024). */
function indirect(ex, group) {
  const n = ex.name || '';
  if (group === 'Chest' && /press|push[\s-]?up|\bdips?\b/i.test(n)) return ['Triceps'];
  if (group === 'Shoulders' && /press/i.test(n)) return ['Triceps'];
  if (group === 'Back' && /row|pulldown|pull[\s-]?up|chin/i.test(n)) return ['Biceps'];
  if (group === 'Quads' && /squat|leg press|lunge|step[\s-]?up|hack/i.test(n)) return ['Glutes'];
  if (group === 'Hamstrings' && /deadlift|rdl|romanian|good morning|stiff/i.test(n)) return ['Glutes'];
  return [];
}
const PULL = (ex) => /row|pulldown|pull[\s-]?up|chin|face pull|rear delt|reverse (pec|fly)|curl(?!.*leg)/i.test(ex.name) && !/leg curl/i.test(ex.name);
const PUSH = (ex) => /press|push[\s-]?up|\bdips?\b|fly|flye|pushdown|tricep|lateral raise|front raise/i.test(ex.name) && !/leg press/i.test(ex.name);

// ---------------------------------------------------------------- history helpers
/** exerciseId → [{ at, entry, workout }] newest first, finished workouts only. */
export function historyByExercise(workouts) {
  const map = new Map();
  for (const w of workouts) {
    if (!w.endedAt) continue;
    for (const entry of w.entries || []) {
      if (!map.has(entry.exerciseId)) map.set(entry.exerciseId, []);
      map.get(entry.exerciseId).push({ at: w.startedAt, entry, workout: w });
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.at - a.at);
  return map;
}

/** "6–8" → [6, 8]; "10" → [10, 10]; "8+" → [8, 30]; AMRAP / seconds / minutes → null */
export function parseRange(s) {
  if (!s) return null;
  const t = String(s).toLowerCase();
  if (/amrap|max|fail|\d\s*s\b|sec|min/.test(t)) return null;
  const m = /(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})/.exec(t);
  if (m) { const a = +m[1]; const b = +m[2]; return a <= b ? [a, b] : [b, a]; }
  const p = /(\d{1,2})\s*\+/.exec(t);
  if (p) return [+p[1], 30];
  const one = /(\d{1,2})/.exec(t);
  return one ? [+one[1], +one[1]] : null;
}

function targetRepsFor(exId, hist, routines) {
  const last = hist[0];
  const rt = last && routines.find((r) => r.id === last.workout.routineId);
  const item = rt?.items.find((i) => i.exerciseId === exId) || routines.flatMap((r) => r.items).find((i) => i.exerciseId === exId);
  if (item?.reps) return item.reps;
  const fromEntry = /×\s*([^,]+)/.exec(last?.entry?.target || '');
  return fromEntry ? fromEntry[1].trim() : '';
}

const workSets = (entry) => (entry.sets || []).filter(calc.isCompletedWorkSet);
const r5 = (x) => Math.round(x / 5) * 5;

function plateStep(ex, top, settings) {
  const inv = settings?.plates || [45, 35, 25, 10, 5, 2.5];
  const small = inv.includes(2.5) ? 2.5 : inv.includes(5) ? 5 : Math.min(...inv);
  return top < 135 ? small : Math.max(small, inv.includes(5) ? 5 : small);
}

/**
 * What to try next time for one exercise, from its last session.
 * Returns null, or { kind: 'up'|'reps'|'down'|'hold', title, detail, apply }.
 * apply: { weight } | { plates } | { count } — values to put into this workout's unchecked sets.
 */
export function nextTarget(ex, hist, targetReps, settings) {
  if (!ex || !hist?.length || ex.loadType === 'cardio') return null;
  const sets = workSets(hist[0].entry);
  if (!sets.length) return null;
  const range = parseRange(targetReps);
  const loads = sets.map((s) => calc.setLoad(ex, s).value);
  if (loads.some((v) => v === null || v === undefined)) return null;
  const top = Math.max(...loads);
  const topSets = sets.filter((s, i) => loads[i] >= top - 1e-9);
  const reps = topSets.map((s) => Number(s.reps) || 0);
  const minReps = Math.min(...reps);
  const rirs = topSets.map((s) => s.rir).filter((r) => r !== null && r !== undefined);
  const easy = rirs.length >= Math.ceil(topSets.length / 2) && rirs.reduce((a, b) => a + b, 0) / rirs.length >= 3;
  const [lo, hi] = range || [null, null];
  const unit = ex.loadType === 'dumbbell' ? ' lb ea' : ex.loadType === 'stack' && !ex.lbsPerPlate ? ' plates' : ' lb';
  const rangeTxt = range ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : '';
  const fmt = (v) => `${calc.fmtNum(v)}${unit}`;
  const ready = range ? (minReps >= hi || (easy && minReps >= lo)) : minReps >= 13;
  const why = range
    ? minReps >= hi ? `you got ${hi}+ reps on every set at ${fmt(top)}` : `your sets at ${fmt(top)} felt easy (RIR ${Math.round(rirs.reduce((a, b) => a + b, 0) / rirs.length)}+)`
    : `you did ${minReps}+ reps on every set`;

  if (ex.loadType === 'bodyweight') {
    if (!ready) return null;
    return top > 0
      ? { kind: 'up', title: `Try +${calc.fmtNum(top + 5)} lb`, detail: `Last time ${why}.`, apply: { weight: top + 5 } }
      : { kind: 'up', title: hi ? `Add weight or go past ${hi} reps` : 'Add weight (belt or dumbbell)', detail: `Last time ${why}.`, apply: null };
  }

  if (ready) {
    let next; let apply; let extra = '';
    if (ex.loadType === 'plates') {
      const step = plateStep(ex, top, settings);
      const perSide = (top - (Number(ex.baseWeight) || 0)) / 2 + step;
      const plates = calc.platesFor(perSide, settings?.plates);
      next = top + step * 2;
      apply = plates ? { plates } : null;
      extra = ` (+${calc.fmtNum(step)} per side)`;
    } else if (ex.loadType === 'stack') {
      const maxCount = sets.reduce((m, s) => Math.max(m, Number(s.count) || 0), 0);
      next = ex.lbsPerPlate ? (maxCount + 1) * Number(ex.lbsPerPlate) : maxCount + 1;
      apply = { count: maxCount + 1 };
      extra = ex.lbsPerPlate ? '' : ' (next pin)';
    } else if (ex.loadType === 'dumbbell') {
      next = top + (top < 25 ? 2.5 : 5);
      apply = { weight: next };
    } else {
      next = top >= 150 ? r5(top + 10) : top + 5;
      apply = { weight: next };
    }
    const pct = Math.round(((next - top) / top) * 100);
    return { kind: 'up', title: `Try ${fmt(next)}${extra}${rangeTxt ? ` × ${rangeTxt}` : ''}`, detail: `Last time ${why}. That's a ${pct}% jump${pct > 10 ? ', the smallest step available' : ''}.`, apply, next };
  }

  if (range && minReps < lo) {
    // missed the bottom of the range twice in a row at the same load → come down a bit
    const prev = hist[1] ? workSets(hist[1].entry) : [];
    const prevTop = prev.length ? Math.max(...prev.map((s) => calc.setLoad(ex, s).value || 0)) : null;
    const prevMin = prev.length ? Math.min(...prev.filter((s) => (calc.setLoad(ex, s).value || 0) >= top - 1e-9).map((s) => Number(s.reps) || 0)) : null;
    if (prevTop !== null && Math.abs(prevTop - top) < 1e-9 && prevMin !== null && prevMin < lo) {
      let down = ex.loadType === 'stack' ? top - (ex.lbsPerPlate ? Number(ex.lbsPerPlate) : 1) : top * 0.9;
      down = ex.loadType === 'dumbbell' ? Math.max(2.5, Math.floor(down / 2.5) * 2.5) : ex.loadType === 'stack' ? Math.max(1, down) : Math.max(5, r5(down));
      return { kind: 'down', title: `Drop to ${fmt(down)} × ${rangeTxt}`, detail: `Two sessions in a row under ${lo} reps at ${fmt(top)}. About 10% lighter lets you build back up inside the range.`, apply: ex.loadType === 'stack' ? { count: down } : ex.loadType === 'plates' ? null : { weight: down } };
    }
    return { kind: 'hold', title: `Stay at ${fmt(top)}, aim for ${lo}+`, detail: `You got ${minReps} last time. Hit ${lo}–${hi} on every set before adding weight.`, apply: null };
  }
  if (range) return { kind: 'reps', title: `Stay at ${fmt(top)}, go for ${Math.min(hi, minReps + 1)}+ reps`, detail: `Add a rep per set each session. At ${hi} on every set, add weight.`, apply: null };
  return null;
}

// ---------------------------------------------------------------- the analysis
/**
 * ctx: { now, profile, settings, exercises: Map, routines, workouts (newest first), bodyweight (newest first),
 *        measurements (newest first), nextRoutineId }
 * Returns { items, unlocks, stats, weekPlan }
 */
export function analyze(ctx) {
  const now = ctx.now || Date.now();
  const exById = (id) => ctx.exercises.get(id);
  const finished = (ctx.workouts || []).filter((w) => w.endedAt);
  const real = finished.filter((w) => !String(w.id).startsWith('wo-baseline'));
  const hist = historyByExercise(finished);
  const bw = ctx.bodyweight || [];
  const ms = ctx.measurements || [];
  const profile = ctx.profile || {};
  const goal = profile.goal || 'maintain';
  const latestBW = bw[0]?.weight || null;
  const items = [];
  const add = (it) => items.push({ tone: 'do', priority: 50, ...it });

  // ---------- stats
  const since28 = real.filter((w) => w.startedAt >= now - 28 * DAY);
  const firstReal = real.length ? real[real.length - 1].startedAt : null;
  const spanDays = since28.length ? Math.max(7, Math.min(28, (now - Math.min(...since28.map((w) => w.startedAt))) / DAY)) : 0;
  const perWeek = since28.length ? since28.length / (spanDays / 7) : 0;
  const daysSince = real.length ? Math.floor((now - real[0].startedAt) / DAY) : null;
  const maxSessions = Math.max(0, ...[...hist.values()].map((l) => l.length));
  const weighIns28 = bw.filter((p) => Date.parse(p.date + 'T12:00:00') >= now - 28 * DAY);
  const bwSpan = weighIns28.length > 1 ? (Date.parse(weighIns28[0].date) - Date.parse(weighIns28[weighIns28.length - 1].date)) / DAY : 0;
  const t = B.targets(profile, latestBW);

  // ---------- unlocks: what the coach can see so far
  const unlocks = [
    { key: 'profile', label: 'Calorie and protein targets', have: t ? 1 : 0, need: 1, hint: 'Fill in your profile' },
    { key: 'progress', label: 'Next weight for each lift', have: Math.min(maxSessions, 1), need: 1, hint: 'Finish a workout' },
    { key: 'volume', label: 'Sets per muscle each week', have: since28.length >= 4 && spanDays >= 12 ? 4 : Math.min(3, since28.length), need: 4, hint: '4 workouts over 2 weeks' },
    { key: 'trend', label: 'Calorie check from your weight trend', have: weighIns28.length >= 4 && bwSpan >= 10 ? 4 : Math.min(3, weighIns28.length), need: 4, hint: '4 weigh-ins over 10+ days' },
    { key: 'plateau', label: 'Plateau alerts', have: Math.min(maxSessions, 6), need: 6, hint: '6 sessions of one lift' },
    { key: 'body', label: 'Waist and body-fat trends', have: Math.min(ms.filter((m) => m.waist).length, 2), need: 2, hint: '2 waist measurements' },
  ];

  // ---------- TRAINING: progression per lift (most recent first, only lifts done in the last 3 weeks)
  const progress = [];
  for (const [exId, list] of hist) {
    const ex = exById(exId);
    if (!ex || ex.deleted || ex.loadType === 'cardio' || list[0].at < now - 21 * DAY) continue;
    const nt = nextTarget(ex, list, targetRepsFor(exId, list, ctx.routines || []), ctx.settings);
    if (nt) progress.push({ ex, nt, at: list[0].at });
  }
  const ups = progress.filter((p) => p.nt.kind === 'up').sort((a, b) => b.at - a.at);
  if (ups.length) {
    add({ id: `up:${ups.map((p) => p.ex.id).sort().join(',')}`, area: 'training', tone: 'do', priority: 80,
      title: ups.length === 1 ? `Go heavier on ${ups[0].ex.name}` : `${ups.length} lifts are ready to go heavier`,
      body: ups.slice(0, 4).map((p) => `${p.ex.name}: ${p.nt.title.replace(/^Try /, '')}`).join('\n') + (ups.length > 4 ? `\n+${ups.length - 4} more` : ''),
      why: SOURCES.progression, list: ups.map((p) => ({ name: p.ex.name, text: p.nt.title, detail: p.nt.detail })) });
  }
  const downs = progress.filter((p) => p.nt.kind === 'down');
  for (const p of downs.slice(0, 2)) {
    add({ id: `down:${p.ex.id}`, area: 'training', tone: 'warn', priority: 70, title: `${p.ex.name}: drop the weight a little`, body: `${p.nt.title}. ${p.nt.detail}`, why: SOURCES.judgment });
  }

  // ---------- TRAINING: plateaus (6+ sessions over 3+ weeks, no new best in the last 3)
  for (const [exId, list] of hist) {
    const ex = exById(exId);
    if (!ex || ex.deleted || ex.loadType === 'cardio' || ex.loadType === 'bodyweight' || list.length < 6) continue;
    const recent = list.slice(0, 3); const before = list.slice(3, 8);
    if (recent[0].at < now - 21 * DAY || recent[0].at - list[list.length - 1].at < 21 * DAY) continue;
    const best = (arr) => Math.max(0, ...arr.map((r) => calc.sessionBest(ex, r.entry).e1rm || 0));
    const bRecent = best(recent); const bBefore = best(before);
    if (!bBefore || bRecent > bBefore * 1.01) continue;
    const bestAll = Math.max(bRecent, bBefore);
    const firstHit = [...list].reverse().find((r) => (calc.sessionBest(ex, r.entry).e1rm || 0) >= bestAll - 1e-9) || list[list.length - 1];
    const weeks = Math.max(2, Math.round((now - firstHit.at) / (7 * DAY)));
    if (goal === 'cut') {
      add({ id: `plateau:${exId}`, area: 'training', tone: 'good', priority: 30, title: `${ex.name}: holding strength on a cut`, body: `No new best in ${weeks} weeks, but keeping your strength while losing fat is the win right now. No change needed.`, why: SOURCES.judgment });
    } else {
      const r = parseRange(targetRepsFor(exId, list, ctx.routines || []));
      const swap = r ? (r[1] <= 8 ? `${r[0] + 4}–${r[1] + 4}` : `${Math.max(4, r[0] - 4)}–${Math.max(6, r[1] - 4)}`) : '';
      add({ id: `plateau:${exId}`, area: 'training', tone: 'warn', priority: 65, title: `${ex.name} has stalled for ${weeks} weeks`,
        body: `Best estimated max ${calc.fmtNum(bRecent)} lb, same as ${weeks} weeks ago. Pick one for the next 4–6 weeks: ${swap ? `switch to ${swap} reps, ` : ''}add one set, or swap to a close variation. If everything feels heavy lately, check sleep and that you're eating enough.`,
        why: SOURCES.judgment, action: { label: 'See progress', kind: 'route', to: `#/exercise/${exId}` } });
    }
  }

  // ---------- TRAINING: weekly sets per muscle and how often each is trained (needs 2 weeks)
  let volume = null;
  if (since28.length >= 4 && spanDays >= 12) {
    const weeks = spanDays / 7;
    const sets = {}; const days = {}; let push = 0; let pull = 0;
    for (const w of since28) {
      for (const e of w.entries || []) {
        const ex = exById(e.exerciseId);
        if (!ex) continue;
        const g = groupOf(ex);
        const n = workSets(e).length;
        if (!g || !n) continue;
        sets[g] = (sets[g] || 0) + n;
        (days[g] = days[g] || new Set()).add(new Date(w.startedAt).toDateString());
        for (const ig of indirect(ex, g)) sets[ig] = (sets[ig] || 0) + n * 0.5;
        if (PULL(ex)) pull += n; else if (PUSH(ex)) push += n;
      }
    }
    volume = Object.fromEntries(Object.entries(sets).map(([g, s]) => [g, { sets: Math.round((s / weeks) * 10) / 10, freq: Math.round(((days[g]?.size || 0) / weeks) * 10) / 10 }]));
    const majors = ['Chest', 'Back', 'Shoulders', 'Quads', 'Hamstrings'];
    const low = majors.filter((g) => (volume[g]?.sets || 0) < 10).map((g) => [g, volume[g]?.sets || 0]);
    const missing = low.filter(([, s]) => s === 0).map(([g]) => g);
    if (missing.length && goal !== 'maintain') {
      add({ id: `missing:${missing.join(',')}`, area: 'training', tone: 'warn', priority: 60, title: `No ${missing.join(' or ').toLowerCase()} work in your log`,
        body: `In the last ${Math.round(weeks)} weeks nothing trained ${missing.join(', ').toLowerCase()}. Add an exercise for it to a routine you already do.`, why: SOURCES.volume, action: { label: 'Edit routines', kind: 'route', to: '#/train' } });
    }
    const lowSome = low.filter(([, s]) => s > 0);
    if (lowSome.length && (goal === 'bulk' || goal === 'recomp' || goal === 'cut')) {
      add({ id: `lowvol:${lowSome.map(([g]) => g).join(',')}`, area: 'training', tone: 'do', priority: 55, title: `Add a few sets for ${lowSome.map(([g]) => g.toLowerCase()).join(', ')}`,
        body: `${lowSome.map(([g, s]) => `${g}: ${calc.fmtNum(s)} sets a week`).join('\n')}\nAround 10+ hard sets per muscle a week tends to build more muscle${goal === 'cut' ? ' and keep more of it while dieting' : ''}. Adding 1–2 sets to an exercise you already do is the easiest fix.`,
        why: SOURCES.volume });
    }
    const high = Object.entries(volume).filter(([g, v]) => v.sets > 25 && g !== 'Abs').map(([g, v]) => `${g}: ${calc.fmtNum(v.sets)}`);
    if (high.length) add({ id: `highvol:${high.join(',')}`, area: 'training', tone: 'info', priority: 25, title: 'Very high volume for some muscles', body: `${high.join(', ')} sets a week. More can still help, with smaller returns. If joints ache or numbers drop, trim 2–4 sets.`, why: SOURCES.volume });
    const once = majors.filter((g) => volume[g] && volume[g].sets >= 4 && volume[g].freq < 1.5).map((g) => g.toLowerCase());
    if (once.length) add({ id: `freq:${once.join(',')}`, area: 'training', tone: 'do', priority: 45, title: `Train ${once.join(', ')} twice a week`, body: `Right now each gets about one session a week. Spreading the same sets over two sessions tends to grow more muscle.`, why: SOURCES.frequency });
    if (push > 12 && pull > 0 && push / pull >= 1.6) add({ id: 'balance:pushpull', area: 'training', tone: 'do', priority: 40, title: 'More pulling to balance your pressing', body: `${push} pushing sets vs ${pull} pulling sets in the last ${Math.round(weeks)} weeks. Add a row, pulldown or face pull to even it out for your shoulders.`, why: SOURCES.judgment });
  }

  // ---------- PLANNING: consistency, schedule, program fit
  const routines = (ctx.routines || []).filter((r) => r.items?.length);
  const lifting = routines.filter((r) => !r.items.every((i) => exById(i.exerciseId)?.loadType === 'cardio'));
  const nextRt = routines.find((r) => r.id === ctx.nextRoutineId) || routines[0];
  if (real.length >= 2 && daysSince !== null && daysSince >= 5 && nextRt) {
    add({ id: `gap:${real[0].id}`, area: 'planning', tone: 'do', priority: 75, title: `${daysSince} days since your last workout`, body: `Next up is ${nextRt.name}. Even a shorter session keeps the habit going.`, action: { label: `Start ${nextRt.name}`, kind: 'start', routineId: nextRt.id }, why: SOURCES.judgment });
  }
  let weekPlan = null;
  if (real.length >= 4 && routines.length) {
    const recent = real.filter((w) => w.startedAt >= now - 56 * DAY);
    const counts = Array(7).fill(0);
    recent.forEach((w) => counts[new Date(w.startedAt).getDay()]++);
    const n = Math.max(1, Math.min(6, Math.round(perWeek || recent.length / 8)));
    const usual = counts.map((c, d) => [d, c]).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([d]) => d).sort((a, b) => a - b);
    if (usual.length) {
      const order = [...routines].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      let idx = Math.max(0, order.findIndex((r) => r.id === nextRt?.id));
      const today = new Date(now); today.setHours(12, 0, 0, 0);
      const doneToday = real[0] && new Date(real[0].startedAt).toDateString() === new Date(now).toDateString();
      weekPlan = [];
      for (let i = doneToday ? 1 : 0; i < 8 && weekPlan.length < usual.length; i++) {
        const d = new Date(today.getTime() + i * DAY);
        if (usual.includes(d.getDay())) { weekPlan.push({ date: d.toISOString().slice(0, 10), day: d.getDay(), routineId: order[idx % order.length].id, name: order[idx % order.length].name }); idx++; }
      }
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      add({ id: `plan:${weekPlan.map((p) => p.date + p.routineId).join()}`, area: 'planning', tone: 'info', priority: 35, title: 'Your week, based on when you usually train',
        body: weekPlan.map((p) => `${names[p.day]}: ${p.name}`).join('\n'), why: SOURCES.judgment, weekPlan });
    }
  }
  if (firstReal && now - firstReal >= 28 * DAY && perWeek > 0 && perWeek < 2.2 && lifting.length >= 4) {
    add({ id: 'fit:fewer-days', area: 'planning', tone: 'do', priority: 50, title: `Your plan has ${lifting.length} lifting days; you average ${calc.fmtNum(Math.round(perWeek * 10) / 10)} a week`,
      body: 'At that pace each workout comes around only every 2–3 weeks, so most muscles get trained once in that time. A 3-day full-body or upper/lower plan would hit everything about twice a week on the days you actually go.', why: SOURCES.sessions });
  }
  // streak: weeks in a row with 2+ workouts
  if (real.length >= 6) {
    let streak = 0;
    for (let k = 0; k < 26; k++) {
      const from = now - (k + 1) * 7 * DAY; const to = now - k * 7 * DAY;
      if (real.filter((w) => w.startedAt >= from && w.startedAt < to).length >= 2) streak++; else break;
    }
    if (streak >= 3) add({ id: `streak:${streak}`, area: 'planning', tone: 'good', priority: 20, title: `${streak} weeks in a row with 2+ workouts`, body: 'Consistency is the thing that drives every other number here. Keep it going.', why: SOURCES.judgment });
  }

  // ---------- NUTRITION
  if (!t) {
    add({ id: 'profile', area: 'nutrition', tone: 'do', priority: 70, title: 'Add your details for calorie and protein targets', body: 'Sex, age, height and one weigh-in. They also rate your lifts against people your size.', action: { label: 'Set up profile', kind: 'profile' }, why: null });
  } else {
    const rate = B.weeklyRate(bw, 28, now);
    const pct = (lb) => (latestBW ? (lb / latestBW) * 100 : 0);
    if (rate === null) {
      const left = Math.max(1, 4 - weighIns28.length);
      add({ id: 'weighins', area: 'nutrition', tone: 'info', priority: 40, title: `Log ${left} more weigh-in${left === 1 ? '' : 's'} to check your calories`, body: 'Weigh in 3 or more mornings a week, same conditions each time. After about 2 weeks the coach compares your real rate of change to your goal and adjusts your calories.', action: { label: 'Log weight', kind: 'route', to: '#/body' }, why: null });
    } else {
      const adv = B.trendAdvice(rate, t);
      const [lo, hi] = t.rateRange;
      const rateTxt = `${rate < 0 ? 'losing' : 'gaining'} ${calc.fmtNum(Math.abs(Math.round(rate * 10) / 10))} lb a week (${calc.fmtNum(Math.abs(Math.round(pct(rate) * 100) / 100))}% of body weight)`;
      const goalTxt = `${calc.fmtNum(Math.round(Math.abs(lo) * 10) / 10)}–${calc.fmtNum(Math.round(Math.abs(hi) * 10) / 10)} lb`;
      const why = goal === 'cut' ? SOURCES.cut : goal === 'bulk' ? SOURCES.bulk : SOURCES.judgment;
      if (adv.status === 'on') {
        add({ id: `rate:on:${Math.round(rate * 10)}`, area: 'nutrition', tone: 'good', priority: 30, title: 'Your weight is moving at the right pace', body: `You're ${rateTxt}, inside the ${goalTxt} a week that fits "${t.goal.label}". Keep eating about ${t.kcal.toLocaleString()} kcal.`, why });
      } else {
        const newK = Math.round((t.kcal + adv.adjust) / 10) * 10;
        const fastLoss = rate < lo;
        let title; let body;
        if (goal === 'cut' && fastLoss) { title = 'You’re losing weight too fast'; body = `You're ${rateTxt}. Faster than ${goalTxt} a week costs more muscle. Eat about ${Math.abs(adv.adjust)} kcal more: ~${newK.toLocaleString()} a day.`; }
        else if (goal === 'cut') { title = 'Fat loss has slowed'; body = `You're ${rateTxt}; the target is ${goalTxt} a week. Eat about ${Math.abs(adv.adjust)} kcal less (~${newK.toLocaleString()} a day), or add 2,000–3,000 steps a day.`; }
        else if (goal === 'bulk' && !fastLoss) { title = 'You’re gaining faster than a lean bulk'; body = `You're ${rateTxt}. Above ${goalTxt} a week, more of the gain is fat. Eat about ${Math.abs(adv.adjust)} kcal less: ~${newK.toLocaleString()} a day.`; }
        else if (goal === 'bulk') { title = 'Not gaining enough to build muscle'; body = `You're ${rateTxt}; aim for ${goalTxt} a week. Eat about ${Math.abs(adv.adjust)} kcal more: ~${newK.toLocaleString()} a day.`; }
        else { title = fastLoss ? 'Your weight is dropping' : 'Your weight is creeping up'; body = `You're ${rateTxt}; for "${t.goal.label}" it should stay within ${goalTxt} a week. Adjust by about ${Math.abs(adv.adjust)} kcal: ~${newK.toLocaleString()} a day.`; }
        add({ id: `rate:${adv.status}:${Math.round(rate * 10)}`, area: 'nutrition', tone: 'warn', priority: 78, title, body, why });
        // cutting fast and lifts dropping
        if (goal === 'cut' && fastLoss) {
          const dropping = [...hist.entries()].filter(([id, list]) => {
            const ex = exById(id);
            if (!ex || ex.loadType === 'cardio' || ex.loadType === 'bodyweight' || list.length < 3 || list[0].at < now - 14 * DAY) return false;
            const latest = calc.sessionBest(ex, list[0].entry).e1rm;
            const old = Math.max(0, ...list.filter((r) => r.at < now - 21 * DAY && r.at >= now - 56 * DAY).map((r) => calc.sessionBest(ex, r.entry).e1rm || 0));
            return latest && old && latest < old * 0.95;
          }).map(([id]) => exById(id).name);
          if (dropping.length >= 2) add({ id: `cutstrength:${dropping.join()}`, area: 'nutrition', tone: 'warn', priority: 79, title: 'Strength is dropping on this cut', body: `${dropping.slice(0, 3).join(', ')} ${dropping.length > 3 ? `and ${dropping.length - 3} more ` : ''}are down 5%+ from a month ago while you're losing weight fast. Slowing the cut is the first fix.`, why: SOURCES.cut });
        }
      }
    }
    const kg = latestBW / LB;
    const meals = 4; const per = Math.round(t.protein / meals);
    add({ id: `protein:${t.protein}`, area: 'nutrition', tone: 'info', priority: 22, title: `Protein: ${t.protein} g a day`, body: `About ${meals} meals of ${per} g each works well; ${Math.round(kg * 0.4)}–${Math.round(kg * 0.5)} g per meal is the range studies point to for someone your weight. Calories: ${t.kcal.toLocaleString()} a day.`, why: SOURCES.protein, action: { label: 'See targets', kind: 'route', to: '#/body' } });
  }

  // ---------- BODY: measurements
  const waists = ms.filter((m) => m.waist).sort((a, b) => b.date.localeCompare(a.date));
  if (!waists.length) {
    add({ id: 'measure:first', area: 'body', tone: 'do', priority: 38, title: 'Measure your waist and neck', body: 'Two minutes with a tape. Waist shows fat loss the scale can hide, and with your neck it gives a body-fat estimate.', action: { label: 'Log measurements', kind: 'measure' }, why: null });
  } else {
    const last = waists[0];
    const age = (now - Date.parse(last.date + 'T12:00:00')) / DAY;
    if (age > 21) add({ id: `measure:again:${last.date}`, area: 'body', tone: 'do', priority: 36, title: 'Time to re-measure', body: `Last waist measurement was ${Math.round(age)} days ago. Every 2–4 weeks is enough to see a trend.`, action: { label: 'Log measurements', kind: 'measure' }, why: null });
    if (profile.heightCm) {
      const whtr = last.waist / profile.heightCm;
      const r2 = Math.round(whtr * 100) / 100;
      if (whtr >= 0.5) add({ id: `whtr:${r2}`, area: 'body', tone: 'info', priority: 42, title: `Waist-to-height ratio ${r2.toFixed(2)}`, body: `UK health guidance (NICE) suggests keeping your waist under half your height; that's under ${Math.round(profile.heightCm / 2)} cm for you.${goal === 'bulk' ? ' A recomp or short cut before bulking further would bring it down.' : goal === 'cut' ? ' Your fat-loss goal works toward this.' : ''}`, why: SOURCES.whtr });
      else add({ id: `whtr:ok:${r2}`, area: 'body', tone: 'good', priority: 12, title: `Waist-to-height ratio ${r2.toFixed(2)}`, body: 'Under 0.5, the line UK health guidance (NICE) suggests staying below.', why: SOURCES.whtr });
    }
    const old = waists.find((m) => (Date.parse(last.date) - Date.parse(m.date)) / DAY >= 21);
    if (old) {
      const dWaist = Math.round((last.waist - old.waist) * 10) / 10;
      const weeks = Math.round((Date.parse(last.date) - Date.parse(old.date)) / (7 * DAY));
      const rate = B.weeklyRate(bw, 28, now);
      if (goal === 'bulk' && dWaist >= 2) add({ id: `bulkwaist:${last.date}`, area: 'nutrition', tone: 'warn', priority: 62, title: 'Waist is growing quickly on the bulk', body: `+${dWaist} cm in ${weeks} weeks. Trim about 150–200 kcal a day so more of the gain is muscle.`, why: SOURCES.bulk });
      if ((goal === 'recomp' || goal === 'maintain' || goal === 'cut') && dWaist <= -1 && rate !== null && latestBW && Math.abs(rate / latestBW) < 0.0025) add({ id: `recomp:${last.date}`, area: 'body', tone: 'good', priority: 33, title: 'Recomp is working', body: `Weight is steady but your waist is down ${Math.abs(dWaist)} cm in ${weeks} weeks: losing fat while keeping (or building) muscle.`, why: SOURCES.judgment });
    }
  }

  // ---------- TRAINING: start logging RIR once there's history
  const anyRir = finished.some((w) => w.entries?.some((e) => e.sets?.some((s) => s.rir !== null && s.rir !== undefined)));
  if (real.length >= 3 && !anyRir) add({ id: 'tip:rir', area: 'training', tone: 'info', priority: 15, title: 'Log RIR for sharper weight suggestions', body: 'RIR is how many more reps you could have done (0 = none left). With it, the coach can tell an easy 8 from a grinder and suggest weight jumps sooner.', why: null });

  // ---------- getting started
  if (!real.length) add({ id: 'start', area: 'planning', tone: 'do', priority: 90, title: 'Log your first workout', body: 'Every suggestion here comes from your own logs. After one workout you get a next weight for each lift; after two weeks, weekly sets per muscle and a calorie check.', action: nextRt ? { label: `Start ${nextRt.name}`, kind: 'start', routineId: nextRt.id } : null, why: null });

  items.sort((a, b) => b.priority - a.priority);
  return { items, unlocks, stats: { perWeek, daysSince, volume, workouts: real.length }, weekPlan };
}

export { targetRepsFor };
