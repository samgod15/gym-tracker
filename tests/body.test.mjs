import assert from 'node:assert/strict';
import * as b from '../js/body.js';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const near = (a, e, tol) => assert.ok(Math.abs(a - e) <= tol, `${a} not within ${tol} of ${e}`);

t('navy body fat matches published examples', () => {
  near(b.navyBodyFat({ sex: 'male', heightCm: 182.88, waist: 102.1, neck: 38.6 }), 26.8, 0.2); // Omni example
  near(b.navyBodyFat({ sex: 'male', heightCm: 178, waist: 90, neck: 38 }), 20.2, 0.2); // hand-checked metric formula
  assert.equal(b.navyBodyFat({ sex: 'female', heightCm: 165, waist: 70, neck: 32 }), null); // needs hips
  assert.ok(b.navyBodyFat({ sex: 'female', heightCm: 165, waist: 72, neck: 32, hips: 98 }) > 15);
});
t('mifflin st jeor', () => {
  assert.equal(b.bmr({ sex: 'male', kg: 80, cm: 180, age: 25 }), 1805);
  assert.equal(b.bmr({ sex: 'female', kg: 60, cm: 165, age: 30 }), 1320.25);
});
t('targets respect floor and goals', () => {
  const p = { sex: 'male', heightCm: 178, birthYear: new Date().getFullYear() - 21, activity: 'active', goal: 'cut' };
  const r = b.targets(p, 170);
  assert.ok(r.kcal > 1500 && r.kcal < r.tdee);
  assert.equal(r.protein, Math.round((170 / 2.20462) * 2.2));
  assert.ok(Math.abs(r.protein * 4 + r.fat * 9 + r.carbs * 4 - r.kcal) < 8);
  const tiny = b.targets({ sex: 'female', heightCm: 150, birthYear: new Date().getFullYear() - 60, activity: 'sedentary', goal: 'cut' }, 100);
  assert.ok(tiny.kcal >= 1200 && tiny.kcal >= tiny.bmr);
  assert.equal(b.targets({ sex: 'male' }, 170), null);
});
t('strength level scales with bodyweight and sex', () => {
  const m = b.strengthLevel('bench', 'male', 176.5, 212);
  assert.equal(m.level, 'Intermediate');
  const light = b.strengthLevel('bench', 'male', 140, 212);
  assert.ok(light.idx === 2 && light.pctToNext > 0.8); // lighter lifter, same weight = closer to Advanced
  const f = b.strengthLevel('bench', 'female', 145.8, 112);
  assert.equal(f.level, 'Intermediate');
  assert.equal(b.strengthLevel('bench', 'male', 176.5, 60).level, 'Below Beginner');
  const pu = b.strengthLevel('pullup', 'male', 177, 177 * 1.2); // ~6 BW reps
  assert.equal(pu.level, 'Novice');
});
t('standard mapping by id and name', () => {
  assert.deepEqual(b.standardFor({ id: 'ex-incline-db-curl' }), { key: 'db_curl', factor: 0.85 });
  assert.equal(b.standardFor({ id: 'x', name: 'Barbell Bench Press', loadType: 'plates' }).key, 'bench');
  assert.equal(b.standardFor({ id: 'x', name: 'Incline Dumbbell Press', loadType: 'dumbbell' }).key, 'incline_db');
  assert.equal(b.standardFor({ id: 'x', name: 'Hack squat', loadType: 'plates' }), null);
  assert.equal(b.standardFor({ id: 'x', name: 'Seated DB shoulder press', loadType: 'dumbbell' }).key, 'db_ohp');
  assert.equal(b.standardFor({ id: 'ex-bench', standard: 'none' }), null);
});
t('weekly rate + advice', () => {
  const now = Date.parse('2026-11-28T12:00:00');
  const pts = [0, 4, 8, 12, 16, 20, 24].map((d, i) => ({ date: new Date(now - (24 - d) * 86400000).toISOString().slice(0, 10), weight: 180 - i * 0.7 }));
  const r = b.weeklyRate(pts, 28, now);
  near(r, -1.225, 0.05);
  const tg = b.targets({ sex: 'male', heightCm: 178, birthYear: 2005, activity: 'moderate', goal: 'cut' }, 180);
  assert.equal(b.trendAdvice(r, tg).status, 'on');
  assert.ok(b.trendAdvice(-3, tg).adjust > 0);
  assert.equal(b.weeklyRate(pts.slice(0, 2), 28, now), null);
});
t('units', () => {
  assert.equal(b.fmtHeight(178, 'imperial'), '5′10″');
  assert.equal(b.fmtHeight(178, 'metric'), '178 cm');
  assert.equal(b.fmtLen(38.1, 'imperial'), '15.0 in');
});
console.log(`\n${n} tests passed`);
