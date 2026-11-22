// "Add to Home Screen" help. iPhones have no install button a website can trigger, so on iOS we
// show the exact taps (iOS 26 hides Share behind the ⋯ button). Android/desktop Chrome get a real
// Install button via beforeinstallprompt.

import { h, sheet, toast } from './ui.js';

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
window.addEventListener('appinstalled', () => { deferredPrompt = null; });

export const isStandalone = () =>
  window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isOtherIOSBrowser = () => /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
export const canPrompt = () => !!deferredPrompt;

const icon = (paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'step-ico');
  s.innerHTML = paths; // static markup defined below, no user data
  return s;
};
const ICON = {
  more: '<circle cx="12" cy="12" r="9.5"/><circle cx="8" cy="12" r="1.2" class="f"/><circle cx="12" cy="12" r="1.2" class="f"/><circle cx="16" cy="12" r="1.2" class="f"/>',
  share: '<path d="M8 9H6.5A1.5 1.5 0 0 0 5 10.5v9A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 17.5 9H16"/><path d="M12 15V3M8.5 6.5 12 3l3.5 3.5"/>',
  add: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>',
  toggle: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="3.2" class="f"/>',
  home: '<rect x="5" y="3" width="14" height="18" rx="3"/><rect x="8" y="7" width="3.2" height="3.2" rx=".8" class="f"/><rect x="12.8" y="7" width="3.2" height="3.2" rx=".8" class="f"/><rect x="8" y="12" width="3.2" height="3.2" rx=".8" class="f"/>',
};

const step = (ico, ...text) => h('li', { class: 'step' }, icon(ICON[ico]), h('div', null, ...text));

export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  return choice?.outcome === 'accepted';
}

export function showInstallGuide() {
  const url = location.href.split('#')[0];
  sheet((close) => {
    if (isStandalone()) {
      return h('div', { class: 'stack' }, h('p', { class: 'confirm-msg' }, 'You’re already using the Home Screen app. Nothing else to do.'),
        h('button', { class: 'btn primary block', onclick: close }, 'Done'));
    }
    if (canPrompt()) {
      return h('div', { class: 'stack' },
        h('p', { class: 'confirm-msg' }, 'Install Gym Tracker so it opens full screen from its own icon and works offline.'),
        h('button', { class: 'btn primary block', onclick: async () => { const ok = await promptInstall(); close(); if (ok) toast('Installed — open it from your home screen'); } }, 'Install app'));
    }
    if (isIOS()) {
      const steps = isOtherIOSBrowser()
        ? [
          step('share', 'Tap ', h('strong', null, 'Share'), ' in the address bar.'),
          step('add', 'Scroll down and tap ', h('strong', null, 'Add to Home Screen'), '.'),
          step('toggle', 'Leave ', h('strong', null, 'Open as Web App'), ' on and tap ', h('strong', null, 'Add'), '.'),
          step('home', 'Open Gym Tracker from the new icon.'),
        ]
        : [
          step('more', 'Tap the ', h('strong', null, '⋯'), ' button next to the address bar. On older iPhones, tap the ', h('strong', null, 'Share'), ' button at the bottom instead and skip to step 3.'),
          step('share', 'Tap ', h('strong', null, 'Share'), '.'),
          step('add', 'Scroll down and tap ', h('strong', null, 'Add to Home Screen'), '.'),
          step('toggle', 'Leave ', h('strong', null, 'Open as Web App'), ' on and tap ', h('strong', null, 'Add'), '.'),
          step('home', 'Open Gym Tracker from the new icon on your home screen.'),
        ];
      return h('div', { class: 'stack' },
        h('ol', { class: 'steps' }, steps),
        h('p', { class: 'muted small' }, 'The home screen app keeps its own log, separate from this browser tab. If you already logged sets here, export a backup in Settings first and import it in the app, or turn on sync.'),
        h('button', { class: 'btn primary block', onclick: close }, 'Got it'));
    }
    // desktop or another phone: send the link to the iPhone
    return h('div', { class: 'stack' },
      h('p', { class: 'confirm-msg' }, 'Open this link in Safari on your iPhone, then come back to this screen for the steps:'),
      h('div', { class: 'link-box' }, url),
      h('button', { class: 'btn primary block', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('Copy failed — select the link and copy it'); }
      } }, 'Copy link'));
  }, { title: 'Add to Home Screen' });
}
