// Tiny DOM helpers. All text goes in via text nodes — never innerHTML with data.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

/** Replace an element's children; accepts nested arrays like h(). */
export function fill(el, ...children) {
  el.textContent = '';
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of children) if (c) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

let toastTimer = null;
export function toast(msg, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

/** Bottom sheet. content: Node or (close) => Node. Returns close(). */
export function sheet(content, { title = '', onClose } = {}) {
  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 180);
    document.removeEventListener('keydown', esc);
    onClose && onClose();
  };
  const esc = (e) => e.key === 'Escape' && close();
  const body = typeof content === 'function' ? content(close) : content;
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e) => e.target === overlay && close() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
        title ? h('h2', { class: 'sheet-title' }, title) : null,
        h('button', { class: 'icon-btn sheet-x', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'sheet-body' }, body)));
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  document.addEventListener('keydown', esc);
  return close;
}

export function confirmSheet(message, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const close = sheet((closeFn) => h('div', { class: 'stack' },
      h('p', { class: 'confirm-msg' }, message),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost grow', onclick: () => { answered = true; resolve(false); closeFn(); } }, 'Cancel'),
        h('button', { class: `btn grow ${danger ? 'danger' : 'primary'}`, onclick: () => { answered = true; resolve(true); closeFn(); } }, ok))),
    { onClose: () => !answered && resolve(false) });
    return close;
  });
}

export function fmtDate(ms, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(ms).toLocaleDateString(undefined, opts);
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
