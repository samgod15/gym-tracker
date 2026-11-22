// Visual effects: themed moving backgrounds, PR chalk bursts, light flashes and count-ups.
// Everything here is decoration: it stops with Reduce Motion or the Settings toggle, pauses when
// the app is in the background, runs at ~30 fps, and never blocks logging.

const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => reduceMQ.matches;
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** Soft round light, pre-rendered once per colour so frames only blit images. */
const spriteCache = new Map();
function glow(color, size = 64) {
  const key = `${color}|${size}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, color);
  grd.addColorStop(0.25, color.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.55})`));
  grd.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  spriteCache.set(key, c);
  return c;
}

// =============================================================== renderers
// Each: { res: canvas resolution factor, init(S), frame(S, ctx, t, dt) } where S = {w, h, ...state}

/** Aurora: curtains of light that ripple and drift, drawn at low resolution so they stay soft. */
const aurora = {
  res: 0.33,
  init(S) {
    const { w, h } = S;
    S.bands = [
      { hue: 'rgba(52, 224, 176, 1)', y: 0.2, amp: 0.06, len: 0.42, k: 1.6, sp: 0.18, ph: 0, a: 0.34 },
      { hue: 'rgba(139, 123, 255, 1)', y: 0.3, amp: 0.07, len: 0.5, k: 1.1, sp: -0.12, ph: 2, a: 0.3 },
      { hue: 'rgba(76, 195, 255, 1)', y: 0.12, amp: 0.04, len: 0.32, k: 2.2, sp: 0.25, ph: 4, a: 0.22 },
    ];
    // vertical light ray sprite per band: bright at the top edge, fading downwards
    for (const b of S.bands) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 128;
      const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 0, 128);
      grd.addColorStop(0, b.hue.replace(/1\)$/, '0)'));
      grd.addColorStop(0.22, b.hue.replace(/1\)$/, '0.85)'));
      grd.addColorStop(0.5, b.hue.replace(/1\)$/, '0.3)'));
      grd.addColorStop(1, b.hue.replace(/1\)$/, '0)'));
      g.fillStyle = grd; g.fillRect(0, 0, 1, 128);
      b.sprite = c;
    }
    S.blobs = [
      { c: 'rgba(52, 224, 176, 0.22)', x: 0.2, y: 0.25, r: 0.75, px: 31, py: 23 },
      { c: 'rgba(139, 123, 255, 0.24)', x: 0.8, y: 0.35, r: 0.85, px: 37, py: 29 },
      { c: 'rgba(40, 80, 190, 0.22)', x: 0.5, y: 0.85, r: 0.9, px: 43, py: 41 },
    ];
    S.stars = Array.from({ length: Math.round((w * h) / 380) }, () => ({ x: Math.random(), y: Math.random() * 0.7, a: rand(0.2, 0.9), tw: rand(0.5, 2) }));
  },
  frame(S, ctx, t) {
    const { w, h } = S;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const b of S.blobs) {
      const x = (b.x + Math.sin(t / b.px) * 0.18) * w;
      const y = (b.y + Math.cos(t / b.py) * 0.12) * h;
      const r = b.r * Math.max(w, h);
      ctx.drawImage(glow(b.c, 128), x - r, y - r, r * 2, r * 2);
    }
    for (const s of S.stars) {
      ctx.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(t * s.tw + s.x * 40));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(s.x * w, s.y * h, 1, 1);
    }
    const step = 3;
    for (const b of S.bands) {
      const len = b.len * h;
      for (let x = 0; x < w; x += step) {
        const u = x / w;
        const wave = Math.sin(u * b.k * TAU + t * b.sp * 2 + b.ph) + 0.5 * Math.sin(u * b.k * 2.3 * TAU - t * b.sp * 3.1);
        const y = (b.y + wave * b.amp) * h;
        const shimmer = 0.55 + 0.45 * Math.sin(u * 37 + t * 1.7 + b.ph) * Math.sin(u * 13 - t * 0.9);
        ctx.globalAlpha = Math.max(0, b.a * shimmer);
        ctx.drawImage(b.sprite, x, y - len * 0.22, step + 0.6, len);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  },
};

/** Night Drive: a highway at night. Lane lines rush at you, tail lights pull away, headlights come
 *  toward you, city lights blur on the horizon. */
const nightDrive = {
  res: 1,
  init(S) {
    S.horizon = 0.56;
    S.dashes = Array.from({ length: 14 }, (_, i) => ({ d: 1 + i * 2.6 }));
    const city = ['rgba(255, 170, 60, 0.9)', 'rgba(255, 61, 139, 0.85)', 'rgba(34, 211, 238, 0.85)', 'rgba(255, 230, 180, 0.9)', 'rgba(160, 120, 255, 0.8)'];
    S.bokeh = Array.from({ length: 34 }, () => ({ x: Math.random(), y: rand(-0.16, 0.03), r: rand(4, 22), c: city[Math.floor(Math.random() * city.length)], a: rand(0.15, 0.55), sp: rand(0.004, 0.012), tw: rand(0.5, 1.6) }));
    S.cars = [];
    S.nextCar = 0;
  },
  frame(S, ctx, t, dt) {
    const { w, h } = S;
    const hy = S.horizon * h;
    const cx = w / 2;
    // sky
    if (!S.sky || S.skyH !== h) {
      S.sky = ctx.createLinearGradient(0, 0, 0, h);
      S.sky.addColorStop(0, '#05030b'); S.sky.addColorStop(S.horizon * 0.75, '#140a2a');
      S.sky.addColorStop(S.horizon, '#3a1446'); S.sky.addColorStop(S.horizon + 0.02, '#0b0814'); S.sky.addColorStop(1, '#07050d');
      S.skyH = h;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = S.sky;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    // horizon glow
    const hg = Math.max(w, h) * 0.7;
    ctx.drawImage(glow('rgba(255, 61, 139, 0.28)', 128), cx - hg, hy - hg * 0.45, hg * 2, hg * 0.9);
    // city bokeh drifting left
    for (const b of S.bokeh) {
      b.x -= b.sp * dt;
      if (b.x < -0.1) { b.x = 1.1; b.y = rand(-0.16, 0.03); }
      ctx.globalAlpha = b.a * (0.75 + 0.25 * Math.sin(t * b.tw + b.r));
      const r = b.r * 1.6;
      ctx.drawImage(glow(b.c, 64), b.x * w - r, hy + b.y * h - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // road
    const roadBottom = w * 1.9;
    const sx = (lane, y) => cx + lane * ((y - hy) / (h - hy)) * roadBottom * 0.5;
    ctx.fillStyle = 'rgba(10, 8, 20, 0.92)';
    ctx.beginPath(); ctx.moveTo(cx - 2, hy); ctx.lineTo(cx + 2, hy); ctx.lineTo(cx + roadBottom / 2, h); ctx.lineTo(cx - roadBottom / 2, h); ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    // glowing road edges
    for (const [lane, col] of [[-1, 'rgba(34, 211, 238, 0.55)'], [1, 'rgba(255, 61, 139, 0.55)']]) {
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, hy); ctx.lineTo(sx(lane, h), h); ctx.stroke();
    }
    // lane dashes rushing toward you (depth d: big = far)
    const speed = 9;
    const depthY = (d) => hy + (h - hy) / d;
    for (const ds of S.dashes) {
      ds.d -= speed * dt * (ds.d * 0.08 + 0.02);
      if (ds.d < 0.75) ds.d += 36;
      const y1 = depthY(ds.d);
      const y2 = depthY(ds.d + 0.9);
      if (y1 < hy) continue;
      for (const lane of [-0.34, 0.34]) {
        ctx.strokeStyle = `rgba(255, 236, 200, ${Math.min(0.6, 0.12 + 1.1 / ds.d)})`;
        ctx.lineWidth = Math.max(1, 6 / ds.d);
        ctx.beginPath(); ctx.moveTo(sx(lane, y1), y1); ctx.lineTo(sx(lane, y2), y2); ctx.stroke();
      }
    }
    // traffic: tail lights going away (left lane), headlights coming (right lane)
    S.nextCar -= dt;
    if (S.nextCar <= 0) {
      const away = Math.random() < 0.6;
      S.cars.push({ away, d: away ? 1.2 : 30, lane: away ? rand(-0.75, -0.45) : rand(0.45, 0.75), sp: away ? rand(1.2, 2.2) : rand(6, 9) });
      S.nextCar = rand(0.6, 1.8);
    }
    S.cars = S.cars.filter((c) => {
      c.d += (c.away ? 1 : -1) * c.sp * dt * (c.d * 0.12 + 0.05);
      if (c.d > 40 || c.d < 0.7) return false;
      const y = depthY(c.d);
      const x = sx(c.lane, y);
      const spread = 42 / c.d;
      const r = Math.max(2, 26 / c.d);
      const col = c.away ? 'rgba(255, 40, 60, 0.95)' : 'rgba(255, 246, 225, 0.95)';
      ctx.globalAlpha = Math.min(1, 3 / c.d + 0.25);
      for (const side of [-1, 1]) ctx.drawImage(glow(col, 64), x + side * spread - r * 2, y - r * 2, r * 4, r * 4);
      return true;
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  },
};

/** Ember: sparks rising off a forge, flickering from yellow to deep red as they cool. */
const ember = {
  res: 1,
  init(S) {
    const n = Math.round(Math.min(110, (S.w * S.h) / 4200));
    S.sparks = Array.from({ length: n }, () => ember.spawn(S, true));
  },
  spawn(S, anywhere = false) {
    return {
      x: Math.random() * S.w, y: anywhere ? Math.random() * S.h : S.h + rand(0, 40),
      vy: -rand(28, 95), vx: rand(-8, 8), sway: rand(0, TAU), swaySp: rand(1, 3), r: rand(0.8, 2.6),
      life: anywhere ? Math.random() : 1, decay: rand(0.06, 0.16),
    };
  },
  frame(S, ctx, t, dt) {
    const { w, h } = S;
    if (!S.bg || S.bgH !== h) {
      S.bg = ctx.createLinearGradient(0, 0, 0, h);
      S.bg.addColorStop(0, '#0b0706'); S.bg.addColorStop(0.65, '#160b07'); S.bg.addColorStop(1, '#3a1206');
      S.bgH = h;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = S.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    // breathing heat at the bottom
    const pulse = 0.75 + 0.25 * Math.sin(t * 0.9) * Math.sin(t * 0.37);
    const hr = Math.max(w, h) * 0.8;
    ctx.globalAlpha = pulse;
    ctx.drawImage(glow('rgba(255, 90, 20, 0.35)', 128), w / 2 - hr, h - hr * 0.55, hr * 2, hr * 1.1);
    for (const s of S.sparks) {
      s.sway += s.swaySp * dt;
      s.x += (s.vx + Math.sin(s.sway) * 14) * dt;
      s.y += s.vy * dt;
      s.life -= s.decay * dt;
      if (s.life <= 0 || s.y < -20) Object.assign(s, ember.spawn(S));
      const L = Math.max(0, s.life);
      const col = L > 0.66 ? 'rgba(255, 214, 120, 1)' : L > 0.33 ? 'rgba(255, 128, 40, 1)' : 'rgba(220, 50, 20, 1)';
      const flick = 0.65 + 0.35 * Math.sin(t * 13 + s.sway * 3);
      ctx.globalAlpha = Math.min(1, L * 1.4) * flick;
      const r = s.r * (2.5 + L * 2.5);
      ctx.drawImage(glow(col, 32), s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  },
};

/** Chalk: an overhead spotlight (CSS) with chalk dust drifting up through it. */
const chalk = {
  res: 1,
  init(S) {
    const n = Math.round(Math.min(80, (S.w * S.h) / 7000));
    S.motes = Array.from({ length: n }, () => chalk.mote(S, false));
  },
  mote(S, fresh) {
    const depth = Math.random();
    return { x: Math.random() * S.w, y: fresh ? S.h + rand(0, 40) : Math.random() * S.h, r: 0.6 + depth * 1.8, a: 0.08 + depth * 0.4, vy: -(4 + depth * 14), sway: rand(0, TAU), swaySp: rand(0.2, 0.6), swayAmp: rand(4, 14) };
  },
  frame(S, ctx, t, dt) {
    const { w, h } = S;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#eef1f5';
    for (const m of S.motes) {
      m.sway += m.swaySp * dt;
      m.x += Math.cos(m.sway) * m.swayAmp * dt;
      m.y += m.vy * dt;
      if (m.y < -10 || m.x < -10 || m.x > w + 10) Object.assign(m, chalk.mote(S, true));
      const dx = (m.x - w / 2) / (w * 0.55);
      const dy = m.y / (h * 0.9);
      const lit = Math.max(0.3, 1 - Math.sqrt(dx * dx + dy * dy));
      ctx.globalAlpha = m.a * lit;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
};

export const THEMES = {
  aurora: { label: 'Aurora', renderer: aurora, themeColor: '#04070d' },
  night: { label: 'Night Drive', renderer: nightDrive, themeColor: '#06040c' },
  ember: { label: 'Ember', renderer: ember, themeColor: '#0b0706' },
  chalk: { label: 'Chalk', renderer: chalk, themeColor: '#080b12' },
};
export const DEFAULT_THEME = 'aurora';

// =============================================================== engine
let E = null; // { canvas, ctx, theme, S, raf, on, wanted, last }

function sizeCanvas() {
  const r = THEMES[E.theme].renderer;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * r.res;
  const w = E.canvas.clientWidth || window.innerWidth;
  const h = E.canvas.clientHeight || window.innerHeight;
  E.canvas.width = Math.max(1, Math.round(w * dpr));
  E.canvas.height = Math.max(1, Math.round(h * dpr));
  E.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  E.S = { w, h };
  r.init(E.S);
}

function loop(now) {
  E.raf = requestAnimationFrame(loop);
  if (now - E.last < 33) return; // ~30 fps
  const dt = Math.min(0.1, (now - (E.prev || now)) / 1000);
  E.prev = now;
  E.last = now;
  THEMES[E.theme].renderer.frame(E.S, E.ctx, now / 1000, dt);
}

function still() {
  // a single representative frame when motion is off
  cancelAnimationFrame(E.raf);
  const r = THEMES[E.theme].renderer;
  for (let i = 0; i < 40; i++) r.frame(E.S, E.ctx, 12 + i / 30, 1 / 30);
}

function start() {
  cancelAnimationFrame(E.raf);
  const animate = E.wanted && !reduced() && !document.hidden;
  E.on = animate;
  document.documentElement.classList.toggle('bg-still', !animate);
  E.prev = 0;
  if (animate) E.raf = requestAnimationFrame(loop);
  else still();
}

export function initBackground(enabled = true, theme = DEFAULT_THEME) {
  const canvas = document.getElementById('dust');
  if (!canvas || !canvas.getContext) return;
  if (!E) {
    E = { canvas, ctx: canvas.getContext('2d'), theme: THEMES[theme] ? theme : DEFAULT_THEME, S: null, raf: 0, on: false, wanted: enabled, last: 0 };
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { sizeCanvas(); start(); }, 150); });
    document.addEventListener('visibilitychange', () => start());
    reduceMQ.addEventListener?.('change', () => start());
  }
  E.wanted = enabled;
  applyThemeAttr(E.theme);
  sizeCanvas();
  start();
}

export function setBackground(on) {
  if (!E) return;
  E.wanted = on;
  start();
}

function applyThemeAttr(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('gt-theme', name); } catch { /* private mode */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEMES[name].themeColor);
}

export function setTheme(name) {
  if (!THEMES[name]) name = DEFAULT_THEME;
  if (!E) { applyThemeAttr(name); return; }
  E.canvas.classList.add('swap');
  setTimeout(() => {
    E.theme = name;
    applyThemeAttr(name);
    sizeCanvas();
    start();
    E.canvas.classList.remove('swap');
  }, reduced() ? 0 : 220);
}

/** Brief flash of light across the background: 'go' when rest is over, 'pr' on a PR. */
export function pulseLight(kind = 'go') {
  const el = document.getElementById('flash');
  if (!el || reduced()) return;
  el.classList.remove('pulse-go', 'pulse-pr');
  void el.offsetWidth;
  el.classList.add(kind === 'pr' ? 'pulse-pr' : 'pulse-go');
}

// =============================================================== PR burst
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
  const css = getComputedStyle(document.documentElement);
  const colors = ['#ffffff', '#ffffff', css.getPropertyValue('--plate-red').trim() || '#ff4d4d', css.getPropertyValue('--plate-blue-hi').trim() || '#6aa4ff', '#ffc21a'];
  const parts = [];
  for (let i = 0; i < 52; i++) {
    const ang = Math.random() * TAU;
    const sp = 1.5 + Math.random() * 5;
    parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 2.4, r: 1 + Math.random() * 2.8, life: 1, decay: 0.012 + Math.random() * 0.018, c: colors[i % colors.length] });
  }
  const step = () => {
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive++;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.09;
      p.life -= p.decay;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.6 + p.life * 0.6), 0, TAU);
      ctx.fill();
    }
    if (alive) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}

// =============================================================== count-up
export function countUp(el, to, fmt = (v) => Math.round(v).toLocaleString(), ms = 700) {
  if (!el) return;
  if (reduced() || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
