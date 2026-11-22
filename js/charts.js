// Minimal SVG line chart with crosshair + tooltip (touch: press and drag).
// Follows the dataviz spec: 2px lines, ≥8px markers with a 2px surface ring, hairline grid, one y-axis,
// text in ink tokens (never series colour), legend only for 2+ series.

import { h, svgEl } from './ui.js';

const W = 340;
const H = 190;
const M = { t: 14, r: 40, b: 26, l: 40 };

function niceStep(range, target = 4) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
  return step * mag;
}

function ticks(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const fmtTick = (v) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}K` : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1));
const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * series: [{ name, color: 'var(--series-1)', points: [{x: ms, y: number, note?: string}], line=true, dots=true }]
 * fmt: value formatter for labels/tooltip.
 */
export function lineChart({ series, fmt = (v) => String(v), ariaLabel = 'Chart' }) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return h('div', { class: 'chart-empty' }, 'No data yet — log a session to see the trend.');

  let xMin = Math.min(...all.map((p) => p.x));
  let xMax = Math.max(...all.map((p) => p.x));
  if (xMin === xMax) { xMin -= 86400000 * 3; xMax += 86400000 * 3; }
  const ys = all.map((p) => p.y);
  const yT = ticks(Math.min(...ys), Math.max(...ys));
  const yMin = yT[0];
  const yMax = yT[yT.length - 1];

  const px = (x) => M.l + ((x - xMin) / (xMax - xMin)) * (W - M.l - M.r);
  const py = (y) => M.t + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - M.t - M.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': ariaLabel });

  // grid + y ticks
  for (const v of yT) {
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: py(v), y2: py(v), class: 'grid' }));
    svg.appendChild(svgEl('text', { x: M.l - 6, y: py(v) + 4, class: 'tick', 'text-anchor': 'end' }, fmtTick(v)));
  }
  svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'axis' }));

  // x ticks: first, middle, last date
  const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
  const xt = xs.length <= 3 ? xs : [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]];
  xt.forEach((x, i) => {
    const anchor = xt.length > 1 && i === 0 ? 'start' : i === xt.length - 1 && xt.length > 1 ? 'end' : 'middle';
    svg.appendChild(svgEl('text', { x: px(x), y: H - 8, class: 'tick', 'text-anchor': anchor }, fmtDay(x)));
  });

  // series
  for (const s of series) {
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    if (s.line !== false && pts.length > 1) {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
      svg.appendChild(svgEl('path', { d, pathLength: 1, class: 'series-line', style: `stroke:${s.color}` }));
    }
    if (s.dots !== false) {
      for (const p of pts) svg.appendChild(svgEl('circle', { cx: px(p.x), cy: py(p.y), r: 4, class: 'series-dot', style: `fill:${s.color}` }));
    }
  }

  // direct label: last value of the first (primary) series
  const prim = [...series[0].points].sort((a, b) => a.x - b.x);
  if (prim.length) {
    const last = prim[prim.length - 1];
    svg.appendChild(svgEl('text', { x: px(last.x) + 7, y: py(last.y) + 4, class: 'end-label' }, fmt(last.y)));
  }

  // hover layer
  const cross = svgEl('line', { y1: M.t, y2: H - M.b, class: 'crosshair', style: 'display:none' });
  const hi = svgEl('circle', { r: 5, class: 'hover-dot', style: 'display:none' });
  svg.appendChild(cross);
  svg.appendChild(hi);
  const hit = svgEl('rect', { x: M.l - 10, y: 0, width: W - M.l - M.r + 20, height: H, fill: 'transparent', class: 'hit' });
  svg.appendChild(hit);

  // Readout sits above the plot (a floating tooltip would cover the title on a phone).
  // It shows the latest point by default and follows your finger / the arrow keys.
  const tip = h('div', { class: 'chart-readout', role: 'status', 'aria-live': 'polite' });
  const wrap = h('div', { class: 'chart-wrap', tabindex: '0', 'aria-label': `${ariaLabel}. Use left and right arrow keys to read values.` }, tip, svg);

  let idx = xs.length - 1;
  const readout = (x) => {
    tip.replaceChildren(h('div', { class: 'tip-date' }, fmtDay(x)));
    let first = null;
    for (const s of series) {
      const p = s.points.find((q) => q.x === x);
      if (!p) continue;
      if (!first) first = p;
      tip.appendChild(h('div', { class: 'tip-row' },
        h('span', { class: 'tip-key', style: { background: s.color } }),
        h('strong', null, fmt(p.y)),
        series.length > 1 ? h('span', { class: 'tip-name' }, s.name) : null));
      if (p.note) tip.appendChild(h('div', { class: 'tip-note' }, p.note));
    }
    return first;
  };
  const show = (x) => {
    cross.setAttribute('x1', px(x)); cross.setAttribute('x2', px(x));
    cross.style.display = '';
    const first = readout(x);
    if (first) {
      hi.setAttribute('cx', px(x)); hi.setAttribute('cy', py(first.y));
      hi.style.display = '';
      hi.style.fill = series.find((s) => s.points.includes(first))?.color || '';
    }
  };
  const hide = () => { cross.style.display = 'none'; hi.style.display = 'none'; idx = xs.length - 1; readout(xs[idx]); };
  readout(xs[idx]);
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const sx = ((evt.clientX - r.left) / r.width) * W;
    let best = 0; let bd = Infinity;
    xs.forEach((x, i) => { const d = Math.abs(px(x) - sx); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  hit.addEventListener('pointerdown', (e) => { idx = nearest(e); show(xs[idx]); });
  hit.addEventListener('pointermove', (e) => { idx = nearest(e); show(xs[idx]); });
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { idx = Math.max(0, idx - 1); show(xs[idx]); e.preventDefault(); }
    if (e.key === 'ArrowRight') { idx = Math.min(xs.length - 1, idx + 1); show(xs[idx]); e.preventDefault(); }
    if (e.key === 'Escape') hide();
  });
  wrap.addEventListener('blur', hide);

  const legend = series.length > 1
    ? h('div', { class: 'legend' }, series.map((s) => h('span', { class: 'legend-item' },
      h('span', { class: s.line === false ? 'legend-dot' : 'legend-line', style: { background: s.color } }), s.name)))
    : null;

  return h('div', { class: 'chart' }, legend, wrap);
}
