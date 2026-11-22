// Visual effects: the live "spotlight + chalk dust" background, PR chalk bursts and count-ups.
// Everything here is decoration: it switches off with Reduce Motion or the Settings toggle,
// pauses when the app is in the background, and never blocks logging.

const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => reduceMQ.matches;

// ------------------------------------------------------------------ background
let bg = null; // { canvas, ctx, motes, raf, on }

function makeMote(w, h, fresh = false) {
  const depth = Math.random(); // 0 = far, 1 = near
  return {
    x: Math.random() * w,
    y: fresh ? h + Math.random() * 40 : Math.random() * h,
    r: 0.5 + depth * 1.6,
    a: 0.05 + depth * 0.28,
    vy: -(0.06 + depth * 0.22), // drift up, near motes faster
    sway: Math.random() * Math.PI * 2,
    swaySpeed: 0.004 + Math.random() * 0.01,
    swayAmp: 0.15 + Math.random() * 0.35,
  };
}

function size() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  bg.canvas.width = Math.round(w * dpr);
  bg.canvas.height = Math.round(h * dpr);
  bg.canvas.style.width = `${w}px`;
  bg.canvas.style.height = `${h}px`;
  bg.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bg.w = w; bg.h = h;
  const target = Math.round(Math.min(70, (w * h) / 9000));
  while (bg.motes.length < target) bg.motes.push(makeMote(w, h));
  bg.motes.length = target;
}

let last = 0;
function frame(t) {
  bg.raf = requestAnimationFrame(frame);
  if (t - last < 33) return; // ~30 fps is plenty for slow dust and saves battery
  last = t;
  const { ctx, w, h } = bg;
  ctx.clearRect(0, 0, w, h);
  // dust is lit by the overhead light: brighter near the top-centre cone
  for (const m of bg.motes) {
    m.sway += m.swaySpeed;
    m.x += Math.sin(m.sway) * m.swayAmp;
    m.y += m.vy;
    if (m.y < -10 || m.x < -10 || m.x > w + 10) Object.assign(m, makeMote(w, h, true));
    const dx = (m.x - w / 2) / (w * 0.55);
    const dy = m.y / (h * 0.9);
    const lit = Math.max(0.25, 1 - Math.sqrt(dx * dx + dy * dy));
    ctx.globalAlpha = m.a * lit;
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawStatic() {
  // one still frame for reduced motion / background off
  if (!bg) return;
  last = 0;
  frame(1e9);
  cancelAnimationFrame(bg.raf);
}

export function initBackground(enabled = true) {
  const canvas = document.getElementById('dust');
  if (!canvas || !canvas.getContext) return;
  if (!bg) {
    bg = { canvas, ctx: canvas.getContext('2d'), motes: [], raf: 0, on: false };
    bg.ctx.fillStyle = '#eef1f5';
    size();
    window.addEventListener('resize', () => { size(); bg.ctx.fillStyle = '#eef1f5'; if (!bg.on) drawStatic(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelAnimationFrame(bg.raf);
      else if (bg.on) bg.raf = requestAnimationFrame(frame);
    });
    reduceMQ.addEventListener?.('change', () => setBackground(bg.wanted));
  }
  setBackground(enabled);
}

export function setBackground(on) {
  if (!bg) return;
  bg.wanted = on;
  cancelAnimationFrame(bg.raf);
  const animate = on && !reduced();
  bg.on = animate;
  document.documentElement.classList.toggle('bg-still', !animate);
  bg.canvas.style.opacity = on ? '' : '0';
  if (animate) bg.raf = requestAnimationFrame(frame);
  else drawStatic();
}

/** Brief flash of the overhead light, e.g. when rest is over. kind: 'go' | 'pr' */
export function pulseLight(kind = 'go') {
  const el = document.getElementById('spotlight');
  if (!el || reduced()) return;
  el.classList.remove('pulse-go', 'pulse-pr');
  void el.offsetWidth; // restart animation
  el.classList.add(kind === 'pr' ? 'pulse-pr' : 'pulse-go');
}

// ------------------------------------------------------------------ chalk burst (PRs)
/** Puff of chalk from a point on screen (the set that just became a PR). */
export function chalkBurst(x, y) {
  if (reduced()) return;
  const c = document.createElement('canvas');
  c.className = 'burst';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth;
  const H = window.innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  c.style.width = `${W}px`; c.style.height = `${H}px`;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const parts = [];
  const colors = ['#eef1f5', '#eef1f5', '#eef1f5', '#ff4d4d', '#ffc21a'];
  for (let i = 0; i < 46; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 1.5 + Math.random() * 4.5;
    parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 2.2, r: 1 + Math.random() * 2.6, life: 1, decay: 0.012 + Math.random() * 0.018, c: colors[i % colors.length] });
  }
  const step = () => {
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive++;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.09; // drag + a little gravity
      p.life -= p.decay;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.6 + p.life * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    if (alive) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ count-up numbers
/** Animate the text of el from 0 up to `to` (keeps a suffix / formatting via fmt). */
export function countUp(el, to, fmt = (v) => Math.round(v).toLocaleString(), ms = 700) {
  if (!el) return;
  if (reduced() || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(to * e);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
