// Rest timer (timestamp-based, so it stays correct if iOS pauses the page), screen wake lock and beep.

import { h, fmtClock } from './ui.js';

let audioCtx = null;
let state = null; // { endAt, total, label }
let tick = null;
let el = null;
let soundOn = true;
let firedFor = null;
let doneHook = null;

/** Called once each time a rest countdown reaches zero. */
export function onDone(fn) { doneHook = fn; }

/** Must be called from a tap: iOS only allows audio that was unlocked by a user gesture. */
export function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio */ }
}

function beep() {
  if (!soundOn || !audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    [0, 0.22, 0.44].forEach((d, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, now + d);
      g.gain.exponentialRampToValueAtTime(0.35, now + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.18);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + d);
      o.stop(now + d + 0.2);
    });
  } catch { /* ignore */ }
}

export function setSound(on) { soundOn = on; }

function ensureEl() {
  if (el) return el;
  el = h('div', { class: 'rest-bar', id: 'rest-bar', role: 'timer', 'aria-live': 'off' });
  document.body.appendChild(el);
  return el;
}

function render() {
  const bar = ensureEl();
  if (!state) { bar.classList.remove('show', 'done'); return; }
  const left = (state.endAt - Date.now()) / 1000;
  const done = left <= 0;
  const pct = state.total > 0 ? Math.max(0, Math.min(1, left / state.total)) : 0;
  bar.classList.add('show');
  bar.classList.toggle('done', done);
  bar.replaceChildren(
    h('div', { class: 'rest-progress', style: { transform: `scaleX(${pct})` } }),
    h('div', { class: 'rest-inner' },
      h('button', { class: 'rest-adj', 'aria-label': 'Minus 15 seconds', onclick: () => adjust(-15) }, '−15'),
      h('div', { class: 'rest-mid' },
        h('div', { class: 'rest-time' }, done ? 'Go' : fmtClock(left)),
        h('div', { class: 'rest-label' }, done ? 'Rest over' : state.label || 'Rest')),
      h('button', { class: 'rest-adj', 'aria-label': 'Plus 15 seconds', onclick: () => adjust(15) }, '+15'),
      h('button', { class: 'rest-skip', onclick: stop }, done ? 'Close' : 'Skip')));
  if (done && firedFor !== state.endAt) {
    firedFor = state.endAt;
    beep();
    try { doneHook && doneHook(); } catch { /* decoration only */ }
    // auto-hide a little after it's over
    const endAt = state.endAt;
    setTimeout(() => { if (state && state.endAt === endAt) stop(); }, 15000);
  }
}

export function start(seconds, label = 'Rest') {
  if (!seconds || seconds <= 0) return;
  state = { endAt: Date.now() + seconds * 1000, total: seconds, label };
  clearInterval(tick);
  tick = setInterval(render, 250);
  render();
}

export function adjust(delta) {
  if (!state) return;
  const now = Date.now();
  if (state.endAt < now) state.endAt = now;
  state.endAt += delta * 1000;
  state.total = Math.max(state.total + delta, 1);
  firedFor = null;
  render();
}

export function stop() {
  state = null;
  clearInterval(tick);
  render();
}

export function isRunning() { return !!state; }

// ---------- Screen wake lock (iOS 18.4+ for Home Screen web apps) ----------
let lock = null;
let wantLock = false;

export async function keepAwake(on) {
  wantLock = on;
  if (!('wakeLock' in navigator)) return false;
  try {
    if (on && !lock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
    return true;
  } catch {
    lock = null;
    return false;
  }
}

export const wakeLockSupported = () => 'wakeLock' in navigator;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (wantLock) keepAwake(true);
    if (state) render();
  }
});
