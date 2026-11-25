// Training plan file: a PDF (or a photo of the plan) shown page by page inside the app.
// The original file and the rendered page images live in IndexedDB ("blobs" store, this phone only).
// A small record in the synced "files" store says which file is the plan; sync.js copies the
// original file to Firestore in chunks so another phone signed in to the same account gets it too.

import * as db from './db.js';
import { linesFromItems, parsePlan } from './planparse.js';

export const MAX_BYTES = 10 * 1024 * 1024; // keeps everyone well inside Firestore's free 1 GiB
export const MAX_PAGES = 40;
const PAGE_WIDTH = 1400; // px; sharp on a 3x iPhone screen, small enough for iOS canvas limits
const PDFJS = new URL('./vendor/pdfjs/', import.meta.url).href;

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(`${PDFJS}pdf.min.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
      return m;
    }).catch((e) => { pdfjsP = null; throw e; });
  }
  return pdfjsP;
}

export async function getPlan() {
  return db.get('files', 'plan');
}

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const isPdf = (type, name = '') => type === 'application/pdf' || /\.pdf$/i.test(name);

/** Check a picked file. Returns an error message, or null if it's fine. */
export function checkFile(file) {
  if (!file) return 'No file picked';
  const okType = isPdf(file.type, file.name) || /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.type);
  if (!okType) return 'Pick a PDF or a photo of your plan';
  if (file.size > MAX_BYTES) return `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_BYTES / 1048576} MB.`;
  if (!file.size) return 'That file is empty';
  return null;
}

/** Save a picked file as the plan. onStep(text) reports progress. Returns the plan record. */
export async function importPlan(file, onStep = () => {}) {
  const err = checkFile(file);
  if (err) throw new Error(err);
  onStep('Reading file…');
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  const type = isPdf(file.type, file.name) ? 'application/pdf' : file.type;
  const blob = new Blob([buf], { type });
  await db.putBlob(`file:${hash}`, blob);
  const pages = await renderPages(hash, blob, onStep);
  const prev = await getPlan();
  const rec = await db.put('files', {
    id: 'plan', name: file.name || 'Plan', type, size: buf.byteLength, hash, pages,
    addedAt: Date.now(),
  });
  if (prev && prev.hash !== hash) await gc();
  return rec;
}

/** Render every page to a JPEG and store it. Returns the page count. */
export async function renderPages(hash, blob, onStep = () => {}) {
  if (!isPdf(blob.type)) {
    await db.putBlob(`page:${hash}:1`, await toJpeg(blob));
    return 1;
  }
  onStep('Opening PDF…');
  const lib = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data, isEvalSupported: false,
    standardFontDataUrl: `${PDFJS}standard_fonts/`, wasmUrl: `${PDFJS}wasm/`,
  });
  const doc = await task.promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  try {
    for (let i = 1; i <= n; i++) {
      onStep(`Preparing page ${i} of ${n}…`);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(0.5, PAGE_WIDTH / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      const jpg = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      await db.putBlob(`page:${hash}:${i}`, jpg);
      page.cleanup();
      canvas.width = canvas.height = 0; // free the memory now; iOS is strict about canvas memory
    }
  } finally {
    task.destroy();
  }
  return n;
}

/** Re-encode a photo as JPEG (also turns HEIC into something every browser can show). */
async function toJpeg(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
  } catch {
    return blob; // the browser couldn't decode it; keep the original
  }
}

/**
 * Object URLs for the plan's pages, rendering them first if only the original file is here
 * (e.g. it just arrived from another phone). Returns { urls, missing } — missing means the file
 * hasn't reached this phone yet. Call revoke() on the result when done.
 */
export async function pageUrls(plan, onStep) {
  const keys = Array.from({ length: plan.pages || 1 }, (_, i) => `page:${plan.hash}:${i + 1}`);
  let blobs = await Promise.all(keys.map((k) => db.getBlob(k)));
  if (blobs.some((b) => !b)) {
    const file = await db.getBlob(`file:${plan.hash}`);
    if (!file) return { urls: [], missing: true, revoke() {} };
    await renderPages(plan.hash, file, onStep);
    blobs = await Promise.all(keys.map((k) => db.getBlob(k)));
  }
  const urls = blobs.filter(Boolean).map((b) => URL.createObjectURL(b));
  return { urls, missing: false, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

export async function originalFile(plan) {
  const blob = await db.getBlob(`file:${plan.hash}`);
  if (!blob) return null;
  return new File([blob], plan.name || 'plan.pdf', { type: plan.type || blob.type });
}

export async function removePlan() {
  await db.remove('files', 'plan');
  await gc();
}

/** Delete stored files and pages that the current plan no longer uses. */
export async function gc() {
  const plan = await getPlan();
  const keep = plan ? plan.hash : null;
  const keys = await db.blobKeys();
  const drop = keys.filter((k) => { const h = k.split(':')[1]; return h !== keep; });
  if (drop.length) await db.deleteBlobs(drop);
}

/** The text of each page (pdf.js text items). Photos and scanned PDFs have none. */
export async function readText(plan) {
  if (!plan || !isPdf(plan.type, plan.name)) return [];
  const blob = await db.getBlob(`file:${plan.hash}`);
  if (!blob) return [];
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false,
    standardFontDataUrl: `${PDFJS}standard_fonts/`, wasmUrl: `${PDFJS}wasm/`,
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items);
      page.cleanup();
    }
  } finally {
    task.destroy();
  }
  return pages;
}

/** Workouts found in the plan: { days, weeks, hasText }. */
export async function readWorkouts(plan) {
  const pages = await readText(plan);
  const lines = linesFromItems(pages);
  return { ...parsePlan(lines), hasText: lines.length > 3 };
}

