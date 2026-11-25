// Reads workouts out of a training-plan PDF's text: days, exercises, sets × reps, supersets, rest.
// Pure functions (no DOM, no storage) so they can be unit-tested in Node.
//
// Handles the common shapes plans come in:
//   • lists:   "Bench press 3 x 8-10", "3 sets of 12 – Leg press", "A1. Pull-ups 4 x AMRAP"
//   • tables:  Exercise | Sets | Reps | Rest | Notes   (columns found from the header row)
//   • split:   "Romanian deadlift" on one line and "3 x 8" on the next
//   • weeks:   "Week 1 – Day 2: Lower" … "Week 12 – Day 2: Lower"  → each day kept once
// Scanned PDFs and photos have no text layer, so they come back with no days.

// ---------------------------------------------------------------- text lines from pdf.js
/** pages: arrays of pdf.js text items ({ str, transform, width, height }). Returns lines top-to-bottom. */
export function linesFromItems(pages) {
  const out = [];
  for (const items of pages) {
    const pieces = items
      .filter((it) => it.str && it.str.trim())
      .map((it) => {
        const t = it.transform || [1, 0, 0, 1, 0, 0];
        const size = Math.abs(it.height || Math.hypot(t[2], t[3]) || 10);
        return { str: it.str, x: t[4], y: t[5], w: it.width || it.str.length * size * 0.5, size };
      });
    // group by baseline
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const p of pieces) {
      const row = rows.find((r) => Math.abs(r.y - p.y) <= Math.max(2, Math.min(r.size, p.size) * 0.45));
      if (row) { row.items.push(p); row.size = Math.max(row.size, p.size); } else rows.push({ y: p.y, size: p.size, items: [p] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null;
      for (const p of r.items) {
        const gap = cur ? p.x - (cur.x + cur.w) : Infinity;
        if (cur && gap < r.size * 1.4) {
          cur.text += (gap > r.size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(p.str) ? ' ' : '') + p.str;
          cur.w = p.x + p.w - cur.x;
        } else {
          cur = { text: p.str, x: p.x, w: p.w };
          cells.push(cur);
        }
      }
      cells.forEach((c) => (c.text = c.text.replace(/\s+/g, ' ').trim()));
      const text = cells.map((c) => c.text).join('  ').trim();
      if (text) out.push({ text, cells, size: r.size, page: pages.indexOf(items) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- patterns
const DASH = '[-–—]';
const REPS = `(\\d{1,3}\\s*(?:s|sec|secs|seconds)\\b|\\d{1,3}(?:\\s*(?:${DASH}|to)\\s*\\d{1,3})?\\+?(?:\\s*(?:reps?|each|ea|/\\s*(?:side|leg|arm)|per (?:side|leg|arm)))?|amrap|max(?:imum)?|failure|to failure)`;
const SETREP_RES = [
  new RegExp(`(\\d{1,2})\\s*(?:sets?|rounds?)?\\s*[x×X*]\\s*${REPS}`, 'i'), // 3 x 8-10, 3 sets x 12
  new RegExp(`(\\d{1,2})\\s*(?:sets?|rounds?)\\s*(?:of|,|:)?\\s*${REPS}`, 'i'), // 3 sets of 10, 3 sets 8-12
  new RegExp(`sets?\\s*[:=]?\\s*(\\d{1,2})\\s*[,;/|]?\\s*reps?\\s*[:=]?\\s*${REPS}`, 'i'), // Sets: 3 Reps: 10
];
const MINUTES_RE = new RegExp(`(\\d{1,3})(?:\\s*${DASH}\\s*(\\d{1,3}))?\\s*(?:min|mins|minutes)\\b`, 'i');
const REST_RE = new RegExp(`rest\\s*[:\\-–]?\\s*(\\d{1,3})(?:\\s*${DASH}\\s*(\\d{1,3}))?\\s*(seconds|secs|sec|s|minutes|mins|min|m|')?`, 'i');
const CARDIO_RE = /\b(zone ?2|cardio|run|running|jog|jogging|walk|walking|incline walk|treadmill|bike|cycling|cycle|spin|elliptical|stair ?master|stairs|stepmill|rower|rowing machine|erg|hiit|swim|sprints?)\b/i;
const WEEKDAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?';
const DAY_RE = new RegExp(`^(?:week\\s*\\d+\\s*(?:[-–—:,|.]\\s*)?)?(?:day\\s*\\d+|session\\s*\\d+|workout\\s*[a-z0-9]{1,2}\\b|${WEEKDAY}\\b)`, 'i');
const SPLIT_WORDS = /\b(upper|lower|push|pull|legs|leg day|full[\s-]?body|chest|back|shoulders|arms|glutes|core|posterior|anterior|conditioning|rest day|active recovery)\b/i;
const HEADER_ROW = /\b(exercise|movement|lift)\b/i;
const NOISE = /^(page \d+|\d+\s*\/\s*\d+|www\.|https?:|©|copyright|notes?:?$|warm[\s-]?up:?$|cool[\s-]?down:?$)/i;

const cleanSpaces = (s) => s.replace(/\s+/g, ' ').trim();

function findSetRep(text) {
  for (const re of SETREP_RES) {
    const m = re.exec(text);
    if (m) {
      // 12 x 3 written as reps x sets is rare; "x" with sets > 10 and reps <= 6 is probably reversed
      let sets = Number(m[1]);
      let reps = normReps(m[2]);
      if (sets > 10 && /^\d+$/.test(reps) && Number(reps) <= 6) [sets, reps] = [Number(reps), String(m[1])];
      if (sets < 1 || sets > 12) continue;
      return { sets, reps, index: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

function normReps(r) {
  let s = cleanSpaces(String(r || '')).replace(/\s*(?:reps?)$/i, '');
  s = s.replace(/\s*(?:-|–|—|to)\s*/i, '–');
  if (/^amrap|^max|failure/i.test(s)) return 'AMRAP';
  s = s.replace(/\s*(s|sec|secs|seconds)$/i, 's').replace(/\s*(each|ea|per (side|leg|arm)|\/\s*(side|leg|arm))$/i, ' each');
  return s;
}

function restSeconds(text) {
  const m = REST_RE.exec(text);
  if (!m) return null;
  const a = Number(m[1]); const b = m[2] ? Number(m[2]) : null;
  const unit = (m[3] || '').toLowerCase();
  const v = b ? (a + b) / 2 : a;
  const secs = /^m|'/.test(unit) || (!unit && v <= 5) ? v * 60 : v;
  return secs >= 15 && secs <= 600 ? Math.round(secs / 15) * 15 : null;
}

/** "A1. Bench press:" → { name: 'Bench press', group: 'A' } */
function cleanName(raw) {
  let s = cleanSpaces(raw);
  let group = null;
  const g = /^\(?([A-Ea-e])\s?([1-4])\s*[.):\-–]?\s+/.exec(s);
  if (g) { group = g[1].toUpperCase(); s = s.slice(g[0].length); }
  s = s.replace(/^(?:\d{1,2}\s*[.)]\s*|\d{1,2}\s+(?=[a-z])|[-•*–·▪●◦>]\s*|\(?[a-e]\)\s+)/i, '');
  s = s.replace(/^(?:finisher|finish|cardio|warm[\s-]?up|cool[\s-]?down|superset|circuit|accessory|main lift|optional)\s*:\s*(?=\S)/i, '');
  s = s.replace(/\s*[-–—:|,@]+\s*$/g, '').replace(/^\s*[-–—:|,]+\s*/, '');
  s = s.replace(/\s*\b(sets?|reps?)\s*$/i, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return { name: s, group };
}

function isHeader(line, bodySize) {
  const t = line.text.trim();
  if (t.length > 48 || t.length < 3) return false;
  if (findSetRep(t)) return false;
  const words = t.split(/\s+/).length;
  if (DAY_RE.test(t)) return true;
  const big = line.size >= bodySize * 1.25;
  if (SPLIT_WORDS.test(t) && (words <= 4 || /day|session|workout|:/i.test(t)) && !/\b(press|curl|raise|row|extension|squat|deadlift|fly|flye|pulldown|pushdown|lunge|thrust|crunch)\b/i.test(t)) return true;
  if (big && words <= 6 && !/\d+\s*(x|×|sets?)/i.test(t)) return 'maybe';
  return false;
}

function dayName(header) {
  let s = cleanSpaces(header).replace(/^week\s*\d+\s*(?:[-–—:,|.]\s*)?/i, '');
  const m = /^(day\s*\d+|session\s*\d+)\s*(?:[-–—:,|.(]\s*)?(.*)$/i.exec(s);
  if (m && m[2] && m[2].replace(/[)\s]/g, '').length > 1) s = m[2].replace(/\)\s*$/, '');
  s = s.replace(/\s*[:\-–—|]+\s*$/, '').trim();
  return s.length > 40 ? s.slice(0, 40).trim() : s;
}

const dayKey = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Turn lines into workouts. Returns { days: [{ name, items: [{ name, sets, reps, group, note, restSec, cardio }] }], weeks, notes: [] }
 */
export function parsePlan(lines) {
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length * 0.4)] : 10;
  const days = [];
  const seen = new Map();
  let cur = null; let skip = false;
  let table = null; // { cols: { name, sets, reps, rest, notes } x-centres }
  let pending = null; // name-only line waiting for its sets line
  let weeks = 0;
  let supersetNext = null;

  const startDay = (name) => {
    const key = dayKey(name);
    pending = null; table = null;
    if (seen.has(key)) { cur = seen.get(key); skip = true; return; } // same day in a later week: keep the first
    cur = { name, items: [] }; skip = false;
    seen.set(key, cur); days.push(cur);
  };
  const ensureDay = () => { if (!cur) startDay(`Workout ${days.length + 1}`); };
  const add = (it) => {
    if (skip) return;
    ensureDay();
    if (!it.name || it.name.length < 2 || it.name.length > 60 || !/[a-z]/i.test(it.name)) return;
    if (supersetNext && !it.group) it.group = supersetNext.letter;
    cur.items.push(it);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = cleanSpaces(line.text);
    if (!text || NOISE.test(text)) continue;
    if (/^week\s*\d+\b/i.test(text)) weeks = Math.max(weeks, Number(/\d+/.exec(text)[0]));

    // table header row: Exercise | Sets | Reps ...
    if (line.cells.length >= 3 && HEADER_ROW.test(text) && /\bsets?\b/i.test(text) && /\breps?\b/i.test(text)) {
      const cols = {};
      for (const c of line.cells) {
        const k = c.text.toLowerCase();
        const x = c.x + (c.w || 0) / 2;
        if (/exercise|movement|lift/.test(k)) cols.name = c.x;
        else if (/^sets?\b/.test(k)) { cols.sets = x; cols.setsLeft = c.x; }
        else if (/^reps?\b|rep range/.test(k)) cols.reps = x;
        else if (/^rest/.test(k)) cols.rest = x;
        else if (/note|tempo|rpe|rir|cue/.test(k)) cols.notes = x;
      }
      if (cols.sets != null && cols.reps != null) { table = cols; pending = null; continue; }
    }

    const hdr = isHeader(line, bodySize);
    if (hdr === true || (hdr === 'maybe' && !table)) {
      if (/^(rest day|rest|off|active recovery)$/i.test(text)) { cur = null; skip = true; continue; }
      startDay(dayName(text));
      continue;
    }
    if (/^superset\b/i.test(text)) { supersetNext = { letter: String.fromCharCode(65 + (supersetNext ? (supersetNext.letter.charCodeAt(0) - 64) % 5 : 0)), left: 2 }; continue; }

    // table row
    if (table && line.cells.length >= 2) {
      const pick = (x) => { const b = line.cells.reduce((best, c) => { const d = Math.abs(c.x + (c.w || 0) / 2 - x); return !best || d < best.d ? { c, d } : best; }, null); return b && b.d <= 50 ? b.c : null; };
      const nameCell = line.cells.filter((c) => c.x + (c.w || 0) / 2 < table.setsLeft - 2).map((c) => c.text).join(' ') || line.cells[0].text;
      const setsCell = pick(table.sets); const repsCell = pick(table.reps);
      const sets = setsCell && /^\d{1,2}$/.test(setsCell.text.trim()) ? Number(setsCell.text.trim()) : null;
      if (sets && repsCell && repsCell !== setsCell) {
        const { name, group } = cleanName(nameCell);
        const restCell = table.rest != null ? pick(table.rest) : null;
        const notesCell = table.notes != null ? pick(table.notes) : null;
        const restTxt = restCell && restCell !== repsCell && restCell !== setsCell ? restCell.text : '';
        add({ name, group, sets, reps: normReps(repsCell.text), note: notesCell && notesCell !== repsCell ? notesCell.text.slice(0, 40) : '', restSec: restTxt ? restSeconds(`rest ${restTxt}`) : null, cardio: CARDIO_RE.test(name) });
        if (supersetNext && --supersetNext.left <= 0) supersetNext = null;
        continue;
      }
    }

    const sr = findSetRep(text);
    if (sr) {
      let before = text.slice(0, sr.index); let after = text.slice(sr.end);
      let { name, group } = cleanName(before);
      if (!name && pending) { ({ name, group } = pending); }
      if (!name) ({ name, group } = cleanName(after.replace(/^\s*(reps?)?\s*/i, '').split(/\s{2,}|[,;(@]|rest/i)[0] || ''));
      const note = cleanSpaces(after.replace(REST_RE, '').replace(/^\s*(reps?|each)\b/i, '').replace(/^[\s,;:\-–—|]+/, '')).slice(0, 40);
      add({ name, group, sets: sr.sets, reps: sr.reps, note: note && note.toLowerCase() !== name.toLowerCase() ? note : '', restSec: restSeconds(text), cardio: false });
      pending = null;
      if (supersetNext && --supersetNext.left <= 0) supersetNext = null;
      continue;
    }

    // cardio with minutes
    const mm = MINUTES_RE.exec(text);
    if (mm && CARDIO_RE.test(text) && !/^rest\b/i.test(text)) {
      const nm = cleanName(text.slice(0, mm.index)).name || cleanName(text.replace(MINUTES_RE, '')).name || 'Cardio';
      add({ name: nm.replace(/[:(]+$/, '').trim() || 'Cardio', group: null, sets: 1, reps: `${mm[1]}${mm[2] ? `–${mm[2]}` : ''} min`, note: '', restSec: null, cardio: true });
      pending = null;
      continue;
    }

    // a bare name; its sets may be on the next line
    const nm = cleanName(text);
    if (nm.name && nm.name.split(' ').length <= 7 && !/[.!?]$/.test(nm.name) && /[a-z]/i.test(nm.name)) pending = nm;
    else pending = null;
  }

  const kept = days.filter((d) => d.items.length);
  kept.forEach((d) => { if (/^workout \d+$/i.test(d.name) && kept.length === 1) d.name = 'Workout'; });
  return { days: kept, weeks };
}

// ---------------------------------------------------------------- matching to the exercise library
const ALIASES = [
  [/\bdbs?\b/g, 'dumbbell'], [/\bbb\b/g, 'barbell'], [/\bkbs?\b/g, 'kettlebell'], [/\bez[\s-]?bar\b/g, 'ez barbell'],
  [/\bohp\b/g, 'overhead press'], [/\bmilitary press\b/g, 'overhead press'], [/\brdls?\b/g, 'romanian deadlift'], [/\bsldl\b/g, 'stiff leg deadlift'],
  [/\bpull[\s-]?ups?\b/g, 'pull up'], [/\bchin[\s-]?ups?\b/g, 'chin up'], [/\bpush[\s-]?ups?\b/g, 'push up'],
  [/\bpull[\s-]?downs?\b/g, 'pulldown'], [/\bpush[\s-]?downs?\b/g, 'pushdown'], [/\blat raises?\b/g, 'lateral raise'],
  [/\btri(?:ceps?|s)?\b/g, 'triceps'], [/\bbi(?:ceps?|s)\b/g, 'biceps'], [/\bext\b/g, 'extension'], [/\bflyes?\b/g, 'fly'],
  [/\bbench\b(?!\s*press)/g, 'bench press'], [/^squats?$/g, 'back squat'], [/\bsmith machine\b/g, 'smith'], [/\bplate[\s-]?loaded\b/g, 'plate'],
  [/\bdumbell\b/g, 'dumbbell'], [/\bhammer strength\b/g, 'plate'],
];
const STOP = new Set(['the', 'a', 'an', 'with', 'on', 'of', 'and', 'or', 'to', 'for', 'machine', 'exercise', 'grip']);
const MAJOR = new Set(['incline', 'decline', 'seated', 'standing', 'single', 'one', 'reverse', 'front', 'hammer', 'close', 'sumo', 'romanian', 'stiff', 'hack', 'bulgarian', 'split', 'goblet', 'smith', 'preacher', 'lying', 'bent', 'overhead', 'lateral', 'leg', 'chest', 'calf', 'hip', 'face']);
const EQUIP = new Set(['dumbbell', 'barbell', 'cable', 'kettlebell', 'band', 'ez', 'plate']);

export function tokens(name) {
  let s = ` ${String(name).toLowerCase()} `.replace(/[()[\]{}]/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of ALIASES) s = s.replace(re, to);
  return [...new Set(s.split(/[\s-]+/).map((w) => (w.length > 4 && w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).filter((w) => w && !STOP.has(w)))];
}

export function similarity(a, b) {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((t) => B.has(t) && inter++);
  let score = (2 * inter) / (A.size + B.size);
  const small = A.size <= B.size ? A : B; const big = small === A ? B : A;
  if (small.size >= 2 && [...small].every((t) => big.has(t))) score = Math.max(score, 0.82);
  const eqA = [...A].filter((t) => EQUIP.has(t)); const eqB = [...B].filter((t) => EQUIP.has(t));
  if (eqA.length && eqB.length && !eqA.some((t) => eqB.includes(t))) score -= 0.5;
  for (const t of A) if (!B.has(t)) score -= MAJOR.has(t) ? 0.25 : EQUIP.has(t) ? 0.05 : 0;
  for (const t of B) if (!A.has(t)) score -= MAJOR.has(t) ? 0.25 : EQUIP.has(t) ? 0.05 : 0;
  return score;
}

/** Best library match for a plan's exercise name, or null if nothing is close enough. */
export function matchExercise(name, exercises, threshold = 0.75) {
  let best = null;
  for (const ex of exercises) {
    const s = similarity(name, ex.name);
    if (s >= threshold && (!best || s > best.score)) best = { ex, score: s };
  }
  return best;
}

/** How weight is probably entered for an exercise we've never seen. */
export function guessLoadType(name) {
  const t = ` ${tokens(name).join(' ')} `;
  if (CARDIO_RE.test(name)) return { loadType: 'cardio', baseWeight: null };
  if (/ (pull up|chin up|push up|dip|plank|hanging|sit up|burpee|lunge walk|pistol|muscle up|inverted row|back extension|hyperextension) /.test(t) && !/ (dumbbell|barbell|cable|machine|smith) /.test(t)) return { loadType: 'bodyweight', baseWeight: null };
  if (/ (dumbbell|kettlebell) /.test(t)) return { loadType: 'dumbbell', baseWeight: null };
  if (/ (leg press|hack squat|plate|belt squat|pendulum|t bar) /.test(t)) return { loadType: 'plates', baseWeight: 0 };
  if (/ smith /.test(t)) return { loadType: 'plates', baseWeight: 0 };
  if (/ (barbell|back squat|front squat|deadlift|bench press|overhead press|romanian|hip thrust|good morning|pendlay|bent over row) /.test(t) && !/ (cable|machine) /.test(t)) return { loadType: 'plates', baseWeight: 45 };
  return { loadType: 'total', baseWeight: null };
}

/** Title-case a name pulled from a PDF if it was shouted in capitals. */
export function tidyName(name) {
  const s = cleanSpaces(name);
  if (s === s.toUpperCase() && /[A-Z]{3}/.test(s)) return s.toLowerCase().replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Db|Bb|Rdl|Ohp|Ez)\b/g, (m) => m.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}
