// Profile-driven estimates: strength level per lift, calorie/protein targets, weight-trend check,
// body-fat estimate. Pure functions — unit-tested in tests/body.test.mjs.
//
// Sources
// - Strength standards: StrengthLevel.com community 1RM standards (2026 data). Each lift's five level
//   thresholds for an average-bodyweight lifter are divided by that average bodyweight to get a
//   bodyweight ratio, then scaled to your bodyweight. Where StrengthLevel didn't list an average
//   bodyweight we use 177 lb (male) / 146 lb (female), the typical value across its lifts.
//   Female deadlift Advanced/Elite and female dumbbell shoulder press are extrapolated (marked ~).
// - Calories: Mifflin-St Jeor BMR x activity factor.
// - Protein: ISSN position stand (1.4-2.0 g/kg for most; higher in a deficit).
// - Body fat: US Navy circumference method (Hodgdon & Beckett 1984), metric form.

export const LEVELS = ['Beginner', 'Novice', 'Intermediate', 'Advanced', 'Elite'];

const LB = 2.20462;
const kgToLb = (kg) => kg * LB;

// avg-lifter thresholds (lb) at bodyweight bw (lb). added = thresholds are weight added to bodyweight.
export const STANDARDS = {
  bench: { name: 'Bench press', m: { bw: 176.5, lv: [107, 154, 212, 280, 353] }, f: { bw: 145.8, lv: [43, 72, 112, 159, 213] } },
  incline_db: { name: 'Incline dumbbell press (per dumbbell)', m: { bw: 173.4, lv: [41, 60, 83, 110, 140] }, f: { bw: 144.9, lv: [17, 29, 44, 62, 83] } },
  db_bench: { name: 'Dumbbell bench press (per dumbbell)', m: { bw: 172.3, lv: [37, 58, 85, 117, 153] }, f: { bw: 143.6, lv: [15, 28, 44, 65, 89] } },
  ohp: { name: 'Overhead press', m: { bw: 177, lv: [65, 97, 137, 185, 236] }, f: { bw: 146, lv: [29, 47, 72, 102, 135] } },
  db_ohp: { name: 'Dumbbell shoulder press (per dumbbell)', m: { bw: 177, lv: [29, 46, 71, 99, 132] }, f: { bw: 146, lv: [12, 22, 37, 55, 77] }, approxF: true },
  squat: { name: 'Back squat', m: { bw: 177, lv: [141, 206, 287, 381, 483] }, f: { bw: 146, lv: [65, 107, 161, 227, 300] } },
  deadlift: { name: 'Deadlift', m: { bw: 177, lv: [173, 246, 336, 440, 552] }, f: { bw: 146, lv: [84, 132, 193, 265, 347] }, approxF: true },
  rdl: { name: 'Romanian deadlift', m: { bw: 177, lv: [129, 191, 270, 362, 462] }, f: { bw: 146, lv: [69, 105, 151, 205, 264] } },
  leg_press: { name: 'Leg press', m: { bw: 177.5, lv: [191, 323, 499, 713, 953] }, f: { bw: 147.7, lv: [115, 207, 333, 489, 665] } },
  lat_pulldown: { name: 'Lat pulldown', m: { bw: 177, lv: [93, 132, 180, 235, 295] }, f: { bw: 146, lv: [52, 75, 105, 139, 176] } },
  db_curl: { name: 'Dumbbell curl (per dumbbell)', m: { bw: 177, lv: [16, 29, 46, 68, 93] }, f: { bw: 146, lv: [9, 16, 27, 41, 56] } },
  hip_thrust: { name: 'Hip thrust', m: { bw: 177, lv: [99, 187, 309, 459, 631] }, f: { bw: 146, lv: [77, 141, 225, 328, 448] } },
  pullup: { name: 'Pull-up (bodyweight + added)', added: true, m: { bw: 177, lv: [-3, 13, 31, 52, 73].map(kgToLb) }, f: { bw: 146, lv: [-16, -5, 8, 23, 38].map(kgToLb) } },
};

// Seeded exercise ids -> standard (factor adjusts for a harder variation, e.g. incline curls)
const BY_ID = {
  'ex-bench': ['bench'], 'ex-incline-db-press': ['incline_db'], 'ex-db-bench': ['db_bench'], 'ex-ohp': ['ohp'],
  'ex-db-shoulder-press': ['db_ohp'], 'ex-bb-squat': ['squat'], 'ex-deadlift': ['deadlift'], 'ex-rdl': ['rdl'],
  'ex-leg-press': ['leg_press'], 'ex-lat-pulldown': ['lat_pulldown'], 'ex-hammer-curl': ['db_curl'],
  'ex-incline-db-curl': ['db_curl', 0.85], 'ex-hip-thrust': ['hip_thrust'], 'ex-pull-up': ['pullup'],
};

/** Which standard (if any) an exercise is compared against. Returns { key, factor } or null. */
export function standardFor(ex) {
  if (!ex) return null;
  if (ex.standard === 'none') return null;
  if (ex.standard && STANDARDS[ex.standard]) return { key: ex.standard, factor: 1 };
  if (BY_ID[ex.id]) return { key: BY_ID[ex.id][0], factor: BY_ID[ex.id][1] || 1 };
  const n = (ex.name || '').toLowerCase();
  const db = ex.loadType === 'dumbbell' || /\b(db|dumbbell)\b/.test(n);
  if (/pull-?up|chin-?up/.test(n)) return { key: 'pullup', factor: 1 };
  if (/incline/.test(n) && /press|bench/.test(n) && db) return { key: 'incline_db', factor: 1 };
  if (/bench|chest press/.test(n) && db && !/incline|decline/.test(n)) return { key: 'db_bench', factor: 1 };
  if (/bench press/.test(n) && !db && !/incline|decline|close/.test(n) && ex.loadType !== 'stack') return { key: 'bench', factor: 1 };
  if (/romanian|\brdl\b/.test(n)) return { key: 'rdl', factor: 1 };
  if (/deadlift/.test(n) && !/stiff|single/.test(n)) return { key: 'deadlift', factor: 1 };
  if (/squat/.test(n) && !/hack|smith|split|goblet|front|box|bulgarian/.test(n)) return { key: 'squat', factor: 1 };
  if (/leg press/.test(n)) return { key: 'leg_press', factor: 1 };
  if (/lat pull/.test(n)) return { key: 'lat_pulldown', factor: 1 };
  if (/hip thrust/.test(n)) return { key: 'hip_thrust', factor: 1 };
  if (/(overhead|military|shoulder) press/.test(n)) return { key: db ? 'db_ohp' : 'ohp', factor: 1 };
  if (/curl/.test(n) && db && !/leg|ham/.test(n)) return { key: 'db_curl', factor: /incline/.test(n) ? 0.85 : 1 };
  return null;
}

/**
 * Strength level for an estimated 1RM (lb). For pull-ups pass the *added* weight's e1RM total:
 * value = (bodyweight + added) x (1 + reps/30).
 * Returns { idx (-1 = below Beginner), level, ratio, thresholds[5], next, nextLevel, pctToNext, approx }.
 */
export function strengthLevel(key, sex, bodyweightLb, value, factor = 1) {
  const s = STANDARDS[key];
  if (!s || !bodyweightLb || !value || value <= 0) return null;
  const t = s[sex === 'female' ? 'f' : 'm'];
  const thresholds = t.lv.map((v) => (s.added ? ((t.bw + v) / t.bw) * bodyweightLb : (v / t.bw) * bodyweightLb * factor));
  let idx = -1;
  thresholds.forEach((thr, i) => { if (value >= thr - 1e-6) idx = i; });
  const next = idx < 4 ? thresholds[idx + 1] : null;
  const from = idx >= 0 ? thresholds[idx] : 0;
  return {
    idx,
    level: idx >= 0 ? LEVELS[idx] : 'Below Beginner',
    ratio: value / bodyweightLb,
    thresholds,
    next,
    nextLevel: idx < 4 ? LEVELS[idx + 1] : null,
    pctToNext: next ? Math.max(0, Math.min(1, (value - from) / (next - from))) : 1,
    approx: sex === 'female' && !!s.approxF,
  };
}

// ---------------------------------------------------------------- profile helpers
export const ACTIVITY = {
  sedentary: { label: 'Mostly sitting', note: 'Desk job, little walking outside workouts', factor: 1.2 },
  light: { label: 'Lightly active', note: 'Some walking; train 1–3 days a week', factor: 1.375 },
  moderate: { label: 'Moderately active', note: 'On your feet often or train 3–5 days a week', factor: 1.55 },
  active: { label: 'Very active', note: 'On your feet all shift and train 4–6 days a week', factor: 1.725 },
  extra: { label: 'Extremely active', note: 'Hard physical job plus daily training', factor: 1.9 },
};

export const GOALS = {
  cut: { label: 'Lose fat', kcal: 0.8, protein: 2.2, rate: [-1.0, -0.5], note: '20% under maintenance, high protein to keep muscle' },
  recomp: { label: 'Recomp', kcal: 0.95, protein: 2.0, rate: [-0.25, 0.1], note: 'Just under maintenance, high protein' },
  bulk: { label: 'Build muscle', kcal: 1.1, protein: 1.8, rate: [0.25, 0.5], note: '10% surplus for a lean bulk' },
  maintain: { label: 'Maintain', kcal: 1.0, protein: 1.8, rate: [-0.25, 0.25], note: 'Hold your weight' },
};

export function ageOf(profile, now = new Date()) {
  if (!profile?.birthYear) return null;
  return now.getFullYear() - profile.birthYear;
}

export function profileComplete(p, bodyweightLb) {
  return !!(p && (p.sex === 'male' || p.sex === 'female') && p.heightCm && ageOf(p) && bodyweightLb);
}

/** Mifflin-St Jeor resting energy (kcal/day). */
export function bmr({ sex, kg, cm, age }) {
  return 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
}

/** Daily calorie + macro targets. */
export function targets(profile, bodyweightLb) {
  if (!profileComplete(profile, bodyweightLb)) return null;
  const kg = bodyweightLb / LB;
  const age = ageOf(profile);
  const base = bmr({ sex: profile.sex, kg, cm: profile.heightCm, age });
  const act = ACTIVITY[profile.activity] || ACTIVITY.moderate;
  const goal = GOALS[profile.goal] || GOALS.maintain;
  const tdee = base * act.factor;
  const floor = Math.max(base, profile.sex === 'female' ? 1200 : 1500);
  let kcal = Math.max(floor, tdee * goal.kcal);
  kcal = Math.round(kcal / 10) * 10;
  const protein = Math.round(kg * goal.protein);
  const fat = Math.round(Math.max(0.6 * kg, (0.25 * kcal) / 9));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return {
    bmr: Math.round(base), tdee: Math.round(tdee), kcal, protein, fat, carbs,
    floored: kcal <= floor + 5 && tdee * goal.kcal < floor,
    rateRange: goal.rate.map((r) => (r / 100) * bodyweightLb), // lb / week
    goal, act,
  };
}

/**
 * Weekly rate of change from weigh-ins (least-squares slope over the last `days`).
 * points: [{date:'YYYY-MM-DD', weight}]. Returns lb/week or null if there isn't enough data.
 */
export function weeklyRate(points, days = 28, now = Date.now()) {
  const cutoff = now - days * 86400000;
  const pts = points
    .map((p) => ({ t: Date.parse(p.date + 'T12:00:00'), w: p.weight }))
    .filter((p) => p.t >= cutoff)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 4 || (pts[pts.length - 1].t - pts[0].t) < 10 * 86400000) return null;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mw = pts.reduce((s, p) => s + p.w, 0) / n;
  let num = 0; let den = 0;
  for (const p of pts) { num += (p.t - mt) * (p.w - mw); den += (p.t - mt) ** 2; }
  if (!den) return null;
  return (num / den) * 7 * 86400000;
}

/** Compare the actual trend to the goal's range; suggest a calorie nudge (~500 kcal/day per lb/week). */
export function trendAdvice(rate, t) {
  if (rate === null || !t) return null;
  const [lo, hi] = t.rateRange;
  if (rate >= lo && rate <= hi) return { status: 'on', adjust: 0 };
  const mid = (lo + hi) / 2;
  let adjust = Math.round(((mid - rate) * 500) / 50) * 50;
  adjust = Math.max(-300, Math.min(300, adjust));
  return { status: rate < lo ? 'fast-loss-or-slow-gain' : 'slow-loss-or-fast-gain', adjust };
}

/** US Navy body-fat estimate (cm). Returns % or null. */
export function navyBodyFat({ sex, heightCm, neck, waist, hips }) {
  if (!heightCm || !neck || !waist) return null;
  let bf;
  if (sex === 'female') {
    if (!hips || waist + hips - neck <= 0) return null;
    bf = 495 / (1.29579 - 0.35004 * Math.log10(waist + hips - neck) + 0.221 * Math.log10(heightCm)) - 450;
  } else if (sex === 'male') {
    if (waist - neck <= 0) return null;
    bf = 495 / (1.0324 - 0.19077 * Math.log10(waist - neck) + 0.15456 * Math.log10(heightCm)) - 450;
  } else return null;
  return Number.isFinite(bf) && bf > 2 && bf < 70 ? Math.round(bf * 10) / 10 : null;
}

// ---------------------------------------------------------------- units
export const cmToIn = (cm) => cm / 2.54;
export const inToCm = (inch) => inch * 2.54;
export function fmtHeight(cm, units) {
  if (!cm) return '—';
  if (units === 'imperial') {
    const total = Math.round(cmToIn(cm));
    return `${Math.floor(total / 12)}′${total % 12}″`;
  }
  return `${Math.round(cm)} cm`;
}
export function fmtLen(cm, units) {
  if (cm === null || cm === undefined) return '—';
  return units === 'imperial' ? `${(Math.round(cmToIn(cm) * 10) / 10).toFixed(1)} in` : `${(Math.round(cm * 10) / 10).toFixed(1)} cm`;
}

export const MEASURES = [
  { key: 'waist', label: 'Waist', hint: 'At the belly button, relaxed' },
  { key: 'neck', label: 'Neck', hint: 'Just below the Adam’s apple' },
  { key: 'chest', label: 'Chest', hint: 'Across the nipples, arms down' },
  { key: 'shoulders', label: 'Shoulders', hint: 'Widest point, arms down' },
  { key: 'arm', label: 'Arm (flexed)', hint: 'Peak of the biceps, flexed' },
  { key: 'thigh', label: 'Thigh', hint: 'Widest point, standing' },
  { key: 'calf', label: 'Calf', hint: 'Widest point, standing' },
  { key: 'hips', label: 'Hips', hint: 'Widest point of the glutes (needed for women’s body-fat estimate)' },
];
