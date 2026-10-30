// Digiteq Dashboard front-end. Plain JS, no build step. Works as a website, an installed PC app and a phone app.
import { registerFinance, clientFinanceTab, financeBanner, dropDeal } from './finance.js';
import { registerBotUI } from './bot.js';

// ------------------------------------------------------------------ state & storage
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const S = {
  token: store.get('dq_token'),
  user: null,
  unread: 0,
  live: false,
  pushOn: false,
  installEvt: null,
  notes: { open: false, list: null, converting: null, editing: null },
  ui: {
    myStatus: 'todo', adminStatus: 'open', clientTab: 'tasks', assignee: '', client: '', source: '', taskSearch: '', clientSearch: '',
    layout: store.get('dq_layout') || 'list',
  },
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const isAdmin = () => S.user?.role === 'superadmin';
const isOwner = () => isAdmin() && !!S.user?.is_owner;
const roleLabel = (u) => (u.role !== 'superadmin' ? 'Employee' : u.is_owner ? 'Owner' : 'Super admin');
const isMobile = () => matchMedia('(max-width: 900px)').matches;

// ------------------------------------------------------------------ api
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Cannot reach the server. Check your internet connection.'); e.status = 0; throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user) logout(true);
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const PALETTE = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#e11d48', '#db2777', '#7c3aed', '#0f766e', '#475569'];
const userColor = (id) => PALETTE[(Number(id) || 0) % PALETTE.length];
const pad = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const fmtTime = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function fmtShort(iso) {
  const d = new Date(iso);
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtFull = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return fmtShort(iso);
}
function dueInfo(iso, done) {
  const d = new Date(iso), diff = d - Date.now();
  if (done) return { text: fmtShort(iso), cls: '' };
  if (diff < 0) return { text: `Overdue · ${fmtShort(iso)}`, cls: 'red' };
  if (sameDay(d, new Date())) return { text: `Today ${fmtTime(d)}`, cls: 'amber' };
  if (sameDay(d, new Date(Date.now() + 86400000))) return { text: `Tomorrow ${fmtTime(d)}`, cls: 'amber' };
  return { text: fmtShort(iso), cls: diff < 3 * 86400000 ? 'amber' : '' };
}
const isOverdue = (t) => t.status !== 'done' && t.deadline && new Date(t.deadline) < new Date();
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const fileSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const STATUS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const PRIO = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
function quickDateValue(key) {
  const d = new Date(); d.setHours(18, 0, 0, 0);
  const add = { today: 0, tomorrow: 1, '3d': 3, week: 7 }[key];
  if (add === undefined) return '';
  d.setDate(d.getDate() + add);
  return toLocalInput(d.toISOString());
}
const QUICK_DATES = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['3d', 'In 3 days'], ['week', 'Next week'], ['clear', 'None']];

const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/><path d="M8 13h8M8 17h5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  board: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  auto: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M12 3v14"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  spark: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
};
const ic = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="--c:${userColor(u.id)}" title="${esc(u.name)}">${esc(initials(u.name))}</span>`;
// Client logo: uploaded image, or coloured initials.
const logo = (c, size = '') => (c.logo_key
  ? `<span class="logo img ${size}"><img src="/api/logos/${esc(c.logo_key)}" alt="${esc(c.name)} logo" loading="lazy"></span>`
  : `<span class="logo ${size}" style="--c:${esc(c.color || '#4f46e5')}">${esc(initials(c.name))}</span>`);
const taskClient = (t) => ({ name: t.client_name, color: t.client_color, logo_key: t.client_logo });
const empty = (icon, title, text = '', extra = '') => `<div class="empty"><div class="ico">${ic(icon)}</div><b>${title}</b>${text ? `<div class="small">${text}</div>` : ''}${extra}</div>`;

// ------------------------------------------------------------------ theme
function setTheme(t) { store.set('dq_theme', t); document.documentElement.dataset.theme = t; }

// ------------------------------------------------------------------ toasts, sound
function toast(text, kind = '', { title = '', onClick = null, ms = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-ico">${ic(kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : 'bell')}</div>
    <div class="grow">${title ? `<b>${esc(title)}</b>` : ''}<span>${esc(text)}</span></div>`;
  el.onclick = () => { el.remove(); onClick?.(); };
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
function ding() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.frequency.setValueAtTime(880, c.currentTime); o.frequency.setValueAtTime(1320, c.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.45);
    o.start(); o.stop(c.currentTime + 0.5);
  } catch { /* audio not allowed yet */ }
}

// ------------------------------------------------------------------ modals (bottom sheets on phones)
const stack = [];
let ignorePop = 0, pendingHash = null;
function openModal({ title = '', body = '', foot = '', wide = false, form = null, sticky = false, onClose = null, data = {} }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const tag = form ? 'form' : 'div';
  ov.innerHTML = `<${tag} class="modal ${wide ? 'wide' : ''}" ${form ? `data-submit="${form}" novalidate` : ''}>
    <div class="modal-head"><h2></h2><div class="row head-extra" style="gap:2px"></div>
      <button type="button" class="icon-btn" data-act="closeModal" aria-label="Close">${ic('x')}</button></div>
    <div class="modal-body"></div><div class="modal-foot"></div></${tag}>`;
  const m = {
    ov, el: ov.firstElementChild, data, sticky, onClose,
    setTitle(t) { $('.modal-head h2', ov).textContent = t; },
    setHead(h) { $('.head-extra', ov).innerHTML = h; },
    setBody(h) {
      const b = $('.modal-body', ov); const top = b.scrollTop;
      const kept = {}; $$('[data-mkeep]', b).forEach((i) => { kept[i.dataset.mkeep] = [i.value, i.dataset.touched]; });
      const active = document.activeElement?.dataset?.mkeep;
      b.innerHTML = h;
      $$('[data-mkeep]', b).forEach((i) => { const k = kept[i.dataset.mkeep]; if (k) { i.value = k[0]; if (k[1]) i.dataset.touched = k[1]; i.dispatchEvent(new Event('input', { bubbles: true })); } });
      if (active) $(`[data-mkeep="${active}"]`, b)?.focus({ preventScroll: true });
      b.scrollTop = top;
    },
    setFoot(h) { const f = $('.modal-foot', ov); f.innerHTML = h; f.classList.toggle('hidden', !h); },
  };
  m.setTitle(title); m.setBody(body); m.setFoot(foot);
  ov.addEventListener('click', (e) => { if (e.target === ov && !m.sticky) closeTop(); });
  $('#modal-root').append(ov);
  stack.push(m);
  history.pushState({ modal: stack.length }, ''); // phone back button closes the sheet instead of leaving the app
  if (!isMobile()) setTimeout(() => $('input:not([type=hidden]):not([type=file]), textarea', m.el)?.focus({ preventScroll: true }), 60);
  return m;
}
function closeTop(fromPop = false) {
  const m = stack.pop();
  if (!m) return;
  m.ov.remove();
  if (!fromPop) { ignorePop++; history.back(); }
  m.onClose?.();
}
function closeModalObj(m) { while (stack.includes(m)) closeTop(); }
const modalOf = (el) => stack.find((m) => m.ov.contains(el));
window.addEventListener('popstate', () => {
  if (ignorePop) {
    ignorePop--;
    if (pendingHash && !ignorePop) { const h = pendingHash; pendingHash = null; location.hash = h; }
    return;
  }
  if (stack.length) closeTop(true);
  else if (S.notes.open && S.notes.pushed) closeNotes(true);
});
function go(to) {
  const hash = `#/${to}`;
  let n = stack.length;
  while (stack.length) closeTop(true);
  if (S.notes.open) { if (S.notes.pushed) n++; closeNotes(true); }
  if (n) { ignorePop++; pendingHash = hash; history.go(-n); return; }
  if (ignorePop) { pendingHash = hash; return; } // a sheet's history.back() is still in flight; navigate once it lands
  if (location.hash === hash) renderView(true); else location.hash = hash;
}
function ask(text, { ok = 'Confirm', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title, body: `<p class="muted" style="font-size:15px">${esc(text)}</p>`,
      foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button>
             <button type="button" class="btn ${danger ? 'danger-fill' : 'primary'}" data-act="askOk">${esc(ok)}</button>`,
      onClose: () => resolve(m.data.ok === true),
    });
  });
}

// ------------------------------------------------------------------ attachments picker (files + links)
const MAX_FILE = 25 * 1024 * 1024;
const attachPicker = () => `<div class="attach" data-attach>
  <div class="attach-list"></div>
  <div class="link-form hidden">
    <input class="input" data-link-url type="url" inputmode="url" placeholder="Paste a link (https://…)">
    <input class="input" data-link-title placeholder="Name (optional)">
    <button type="button" class="btn" data-act="attAddLink">Add</button>
  </div>
  <div class="dropzone">
    <button type="button" class="btn sm" data-act="attShowLink">${ic('link')} Add link</button>
    <label class="btn sm">${ic('upload')} Upload files<input type="file" multiple hidden data-att-file></label>
    <div class="hint">Files up to 25 MB, or paste a Drive / Dropbox link</div>
  </div></div>`;
function attachItems(box) { return (box._items ||= []); }
function renderAttach(box) {
  $('.attach-list', box).innerHTML = attachItems(box).map((it, i) => `<div class="attach-item">
    <span class="${it.kind === 'link' ? '' : 'faint'}">${ic(it.kind === 'link' ? 'link' : 'file')}</span>
    <div class="grow ellipsis">${esc(it.kind === 'link' ? (it.title || it.url) : it.name)}
      <span class="muted small">· ${it.kind === 'link' ? esc(hostOf(it.url)) : fileSize(it.size)}</span></div>
    <button type="button" class="icon-btn sm" data-act="attRemove" data-i="${i}" aria-label="Remove">${ic('x')}</button></div>`).join('');
}
async function collectAttachments(root) {
  const out = [];
  for (const box of $$('[data-attach]', root)) {
    // A link typed but not "Added" still counts, so nothing is lost.
    const url = $('[data-link-url]', box).value.trim();
    if (url) out.push({ kind: 'link', url, title: $('[data-link-title]', box).value.trim() });
    for (const item of attachItems(box)) {
      if (item.kind === 'link') { out.push(item); continue; }
      // Keep a successful upload for retries if a later file or form save fails.
      if (!item.uploaded) {
        const res = await fetch('/api/upload', {
          method: 'POST', headers: { Authorization: `Bearer ${S.token}`,
            'Content-Type': item.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(item.name) },
          body: item.file,
        });
        const data = await res.json();
        if (res.status === 401) logout(true);
        if (!res.ok) throw new Error(data.error || 'Could not upload file');
        item.uploaded = data;
      }
      out.push({ kind: 'file', ...item.uploaded });
    }
  }
  return out;
}
// Shrink a logo to max 256 px and re-encode as PNG (keeps transparency, small upload, strips anything odd).
async function resizeImage(file, max = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('That file is not an image we can read'));
      i.src = url;
    });
    const w = img.naturalWidth || max, h = img.naturalHeight || max;
    const scale = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
document.addEventListener('change', async (e) => {
  const input = e.target;
  try {
    if (input.matches('[data-att-file]')) {
      const box = input.closest('[data-attach]');
      for (const f of input.files) {
        if (f.size > MAX_FILE) { toast(`${f.name} is larger than 25 MB. Share it as a link instead.`, 'bad'); continue; }
        attachItems(box).push({ kind: 'file', name: f.name, type: f.type, size: f.size, file: f });
      }
      input.value = '';
      renderAttach(box);
    } else if (input.matches('[data-logo-file]') && input.files[0]) {
      const dataUrl = await resizeImage(input.files[0]);
      input.value = '';
      const m = modalOf(input);
      if (m) { // client form preview
        m.data.logo = dataUrl;
        $('[data-logo-preview]', m.el).innerHTML = `<span class="logo img"><img src="${dataUrl}" alt=""></span>`;
        $('[data-act="removeLogo"]', m.el).classList.remove('hidden');
      } else if (input.dataset.id) { // direct change from the client page header
        await api('PATCH', `/api/clients/${input.dataset.id}`, { logo: dataUrl });
        toast('Logo updated', 'ok'); scheduleRefresh();
      }
    }
  } catch (err) { toast(err.message, 'bad'); }
});

function materialList(list, emptyText = 'Nothing added yet') {
  if (!list.length) return `<div class="muted small" style="padding:6px 0">${emptyText}</div>`;
  return `<div class="card list">${list.map((m) => `<div class="list-item">
    <div class="mat-icon ${m.kind}">${ic(m.kind === 'link' ? 'link' : 'file')}</div>
    <div class="grow"><div class="ellipsis strong">${esc(m.title)}</div>
      <div class="muted small ellipsis">${m.kind === 'link' ? esc(hostOf(m.url)) : `${esc(m.file_name)} · ${fileSize(m.size)}`} · ${esc(m.added_by_name || '')} · ${fmtDay(m.created_at)}</div></div>
    ${m.kind === 'link'
    ? `<a class="btn sm" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${ic('external')}<span class="hide-mobile">Open</span></a>`
    : `<button type="button" class="btn sm" data-act="openFile" data-id="${m.id}" data-name="${esc(m.file_name)}">${ic('download')}<span class="hide-mobile">Download</span></button>`}
    ${isAdmin() || m.added_by === S.user.id ? `<button type="button" class="icon-btn sm" data-act="delMaterial" data-id="${m.id}" aria-label="Remove">${ic('trash')}</button>` : ''}
  </div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ task rows & board cards
function taskRow(t, { showClient = true, board = false } = {}) {
  const done = t.status === 'done';
  const mine = isAdmin() || t.assignees.some((a) => a.id === S.user.id);
  const d = t.deadline && !done ? dueInfo(t.deadline) : null;
  const checkCls = done ? 'on' : t.status === 'in_progress' ? 'prog' : '';
  const meta = [
    t.team_name ? `<span class="team-tag" style="--c:${esc(t.team_color || '#4f46e5')}">${esc(t.team_name)}</span>` : '',
    showClient && t.client_name ? `<span class="client">${logo(taskClient(t), 'xs')}${esc(t.client_name)}</span>` : '',
    !board && t.status === 'in_progress' ? '<span class="blue">● In progress</span>' : '',
    d ? `<span class="${d.cls}">${ic('clock')}${d.text}</span>` : '',
    done && t.completed_at ? `<span class="green">${ic('check')}${esc(t.completed_by_name || '—')} · ${fmtShort(t.completed_at)}</span>` : '',
    t.priority === 'urgent' ? `<span class="red">${ic('flag')}Urgent</span>` : t.priority === 'high' ? `<span class="amber">${ic('flag')}High</span>` : '',
    t.material_count ? `<span>${ic('clip')}${t.material_count}</span>` : '',
    !done && t.progress !== null && t.progress !== undefined ? `<span class="blue">${ic('pulse')}${t.progress}%</span>` : '',
    t.source === 'self' ? '<span class="badge-self">Self-added</span>' : '',
  ].filter(Boolean).join('');
  return `<div class="task ${done ? 'done' : `prio-${t.priority}`}" data-act="openTask" data-id="${t.id}" role="button" tabindex="0"
      ${board && mine ? `draggable="true" data-status="${t.status}"` : ''}>
    ${mine && !done
    ? `<button type="button" class="check ${checkCls}" data-act="quickDone" data-id="${t.id}" title="Mark as done" aria-label="Mark as done">${ic('check')}</button>`
    : `<span class="check ${checkCls}">${ic('check')}</span>`}
    <div class="task-main">
      <div class="task-title">${esc(t.title)}</div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${!done && t.last_update ? `<div class="last-update">${ic('msg')}<span class="ellipsis">${esc(t.last_update.text)}</span><span class="faint nowrap">· ${esc((t.last_update.user_name || '').split(' ')[0])} · ${timeAgo(t.last_update.created_at)}</span></div>` : ''}
    </div>
    <div class="task-side"><div class="avatars">${t.assignees.slice(0, 3).map((a) => avatar(a, 'xs')).join('')}${t.assignees.length > 3 ? `<span class="avatar xs" style="--c:#94a3b8">+${t.assignees.length - 3}</span>` : ''}</div></div>
  </div>`;
}
const taskList = (tasks, opts) => `<div class="task-list">${tasks.map((t) => taskRow(t, opts)).join('')}</div>`;
function taskBoard(tasks) {
  const cols = [['todo', 'To do', 'var(--faint)'], ['in_progress', 'In progress', 'var(--blue)'], ['done', 'Done', 'var(--green)']];
  return `<div class="board">${cols.map(([k, label, color]) => {
    let list = tasks.filter((t) => t.status === k);
    const total = list.length;
    if (k === 'done') list = list.slice(0, 30);
    return `<div class="col" data-col="${k}">
      <div class="col-head"><span class="dot" style="color:${color}"></span>${label}<span class="n">${total}</span></div>
      <div class="col-body">${list.map((t) => taskRow(t, { board: true })).join('') || `<div class="col-empty">${k === 'done' ? 'Drop here to finish' : 'No tasks'}</div>`}
        ${total > list.length ? `<div class="col-empty">+ ${total - list.length} older</div>` : ''}</div></div>`;
  }).join('')}</div>`;
}
const layoutToggle = () => `<div class="seg hide-mobile">
  <button class="${S.ui.layout === 'list' ? 'on' : ''}" data-act="setLayout" data-v="list">${ic('list')}List</button>
  <button class="${S.ui.layout === 'board' ? 'on' : ''}" data-act="setLayout" data-v="board">${ic('board')}Board</button></div>`;
const useBoard = () => S.ui.layout === 'board' && !isMobile();

function notifBanner() {
  if (!('Notification' in window) || Notification.permission !== 'default') return '';
  const why = isAdmin() ? 'Get an alert the moment an employee finishes a task.' : 'Get an alert as soon as a task is assigned to you.';
  return `<div class="banner"><div class="ico">${ic('bell')}</div><div class="grow"><b>Turn on notifications</b><div class="small muted">${why}</div></div>
    <button class="btn primary sm" data-act="enablePush">Turn on</button></div>`;
}

// ------------------------------------------------------------------ views
const VIEWS = {};

VIEWS.home = {
  admin: true, title: () => 'Overview',
  sub: () => new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  action: { label: 'New task', act: 'newTask' },
  load: () => api('GET', '/api/overview'),
  html(o) {
    const c = o.counts;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const stat = (label, n, tone, icon, status) => `<button class="stat ${tone}" data-act="statGo" data-status="${status}">
      <div class="ico">${ic(icon)}</div><div><b>${n || 0}</b><span>${label}</span></div></button>`;
    const maxOpen = Math.max(1, ...o.team.map((u) => u.open));
    const soon = o.due_soon.length + o.client_deadlines.length;
    return `${notifBanner()}${o.finance ? financeBanner(o.finance) : ''}
      <div class="hero"><div><h2>${greet}, ${esc(S.user.name.split(' ')[0])} 👋</h2>
        <div class="muted" style="margin-top:4px">${c.overdue ? `<b style="color:var(--red)">${plural(c.overdue, 'task')} overdue</b> · ` : ''}${plural((c.todo || 0) + (c.in_progress || 0), 'open task')} across ${plural(c.clients || 0, 'client')}</div></div>
        <button class="btn hide-mobile" data-act="newClient">${ic('plus')} New client</button></div>
      <div class="stats">
        ${stat('To do', c.todo, '', 'inbox', 'open')}${stat('In progress', c.in_progress, 'tone-blue', 'play', 'in_progress')}
        ${stat('Overdue', c.overdue, 'tone-red', 'alert', 'overdue')}${stat('Done today', c.done_today, 'tone-green', 'check', 'done')}
        <button class="stat tone-amber" data-act="nav" data-to="clients"><div class="ico">${ic('briefcase')}</div><div><b>${c.clients || 0}</b><span>Clients</span></div></button>
      </div>
      <div class="cols">
        <div>
          <div class="section"><div class="section-head"><h2 class="grow">Due soon</h2><span class="small muted">next 3 days</span></div>
            ${soon ? `${taskList(o.due_soon)}
              ${o.client_deadlines.length ? `<div class="card list" style="margin-top:8px">${o.client_deadlines.map((d) => `
                <div class="list-item click" data-act="nav" data-to="clients/${d.client_id}">
                  ${logo({ name: d.client_name, color: d.client_color, logo_key: d.client_logo }, 'sm')}
                  <div class="grow"><div class="strong ellipsis">${esc(d.title)}</div><div class="small muted">${esc(d.client_name)} · client deadline</div></div>
                  <span class="chip ${dueInfo(d.due_at).cls}">${dueInfo(d.due_at).text}</span></div>`).join('')}</div>` : ''}`
    : `<div class="card">${empty('calendar', 'Nothing due soon', 'Upcoming deadlines will show here.')}</div>`}</div>
          <div class="section"><div class="section-head"><h2 class="grow">Recently completed</h2><button class="btn ghost sm" data-act="statGo" data-status="done">View all ${ic('arrow')}</button></div>
            ${o.recent_done.length ? taskList(o.recent_done) : `<div class="card">${empty('tasks', 'No finished tasks yet', 'When your team marks tasks as done, they appear here.')}</div>`}</div>
        </div>
        <div>
        <div class="section"><div class="section-head"><h2 class="grow">Latest updates</h2><button class="btn ghost sm" data-act="nav" data-to="updates">All updates ${ic('arrow')}</button></div>
          <div class="card">${o.latest_updates.length ? `<div class="feed">${o.latest_updates.map(updateItem).join('')}</div>`
    : empty('pulse', 'No updates yet', 'Employees post progress like “Figma file done”. You get them together every hour.')}</div></div>
        <div class="section"><div class="section-head"><h2 class="grow">Team workload</h2><button class="btn ghost sm" data-act="nav" data-to="team">Manage</button></div>
          <div class="card">${o.team.length ? `<div class="workload" style="padding-top:18px">${o.team.map((u) => `
            <div class="row click" data-act="viewUserTasks" data-id="${u.id}" style="cursor:pointer">${avatar(u)}
              <div class="grow"><div class="row between"><b class="ellipsis">${esc(u.name)}</b><span class="small muted nowrap">${u.open} open${u.overdue ? ` · <span style="color:var(--red)">${u.overdue} late</span>` : ''}</span></div>
                <div class="bar"><i style="width:${Math.round((u.open / maxOpen) * 100)}%"></i></div>
                <div class="tiny faint" style="margin-top:4px">${u.done_week} done this week</div></div></div>`).join('')}</div>`
    : empty('users', 'No employees yet', 'Add your team to start assigning work.', `<button class="btn primary" data-act="newUser">${ic('plus')} Add employee</button>`)}</div></div>
        </div>
      </div>`;
  },
};

VIEWS.clients = {
  title: () => 'Clients', sub: (list) => plural(list.length, 'client'),
  action: () => (isAdmin() ? { label: 'New client', act: 'newClient' } : null),
  load: () => api('GET', '/api/clients'),
  html(list) {
    const q = S.ui.clientSearch.toLowerCase();
    const shown = list.filter((c) => !q || [c.name, c.contact_person, c.email].some((v) => (v || '').toLowerCase().includes(q)));
    const card = (c) => {
      const total = c.open_tasks + c.done_tasks;
      const pct = total ? Math.round((c.done_tasks / total) * 100) : 0;
      return `<button class="client-card" style="--c:${esc(c.color)}" data-act="nav" data-to="clients/${c.id}">
        <div class="top">${logo(c)}<div class="grow"><h3 class="ellipsis">${esc(c.name)}</h3>
          <div class="muted small ellipsis">${esc(c.contact_person || c.email || c.phone || 'No contact added')}</div></div></div>
        <div class="body">
          <div class="row between small" style="margin-bottom:6px"><span class="muted">${total ? `${c.done_tasks} of ${total} tasks done` : 'No tasks yet'}</span><b class="num">${total ? `${pct}%` : ''}</b></div>
          <div class="progress"><i style="width:${pct}%"></i></div>
          <div class="chips" style="margin-top:12px">
            <span class="chip ${c.open_tasks ? 'blue' : ''}">${c.open_tasks} open</span>
            ${c.overdue_tasks ? `<span class="chip red">${c.overdue_tasks} overdue</span>` : ''}
            ${c.material_count ? `<span class="chip">${ic('clip')}${c.material_count} files</span>` : ''}
          </div>
        </div>
        <div class="foot">${ic('calendar')}${c.next_deadline
    ? `<span>Next deadline <b style="color:${new Date(c.next_deadline) < new Date() ? 'var(--red)' : 'var(--text-2)'}">${fmtShort(c.next_deadline)}</b></span>`
    : '<span>No upcoming deadlines</span>'}</div>
      </button>`;
    };
    return `<div class="toolbar">
        <div class="search">${ic('search')}<input class="input" data-keep="client-search" data-on-input="clientSearch" placeholder="Search clients…" value="${esc(S.ui.clientSearch)}"></div>
      </div>
      ${!list.length ? `<div class="card">${empty('briefcase', 'No clients yet', isAdmin() ? 'Add your first client to start organising work.' : 'Your admin hasn’t added clients yet.',
    isAdmin() ? `<button class="btn primary" data-act="newClient">${ic('plus')} Add client</button>` : '')}</div>`
    : !shown.length ? `<div class="card">${empty('search', 'No matches', 'Try a different name.')}</div>`
      : `<div class="client-grid">${shown.map(card).join('')}
          ${isAdmin() && !q ? `<button class="add-card" data-act="newClient"><div class="ico">${ic('plus')}</div>Add client</button>` : ''}</div>`}`;
  },
};

VIEWS.client = {
  back: 'clients', title: (c) => c.name, sub: () => 'Client',
  action: (c) => ({ label: c?.can_edit ? 'New task' : 'Add to my tasks', act: 'newTaskForClient' }),
  load: (r) => api('GET', `/api/clients/${r.id}`),
  html(c) {
    const admin = c.can_edit;
    const open = c.tasks.filter((t) => t.status !== 'done'), done = c.tasks.filter((t) => t.status === 'done');
    const overdue = open.filter(isOverdue).length;
    if (S.ui.clientTab === 'finance' && !c.finance) S.ui.clientTab = 'tasks';
    const tab = S.ui.clientTab;
    const tabBtn = (k, label, n) => `<button class="${tab === k ? 'on' : ''}" data-act="clientTab" data-tab="${k}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
    let body = '';
    if (tab === 'tasks') {
      body = `${open.length ? taskList(open, { showClient: false }) : `<div class="card">${empty('tasks', 'No open tasks', 'Everything for this client is done.', `<button class="btn primary" data-act="newTaskForClient">${ic('plus')} ${admin ? 'New task' : 'Add to my tasks'}</button>`)}</div>`}
        ${done.length ? `<div class="sub-head">Completed · ${done.length}</div>${taskList(done, { showClient: false })}` : ''}`;
    } else if (tab === 'deadlines') {
      body = `${admin ? `<form class="card pad" data-submit="addDeadline" data-id="${c.id}" style="margin-bottom:14px;padding:14px">
          <div class="row wrap"><input class="input grow" name="title" data-keep="dl-title" placeholder="Deadline, e.g. Website launch" required style="min-width:180px">
            <input class="input" type="datetime-local" name="due_at" data-keep="dl-date" required style="width:auto">
            <button class="btn primary">${ic('plus')} Add</button></div></form>` : ''}
        ${c.deadlines.length ? `<div class="card list">${c.deadlines.map((d) => `
          <div class="list-item deadline-item ${d.done ? 'done' : ''}">
            ${admin ? `<button class="check ${d.done ? 'on' : ''}" data-act="toggleDeadline" data-id="${d.id}" data-done="${d.done ? 0 : 1}" aria-label="Toggle done">${ic('check')}</button>` : `<span class="check ${d.done ? 'on' : ''}">${ic('check')}</span>`}
            <div class="grow"><b>${esc(d.title)}</b><div class="small muted">${fmtFull(d.due_at)}</div></div>
            ${d.done ? '<span class="chip green">Done</span>' : `<span class="chip ${dueInfo(d.due_at).cls}">${dueInfo(d.due_at).text}</span>`}
            ${admin ? `<button class="icon-btn sm" data-act="delDeadline" data-id="${d.id}" aria-label="Delete">${ic('trash')}</button>` : ''}
          </div>`).join('')}</div>` : `<div class="card">${empty('calendar', 'No deadlines yet', 'Add milestones like launches, reviews or delivery dates.')}</div>`}`;
    } else if (tab === 'finance') {
      body = clientFinanceTab(c);
    } else if (tab === 'materials') {
      body = `${admin ? `<div class="row" style="margin-bottom:12px"><button class="btn primary sm" data-act="addClientMaterial" data-id="${c.id}">${ic('upload')} Add files or links</button></div>` : ''}
        ${c.materials.length ? materialList(c.materials) : `<div class="card">${empty('clip', 'No materials yet', 'Brand files, briefs, drive folders, logins docs…')}</div>`}`;
    } else {
      body = `<div class="card pad"><dl class="props">
          <dt>${ic('user')}Contact</dt><dd>${esc(c.contact_person || '—')}</dd>
          <dt>${ic('mail')}Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd>
          <dt>${ic('phone')}Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</dd>
          <dt>${ic('calendar')}Added</dt><dd>${fmtFull(c.created_at)}</dd></dl>
          <div class="sub-head">Details</div><div class="desc">${c.details ? linkify(c.details) : '<span class="muted">No details added</span>'}</div></div>`;
    }
    return `<div class="card client-hero" style="--c:${esc(c.color)}">
        <div class="banner"></div>
        <div class="inner">
          <div class="logo-wrap">${logo(c, 'lg')}${admin ? `<label class="logo-edit" title="Change logo">${ic('image')}<input type="file" accept="image/*" hidden data-logo-file data-id="${c.id}"></label>` : ''}</div>
          <div class="info"><h2>${esc(c.name)}</h2>
            <div class="contact-line">
              ${c.contact_person ? `<span>${ic('user')}${esc(c.contact_person)}</span>` : ''}
              ${c.email ? `<a href="mailto:${esc(c.email)}">${ic('mail')}${esc(c.email)}</a>` : ''}
              ${c.phone ? `<a href="tel:${esc(c.phone)}">${ic('phone')}${esc(c.phone)}</a>` : ''}
            </div></div>
          ${admin ? `<div class="row"><button class="btn sm" data-act="editClient">${ic('edit')} Edit</button>
            <button class="icon-btn sm" data-act="delClient" data-id="${c.id}" aria-label="Delete client" title="Delete client">${ic('trash')}</button></div>` : ''}
        </div>
        <div class="hero-stats">
          <div><b>${open.length}</b>Open</div><div><b style="color:${overdue ? 'var(--red)' : ''}">${overdue}</b>Overdue</div>
          <div><b>${done.length}</b>Done</div><div><b>${c.deadlines.filter((d) => !d.done).length}</b>Deadlines</div><div><b>${c.materials.length}</b>Files</div>
        </div>
      </div>
      <div class="tabs" style="margin-top:20px">
        ${tabBtn('tasks', 'Tasks', open.length)}${tabBtn('deadlines', 'Deadlines', c.deadlines.filter((d) => !d.done).length)}
        ${tabBtn('materials', 'Materials & links', c.materials.length)}${c.finance ? tabBtn('finance', 'Finance') : ''}${tabBtn('info', 'Info')}
      </div>
      ${body}`;
  },
};

VIEWS.tasks = {
  title: () => (isAdmin() ? 'Tasks' : 'My tasks'),
  sub: (d) => (isAdmin() ? `${plural(d.tasks.filter((t) => t.status !== 'done').length, 'open task')} · whole team` : `${plural(d.tasks.filter((t) => t.status !== 'done').length, 'open task')}`),
  action: () => ({ label: isAdmin() ? 'New task' : 'Add task', act: 'newTask' }),
  async load() {
    if (!isAdmin()) return { tasks: await api('GET', '/api/tasks') };
    const [tasks, users, clients] = await Promise.all([api('GET', '/api/tasks?limit=1000'), api('GET', '/api/users'), api('GET', '/api/clients')]);
    return { tasks, users, clients };
  },
  html(d) { return isAdmin() ? adminTasksHtml(d) : myTasksHtml(d); },
};
function searchTasks(tasks) {
  const q = S.ui.taskSearch.toLowerCase();
  return q ? tasks.filter((t) => [t.title, t.client_name, t.description, ...t.assignees.map((a) => a.name)].some((v) => (v || '').toLowerCase().includes(q))) : tasks;
}
const taskSearchBox = () => `<div class="search">${ic('search')}<input class="input" data-keep="task-search" data-on-input="taskSearch" placeholder="Search tasks…" value="${esc(S.ui.taskSearch)}"></div>`;
function myTasksHtml({ tasks }) {
  const list = searchTasks(tasks);
  const by = { todo: list.filter((t) => t.status === 'todo'), in_progress: list.filter((t) => t.status === 'in_progress'), done: list.filter((t) => t.status === 'done') };
  // Until the user picks a tab, open the first one that has something in it.
  if (!S.ui.myStatusPicked && !by[S.ui.myStatus].length) S.ui.myStatus = ['in_progress', 'todo', 'done'].find((k) => by[k].length) || 'todo';
  const st = S.ui.myStatus;
  const overdue = tasks.filter(isOverdue).length;
  const stale = tasks.filter((t) => t.status === 'in_progress' && (!t.last_update || Date.now() - new Date(t.last_update.created_at) > 60 * 60000));
  const head = `${notifBanner()}
    ${stale.length ? `<div class="banner"><div class="ico">${ic('pulse')}</div><div class="grow"><b>Hourly update due on ${plural(stale.length, 'task')}</b><div class="small muted">Tell your admin what you finished, e.g. “Figma file done”.</div></div>
      <button class="btn primary sm" data-act="openTask" data-id="${stale[0].id}">Post update</button></div>` : ''}
    ${overdue ? `<div class="banner red"><div class="ico">${ic('alert')}</div><div class="grow"><b>${plural(overdue, 'task')} overdue</b><div class="small muted">Finish ${overdue > 1 ? 'them' : 'it'} or tell your admin.</div></div></div>` : ''}`;
  if (useBoard()) {
    return `${head}<div class="toolbar">${taskSearchBox()}<span class="grow"></span>${layoutToggle()}</div>${taskBoard(list)}`;
  }
  const shown = by[st];
  return `${head}
    <div class="tabs">${Object.keys(by).map((k) => `<button class="${st === k ? 'on' : ''}" data-act="myStatus" data-status="${k}">${STATUS[k]}<span class="n">${by[k].length}</span></button>`).join('')}</div>
    <div class="toolbar">${taskSearchBox()}<span class="grow"></span>${layoutToggle()}</div>
    ${shown.length ? taskList(shown) : `<div class="card">${empty(st === 'done' ? 'tasks' : 'inbox',
    st === 'done' ? 'No finished tasks yet' : st === 'in_progress' ? 'Nothing in progress' : 'You’re all caught up 🎉',
    st === 'in_progress' ? 'Open a task and tap “Start working”.' : st === 'todo' ? 'New tasks from your admin will appear here instantly.' : '',
    st === 'todo' ? `<button class="btn" data-act="newTask">${ic('plus')} Add a task to my list</button>` : '')}</div>`}`;
}
function adminTasksHtml({ tasks, users, clients }) {
  const u = S.ui;
  let list = searchTasks(tasks);
  if (u.assignee) list = list.filter((t) => t.assignees.some((a) => String(a.id) === u.assignee));
  if (u.client) list = list.filter((t) => String(t.client_id || '') === (u.client === 'none' ? '' : u.client));
  if (u.source) list = list.filter((t) => t.source === u.source);
  const groups = {
    open: list.filter((t) => t.status !== 'done'), in_progress: list.filter((t) => t.status === 'in_progress'),
    overdue: list.filter(isOverdue), done: list.filter((t) => t.status === 'done'), all: list,
  };
  const labels = { open: 'Open', in_progress: 'In progress', overdue: 'Overdue', done: 'Done', all: 'All' };
  const sel = (k, opts, allLabel) => `<select class="input" data-on-change="filter" data-k="${k}">
    <option value="">${allLabel}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(u[k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const filtered = u.assignee || u.client || u.source || u.taskSearch;
  const filters = `<div class="toolbar">
      ${taskSearchBox()}
      ${sel('assignee', users.map((x) => [x.id, x.name]), 'Everyone')}
      ${sel('client', [['none', 'No client'], ...clients.map((x) => [x.id, x.name])], 'All clients')}
      ${sel('source', [['admin', 'Assigned by admin'], ['self', 'Self-added']], 'All types')}
      ${filtered ? '<button class="btn ghost sm" data-act="clearFilters">Clear</button>' : ''}
      <span class="grow hide-mobile"></span>${layoutToggle()}
    </div>`;
  if (!tasks.length) return `<div class="card">${empty('tasks', 'No tasks yet', 'Create a task and assign it to your team.', `<button class="btn primary" data-act="newTask">${ic('plus')} New task</button>`)}</div>`;
  if (useBoard()) return `${filters}${taskBoard(list)}`;
  const shown = groups[u.adminStatus] || groups.open;
  return `<div class="tabs">${Object.keys(groups).map((k) => `<button class="${u.adminStatus === k ? 'on' : ''}" data-act="adminStatus" data-status="${k}">${labels[k]}<span class="n">${groups[k].length}</span></button>`).join('')}</div>
    ${filters}
    ${shown.length ? taskList(shown) : `<div class="card">${empty('search', 'No tasks here', 'Try another tab or clear the filters.')}</div>`}`;
}

function updateItem(u) {
  return `<div class="feed-item">
    ${avatar({ id: u.user_id, name: u.user_name || '?' }, 'xs')}
    <div class="grow">
      <div class="small"><b>${esc(u.user_name || 'Someone')}</b> <span class="faint">· ${timeAgo(u.created_at)}</span></div>
      <div class="feed-text">${esc(u.text)}${u.progress !== null && u.progress !== undefined ? ` <span class="chip blue">${u.progress}%</span>` : ''}</div>
      <button class="feed-task" data-act="openTask" data-id="${u.task_id}">${u.client_name ? logo({ name: u.client_name, color: u.client_color, logo_key: u.client_logo }, 'xs') : ''}${esc(u.task_title)}</button>
    </div></div>`;
}
VIEWS.updates = {
  admin: true, title: () => 'Progress updates', sub: () => `Sent to you together every hour (${schedule.start}:00–${schedule.end}:00)`,
  action: { label: 'Send digest now', act: 'sendDigest', plain: true },
  async load() {
    const [list, sch] = await Promise.all([api('GET', '/api/updates?days=7'), api('GET', '/api/updates/schedule')]);
    schedule = sch;
    return list;
  },
  html(list) {
    if (!list.length) return `<div class="card">${empty('pulse', 'No updates in the last 7 days', 'When employees post progress on a task it shows up here, and you get one combined notification each hour.')}</div>`;
    const groups = [];
    for (const u of list) {
      const d = new Date(u.created_at);
      const key = `${d.toDateString()} ${d.getHours()}`;
      if (!groups.length || groups[groups.length - 1].key !== key) {
        const day = sameDay(d, new Date()) ? 'Today' : sameDay(d, new Date(Date.now() - 86400000)) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        const h = new Date(d); h.setMinutes(0, 0, 0);
        groups.push({ key, label: `${day} · ${fmtTime(h)} – ${fmtTime(new Date(+h + 3600000))}`, items: [] });
      }
      groups[groups.length - 1].items.push(u);
    }
    return `<div class="banner"><div class="ico">${ic('clock')}</div><div class="grow small">Next combined update: <b>${fmtTime(schedule.next)}</b>. Employees with tasks in progress are reminded every hour to post what they finished.</div></div>
      ${groups.map((g) => `<div class="sub-head">${g.label} · ${plural(g.items.length, 'update')}</div><div class="card"><div class="feed">${g.items.map(updateItem).join('')}</div></div>`).join('')}`;
  },
};
let schedule = { start: 9, end: 20, next: new Date().toISOString() };

VIEWS.boards = {
  title: () => 'Team boards', sub: (d) => { const x = d.visible.find((v) => v.id === d.current); return x ? `${x.name}: ${plural(x.members.length, 'person')} sharing these tasks` : ''; },
  action: (d) => (isAdmin() && d?.current ? { label: 'New task', act: 'newTeamTask' } : null),
  async load() {
    const [teams, tasks] = await Promise.all([api('GET', '/api/teams'), api('GET', `/api/tasks${isAdmin() ? '?limit=1000' : ''}`)]);
    const visible = isAdmin() ? teams : teams.filter((x) => x.members.some((u) => u.id === S.user.id));
    const current = visible.some((x) => x.id === S.ui.boardTeam) ? S.ui.boardTeam : visible[0]?.id || null;
    return { teams, visible, current, allTasks: tasks };
  },
  html(d) {
    d.current = d.visible.some((x) => x.id === S.ui.boardTeam) ? S.ui.boardTeam : d.visible[0]?.id || null;
    if (!d.visible.length) return `<div class="card">${empty('board', 'You’re not in a team yet', isAdmin() ? 'Create teams on the Team page.' : 'Ask your admin to add you to a team.', isAdmin() ? '<button class="btn primary" data-act="nav" data-to="team">Open Team</button>' : '')}</div>`;
    d.tasks = d.allTasks.filter((t) => t.team_id === d.current); // the drag & drop code reads data.tasks
    const team = d.visible.find((x) => x.id === d.current);
    const open = d.tasks.filter((t) => t.status !== 'done'), done = d.tasks.filter((t) => t.status === 'done');
    return `<div class="tabs">${d.visible.map((x) => `<button class="${x.id === d.current ? 'on' : ''}" data-act="boardTeam" data-id="${x.id}">${esc(x.name)}<span class="n">${x.open_tasks}</span></button>`).join('')}</div>
      <div class="row wrap" style="margin-bottom:14px"><div class="avatars">${team.members.slice(0, 8).map((u) => avatar(u, 'xs')).join('')}</div>
        <span class="small muted">${esc(team.members.map((u) => firstName(u.name)).join(', ')) || 'No members yet'}</span></div>
      ${!d.tasks.length ? `<div class="card">${empty('inbox', `No ${esc(team.name)} tasks yet`, 'Tasks for this team show up here for everyone in it.')}</div>`
    : isMobile() ? `${open.length ? taskList(open) : ''}${done.length ? `<div class="sub-head">Done · ${done.length}</div>${taskList(done.slice(0, 30))}` : ''}` : taskBoard(d.tasks)}`;
  },
};
const firstName = (n) => String(n || '').split(' ')[0];
function teamsSection(teams) {
  return `<div class="section"><div class="section-head"><h2 class="grow">Teams</h2><button class="btn sm" data-act="newTeam">${ic('plus')} New team</button></div>
    ${teams.length ? `<div class="card list">${teams.map((x) => `<div class="list-item">
      <span class="team-dot" style="--c:${esc(x.color || '#4f46e5')}"></span>
      <div class="grow"><b>${esc(x.name)}</b><div class="small muted ellipsis">${x.members.length ? esc(x.members.map((u) => firstName(u.name)).join(', ')) : 'No members yet: its tasks can’t be assigned'} · ${plural(x.open_tasks, 'open task')}</div></div>
      <button class="btn sm" data-act="editTeam" data-id="${x.id}">${ic('edit')} Edit</button></div>`).join('')}</div>` : `<div class="card">${empty('board', 'No teams', 'Add Designing, Coding, Marketing… to share tasks.')}</div>`}</div>`;
}
function openTeamForm(team, users) {
  const members = new Set((team?.members || []).map((u) => u.id));
  openModal({
    title: team ? `Edit ${team.name}` : 'New team', form: 'team', sticky: true, data: { team, selected: members },
    body: `<label class="field"><span>Team name <span class="req">*</span></span><input class="input" name="name" required value="${esc(team?.name || '')}" placeholder="e.g. Designing"></label>
      <div class="field"><span>Members</span><div class="people">${users.map((u) => `<button type="button" class="person ${members.has(u.id) ? 'on' : ''}" data-act="togglePersonTeam" data-id="${u.id}">${avatar(u)}${esc(u.name)}</button>`).join('')}</div></div>
      <label class="field"><span>WhatsApp bot keywords <span class="faint">(comma separated)</span></span><textarea class="input" name="keywords" placeholder="design, logo, banner, poster">${esc(team?.keywords || '')}</textarea>
        <span class="tiny muted" style="font-weight:400">A WhatsApp message with these words goes to this team automatically.</span></label>`,
    foot: `${team ? `<button type="button" class="btn ghost danger" data-act="delTeam" style="margin-right:auto">${ic('trash')} Delete</button>` : ''}<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">Save</button>`,
  });
}

VIEWS.team = {
  admin: true, title: () => 'Team', sub: (d) => plural(d.users.length, 'person'),
  action: { label: 'Add employee', act: 'newUser' },
  async load() { const [users, requests, teams] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/password/requests'), api('GET', '/api/teams')]); return { users, requests, teams }; },
  html({ users, requests, teams }) {
    const canReset = (x) => x.id !== S.user.id && (!x.is_owner || isOwner());
    return `${requests.length ? `<div class="banner" style="background:var(--amber-soft);border-color:transparent"><div class="ico" style="color:var(--amber)">${ic('key')}</div>
        <div class="grow"><b>${plural(requests.length, 'person')} forgot ${requests.length > 1 ? 'their passwords' : 'their password'}</b>
          <div class="chips" style="margin-top:8px">${requests.map((r) => `<button class="btn sm" data-act="tempPassword" data-id="${r.user_id}" data-name="${esc(r.name)}">${ic('key')} Reset for ${esc(r.name)}</button>`).join('')}</div></div></div>` : ''}
      <div class="card list">${users.map((x) => `
        <div class="list-item">
          ${avatar(x)}
          <div class="grow"><div class="row" style="gap:8px"><b class="ellipsis">${esc(x.name)}</b>${x.role === 'superadmin' ? `<span class="chip ${x.is_owner ? 'amber' : 'indigo'}">${roleLabel(x)}</span>` : ''}${x.id === S.user.id ? '<span class="chip">You</span>' : ''}</div>
            <div class="meta" style="margin-top:2px"><span>@${esc(x.username)}</span>${x.phone ? `<span>${ic('phone')}+${esc(x.phone)}</span>` : ''}${x.email ? `<span>${ic('mail')}${esc(x.email)}</span>` : ''}<span class="blue">${x.open} open</span>${x.overdue ? `<span class="red">${x.overdue} overdue</span>` : ''}<span class="green">${x.done} done</span></div></div>
          <button class="btn sm hide-mobile" data-act="viewUserTasks" data-id="${x.id}">View tasks</button>
          <button class="icon-btn sm hide-desktop" data-act="viewUserTasks" data-id="${x.id}" aria-label="View tasks">${ic('tasks')}</button>
          ${canReset(x) ? `<button class="icon-btn sm" data-act="tempPassword" data-id="${x.id}" data-name="${esc(x.name)}" aria-label="Reset password" title="Reset password">${ic('key')}</button>` : ''}
          <button class="icon-btn sm" data-act="editUser" data-id="${x.id}" aria-label="Edit">${ic('edit')}</button>
          ${x.id !== S.user.id ? `<button class="icon-btn sm" data-act="delUser" data-id="${x.id}" data-name="${esc(x.name)}" aria-label="Delete">${ic('trash')}</button>` : ''}
        </div>`).join('')}</div>${teamsSection(teams)}`;
  },
};

const NOTIF_ICON = { completed: ['check', 'var(--green)', 'var(--green-soft)'], assigned: ['briefcase', 'var(--primary-text)', 'var(--primary-soft)'], self_added: ['plus', 'var(--blue)', 'var(--blue-soft)'], updated: ['edit', 'var(--amber)', 'var(--amber-soft)'], reopened: ['undo', 'var(--amber)', 'var(--amber-soft)'], digest: ['pulse', 'var(--blue)', 'var(--blue-soft)'], reminder: ['clock', 'var(--amber)', 'var(--amber-soft)'], payment: ['check', 'var(--green)', 'var(--green-soft)'], finance: ['inbox', 'var(--red)', 'var(--red-soft)'], reset_request: ['key', 'var(--amber)', 'var(--amber-soft)'], bot: ['msg', 'var(--green)', 'var(--green-soft)'] };
VIEWS.notifications = {
  title: () => 'Notifications', sub: (list) => `${list.filter((n) => !n.is_read).length} unread`,
  action: (list) => (list?.some((n) => !n.is_read) ? { label: 'Mark all read', act: 'readAll', plain: true } : null),
  load: () => api('GET', '/api/notifications'),
  html(list) {
    return `${notifBanner()}
      ${list.length ? `<div class="card list">${list.map((n) => {
    const [icon, fg, bg] = NOTIF_ICON[n.type] || ['bell', 'var(--primary-text)', 'var(--primary-soft)'];
    return `<div class="list-item click ${n.is_read ? '' : 'unread'}" data-act="openNotif" data-id="${n.id}" data-task="${n.task_id || ''}" data-type="${n.type}">
          <div class="mat-icon" style="color:${fg};background:${bg}">${ic(icon)}</div>
          <div class="grow"><div class="strong">${esc(n.title)}</div><div class="small muted">${esc(n.body)}</div></div>
          <span class="small faint nowrap">${timeAgo(n.created_at)}</span></div>`;
  }).join('')}</div>` : `<div class="card">${empty('bell', 'No notifications yet', 'You’ll see assignments and completed tasks here.')}</div>`}`;
  },
};

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
VIEWS.settings = {
  title: () => 'Settings', sub: () => 'Your account and app',
  load: () => Promise.resolve({}),
  html() {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const theme = store.get('dq_theme') || 'light';
    let install;
    if (standalone()) install = `<span class="chip green">${ic('check')}Installed</span>`;
    else if (S.installEvt) install = `<button class="btn primary sm" data-act="install">${ic('download')} Install app</button>`;
    else if (isIOS()) install = '<div class="small muted">In <b>Safari</b>: tap <b>Share</b> → <b>Add to Home Screen</b>.</div>';
    else install = '<div class="small muted">Browser menu <b>⋮</b> → <b>Install app</b> (PC) or <b>Add to Home screen</b> (phone).</div>';
    const card = (icon, title, text, right) => `<div class="card pad setting"><div class="mat-icon">${ic(icon)}</div>
      <div class="grow"><b>${title}</b><div class="small muted" style="margin:2px 0 10px">${text}</div>${right}</div></div>`;
    return `<div class="card pad row" style="gap:16px">${avatar(S.user, 'lg')}<div class="grow"><h2 style="font-size:20px">${esc(S.user.name)}</h2>
        <div class="muted">@${esc(S.user.username)} · ${roleLabel(S.user)}</div></div>
        <button class="btn danger hide-mobile" data-act="logout">${ic('logout')} Log out</button></div>
      <div class="settings-grid section">
        ${card('sun', 'Appearance', 'Choose how the app looks on this device.', `<div class="seg">
          ${[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['auto', 'Auto', 'auto']].map(([k, l, i]) => `<button class="${theme === k ? 'on' : ''}" data-act="theme" data-v="${k}">${ic(i)}${l}</button>`).join('')}</div>`)}
        ${card('monitor', 'Install the app', 'Own icon and window on PC and phone. Updates itself.', install)}
        ${card('bell', 'Notifications', perm === 'granted' ? (S.pushOn ? 'On — alerts arrive even when the app is closed.' : 'On — alerts show while the app is open.')
    : perm === 'denied' ? 'Blocked. Allow notifications for this site in your browser or phone settings.'
      : perm === 'unsupported' ? 'Not supported here. On iPhone, install the app to the Home Screen first.' : 'Get alerts for new and finished tasks.',
  perm === 'default' ? '<button class="btn primary sm" data-act="enablePush">Turn on</button>' : perm === 'granted' ? '<button class="btn sm" data-act="testNotif">Send a test</button>' : '')}
        <form class="card pad setting" data-submit="myPhone"><div class="mat-icon">${ic('phone')}</div><div class="grow"><b>WhatsApp number</b>
          <div class="small muted" style="margin:2px 0 10px">So the WhatsApp bot knows it’s you${isOwner() ? ' and can ask you who should do new tasks' : ' and can confirm your finished tasks'}. Include the country code.</div>
          <div class="row"><input class="input" name="phone" type="tel" inputmode="tel" value="${esc(S.user.phone || '')}" placeholder="91 98765 43210"><button class="btn sm">Save</button></div></div></form>
        <form class="card pad setting" data-submit="myEmail"><div class="mat-icon">${ic('mail')}</div><div class="grow"><b>Recovery email</b>
          <div class="small muted" style="margin:2px 0 10px">${S.emailReset ? 'If you forget your password, a reset link goes here.' : 'Saved for password resets. Email links start working once your admin connects an email service — until then, “Forgot password” asks your admin.'}</div>
          <div class="row"><input class="input" name="email" type="email" value="${esc(S.user.email || '')}" placeholder="you@company.com"><button class="btn sm">Save</button></div></div></form>
        <form class="card pad setting" data-submit="password"><div class="mat-icon">${ic('lock')}</div><div class="grow"><b>Change password</b>
          <div class="grid2" style="margin-top:10px"><label class="field" style="margin-bottom:10px"><span>Current</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field" style="margin-bottom:10px"><span>New</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="6" required></label></div>
          <button class="btn sm">Update password</button></div></form>
      </div>
      ${isAdmin() ? `<div class="section hide-desktop"><button class="btn block lg" data-act="nav" data-to="team">${ic('users')} Manage team</button></div>` : ''}
      ${isOwner() ? `<div class="section hide-desktop"><button class="btn block lg" data-act="nav" data-to="bot">${ic('msg')} WhatsApp bot</button></div>` : ''}
      <div class="section hide-desktop"><button class="btn danger block lg" data-act="logout">${ic('logout')} Log out</button></div>`;
  },
};

// ------------------------------------------------------------------ router & rendering
const defaultRoute = () => (isAdmin() ? 'home' : 'tasks');
function parseRoute() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'clients' && id) return { name: 'client', id, key: `clients/${id}` };
  return { name: name || defaultRoute(), id, key: name || defaultRoute() };
}
let viewSeq = 0, current = null;
async function renderView(soft = false) {
  const r = parseRoute();
  if (r.name === 'task' || r.name === 'notes') { // deep links from notifications / app shortcuts
    history.replaceState(null, '', `#/${defaultRoute()}`);
    if (r.name === 'task') openTask(r.id); else openNotes();
    return renderView();
  }
  const v = VIEWS[r.name];
  if (!v || (v.admin && !isAdmin()) || (v.owner && !isOwner())) { history.replaceState(null, '', `#/${defaultRoute()}`); return renderView(); }
  if (!current || current.r.key !== r.key) soft = false;
  const seq = ++viewSeq;
  updateChrome(r, v, soft ? current.data : null);
  const spin = soft ? null : setTimeout(() => { $('#view').innerHTML = '<div class="empty"><div class="spinner" style="margin:auto"></div></div>'; }, 150);
  try {
    const data = await v.load(r);
    clearTimeout(spin);
    if (seq !== viewSeq) return;
    current = { r, v, data };
    paint(soft);
  } catch (err) {
    clearTimeout(spin);
    if (seq !== viewSeq || err.status === 401) return;
    if (soft) return; // keep showing the last good data during a background refresh
    if (err.status === 404) { toast('That item no longer exists', 'bad'); return go(v.back || defaultRoute()); }
    $('#view').innerHTML = `<div class="card">${empty('alert', 'Couldn’t load this page', esc(err.message), '<button class="btn" data-act="retry">Try again</button>')}</div>`;
  }
}
// Re-render the current view; keeps scroll position, typed text and focus (so live updates never interrupt typing).
function paint(keep = true) {
  if (!current) return;
  const el = $('#view'), scroller = $('.scroll');
  const top = scroller.scrollTop;
  const kept = {};
  $$('[data-keep]', el).forEach((i) => { kept[i.dataset.keep] = i.value; });
  const active = document.activeElement?.dataset?.keep;
  const selStart = document.activeElement?.selectionStart, selEnd = document.activeElement?.selectionEnd;
  el.innerHTML = current.v.html(current.data, current.r);
  updateChrome(current.r, current.v, current.data);
  if (keep) {
    $$('[data-keep]', el).forEach((i) => { if (i.dataset.keep in kept) i.value = kept[i.dataset.keep]; });
    if (active) { const n = $(`[data-keep="${active}"]`, el); if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(selStart, selEnd); } catch { /* not a text input */ } } }
    scroller.scrollTop = top;
  } else scroller.scrollTop = 0;
}
function updateChrome(r, v, data) {
  const section = r.name === 'client' ? 'clients' : r.name;
  $$('[data-nav]').forEach((n) => n.classList.toggle('active', n.dataset.nav === section));
  if (['receivables', 'commercials', 'pipeline'].includes(section)) $$('.tabbar [data-nav="finance"]').forEach((n) => n.classList.add('active'));
  $('[data-act="back"]').classList.toggle('hidden', !v.back);
  if (data) {
    $('#title').textContent = v.title(data);
    $('#subtitle').textContent = v.sub ? v.sub(data) : '';
    document.title = `${S.unread ? `(${S.unread}) ` : ''}${v.title(data)} · Digiteq`;
  } else if (!current || current.r.key !== r.key) {
    $('#title').textContent = v.title({ tasks: [], name: '' }) || '';
    $('#subtitle').textContent = '';
  }
  const action = typeof v.action === 'function' ? v.action(data) : v.action;
  const btn = $('[data-top-action]');
  btn.classList.toggle('hidden', !action);
  if (action) {
    btn.dataset.act = action.act;
    btn.className = `btn ${action.plain ? '' : 'primary'} hide-mobile`;
    btn.innerHTML = `${action.plain ? '' : ic('plus')}${esc(action.label)}`;
  }
  const fab = $('.fab');
  fab.classList.toggle('hidden', !action || action.plain);
  if (action) fab.dataset.fab = action.act;
}
function updateBadges() {
  $$('[data-badge]').forEach((b) => { b.textContent = S.unread > 99 ? '99+' : S.unread; b.classList.toggle('hidden', !S.unread); });
  document.title = document.title.replace(/^\(\d+\+?\) /, '');
  if (S.unread) document.title = `(${S.unread}) ${document.title}`;
  navigator.setAppBadge?.(S.unread || undefined)?.catch?.(() => {});
  if (!S.unread) navigator.clearAppBadge?.()?.catch?.(() => {});
}

function mountShell() {
  const admin = isAdmin();
  const main = admin
    ? [['home', 'Overview', 'home'], ['clients', 'Clients', 'briefcase'], ['tasks', 'Tasks', 'tasks'], ['boards', 'Team boards', 'board'], ['updates', 'Updates', 'pulse'], ['team', 'Team', 'users']]
    : [['tasks', 'My tasks', 'tasks'], ['boards', 'Team boards', 'board'], ['clients', 'Clients', 'briefcase']];
  const owner = isOwner();
  const money = [['finance', 'Overview', 'spark'], ['receivables', 'Receivables', 'inbox'], ['commercials', 'Commercials', 'file'], ['pipeline', 'Opportunities', 'arrow'], ['bot', 'WhatsApp bot', 'msg']];
  const tabs = owner
    ? [['home', 'Home', 'home'], ['clients', 'Clients', 'briefcase'], ['notes', 'Notes', 'note'], ['tasks', 'Tasks', 'tasks'], ['finance', 'Money', 'inbox']]
    : admin
    ? [['home', 'Home', 'home'], ['clients', 'Clients', 'briefcase'], ['notes', 'Notes', 'note'], ['tasks', 'Tasks', 'tasks'], ['team', 'Team', 'users']]
    : [['tasks', 'Tasks', 'tasks'], ['clients', 'Clients', 'briefcase'], ['notes', 'Notes', 'note'], ['notifications', 'Alerts', 'bell'], ['settings', 'Me', 'user']];
  const navBtn = ([k, label, icon]) => `<button class="nav-item" data-act="nav" data-to="${k}" data-nav="${k}">${ic(icon)}<span>${label}</span></button>`;
  $('#app').innerHTML = `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><img src="/icons/icon-192.png" alt=""><div><b>Digiteq</b><span>Company dashboard</span></div></div>
      <div class="nav-label">Workspace</div>
      ${main.map(navBtn).join('')}
      ${owner ? `<div class="nav-label">Owner</div>${money.map(navBtn).join('')}` : ''}
      <div class="nav-label">Personal</div>
      <button class="nav-item" data-act="toggleNotes" data-notes-nav>${ic('note')}<span>My notes</span><span class="pill">Pop-up</span></button>
      <button class="nav-item" data-act="nav" data-to="notifications" data-nav="notifications">${ic('bell')}<span>Notifications</span><span class="count hidden" data-badge></span></button>
      <div class="spacer"></div>
      <div class="install-card ${S.installEvt && !standalone() ? '' : 'hidden'}" data-install><b>Get the desktop app</b>Open Digiteq in its own window.
        <button class="btn sm" data-act="install">${ic('download')} Install</button></div>
      <button class="me-card" data-act="nav" data-to="settings" data-nav="settings">${avatar(S.user)}
        <div class="grow"><b class="ellipsis" style="display:block">${esc(S.user.name)}</b><span class="small">${roleLabel(S.user)}</span></div>${ic('settings')}</button>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn back hidden" data-act="back" aria-label="Back">${ic('back')}</button>
        <div class="titles"><h1 id="title"></h1><div class="sub" id="subtitle"></div></div>
        <span class="live" title="Live updates">Live</span>
        <button class="btn primary hide-mobile hidden" data-top-action></button>
        <button class="icon-btn ${admin ? '' : 'hide-mobile'}" data-act="nav" data-to="notifications" aria-label="Notifications">${ic('bell')}<span class="count hidden" data-badge></span></button>
        <button class="icon-btn hide-desktop ${admin ? '' : 'hidden'}" data-act="nav" data-to="settings" aria-label="Settings">${avatar(S.user, 'xs')}</button>
      </header>
      <div class="scroll"><div class="view" id="view"></div></div>
    </div>
    <nav class="tabbar">${tabs.map(([k, label, icon]) => (k === 'notes'
    ? `<button class="tab center" data-act="toggleNotes" data-notes-nav><span class="bubble">${ic(icon)}</span>${label}</button>`
    : `<button class="tab" data-act="nav" data-to="${k}" data-nav="${k}">${ic(icon)}${label}${k === 'notifications' ? '<span class="count hidden" data-badge></span>' : ''}</button>`)).join('')}</nav>
    <button class="fab hidden" data-act="fab" aria-label="Add">${ic('plus')}</button>
    <button class="notes-fab" data-act="toggleNotes" aria-label="My notes">${ic('note')}<span class="tip">My notes</span></button>
  </div>`;
  setLive(S.live);
  updateBadges();
}
function setLive(on) {
  S.live = on;
  const dot = $('.live');
  if (dot) { dot.classList.toggle('on', on); dot.title = on ? 'Live: checking for changes regularly' : 'Reconnecting…'; dot.textContent = on ? 'Live' : 'Offline'; }
}

// ------------------------------------------------------------------ notes pop-up window
function openNotes() {
  if (S.notes.open) return;
  S.notes.open = true;
  const wrap = document.createElement('div');
  wrap.id = 'notes';
  wrap.innerHTML = `<div class="notes-backdrop" data-act="closeNotes"></div>
    <section class="notes-win" role="dialog" aria-label="My notes">
      <div class="notes-head"><div class="ico">${ic('note')}</div>
        <div class="grow"><b>My notes</b><span>Private — only you can see these</span></div>
        <button class="icon-btn" data-act="closeNotes" aria-label="Close notes">${ic('x')}</button></div>
      <form class="notes-compose" data-submit="newNote">
        <textarea name="content" placeholder="Write a note…" data-autogrow></textarea>
        <div class="row between" style="margin-top:8px"><span class="tiny faint hide-mobile"><span class="kbd">Ctrl</span> + <span class="kbd">Enter</span> to save</span><span class="hide-desktop"></span>
          <button class="btn primary sm">${ic('plus')} Save note</button></div>
      </form>
      <div class="notes-list"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div>
    </section>`;
  document.body.append(wrap);
  $$('[data-notes-nav]').forEach((b) => b.classList.add('active'));
  $('.notes-fab')?.classList.add('open');
  if (isMobile()) { history.pushState({ notes: 1 }, ''); S.notes.pushed = true; } else S.notes.pushed = false;
  if (!isMobile()) setTimeout(() => $('#notes textarea')?.focus(), 80);
  loadNotes();
}
function closeNotes(fromPop = false) {
  if (!S.notes.open) return;
  S.notes.open = false; S.notes.converting = null; S.notes.editing = null;
  $('#notes')?.remove();
  $$('[data-notes-nav]').forEach((b) => b.classList.remove('active'));
  $('.notes-fab')?.classList.remove('open');
  if (S.notes.pushed && !fromPop) { ignorePop++; history.back(); }
  S.notes.pushed = false;
}
async function loadNotes() {
  try { S.notes.list = await api('GET', '/api/notes'); renderNotes(); } catch { /* keep last list */ }
}
function renderNotes() {
  const box = $('#notes .notes-list');
  if (!box) return;
  // Keep anything typed in an open edit / convert form across live refreshes.
  const kept = {};
  $$('[data-nkeep]', box).forEach((i) => { kept[i.dataset.nkeep] = i.value; });
  const top = box.scrollTop;
  const list = S.notes.list || [];
  box.innerHTML = list.length ? list.map((n) => {
    if (S.notes.editing === n.id) {
      return `<form class="note converting" data-submit="editNote" data-id="${n.id}">
        <textarea class="input" name="content" data-nkeep="edit-${n.id}">${esc(n.content)}</textarea>
        <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn sm ghost" data-act="cancelNoteEdit">Cancel</button><button class="btn sm primary">Save</button></div></form>`;
    }
    const converting = S.notes.converting === n.id;
    const [first] = n.content.split('\n');
    return `<div class="note ${converting ? 'converting' : ''}">
      <div class="note-text">${linkify(n.content)}</div>
      ${converting ? `<form class="convert" data-submit="noteToTask" data-id="${n.id}">
          <div class="label" style="margin-bottom:6px">${ic('tasks')} Add to my tasks</div>
          <input class="input" name="title" data-nkeep="ct-${n.id}" value="${esc(first.slice(0, 120))}" placeholder="Task title" required>
          <div class="date-quick">${QUICK_DATES.map(([k, l]) => `<button type="button" class="btn sm ${k === 'clear' ? 'ghost' : ''}" data-act="noteDate" data-v="${k}">${l}</button>`).join('')}</div>
          <input class="input" type="datetime-local" name="deadline" data-nkeep="cd-${n.id}" aria-label="Deadline">
          <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn sm ghost" data-act="cancelConvert">Cancel</button>
            <button class="btn sm primary">${ic('check')} Confirm</button></div>
        </form>` : ''}
      <div class="note-foot">
        <span class="when">${timeAgo(n.updated_at)}</span>
        ${n.task_id
    ? `<button class="chip green click" data-act="openTask" data-id="${n.task_id}">${ic('check')}In my tasks${n.task_status === 'done' ? ' · done' : ''}</button>`
    : converting ? '' : `<button class="btn soft sm" data-act="startConvert" data-id="${n.id}">${ic('arrow')} Add to tasks</button>`}
        <button class="icon-btn sm" data-act="editNote" data-id="${n.id}" aria-label="Edit note">${ic('edit')}</button>
        <button class="icon-btn sm" data-act="delNote" data-id="${n.id}" aria-label="Delete note">${ic('trash')}</button>
      </div></div>`;
  }).join('') : empty('note', 'No notes yet', 'Jot anything down. Turn a note into a task with one click.');
  $$('[data-nkeep]', box).forEach((i) => { if (i.dataset.nkeep in kept) i.value = kept[i.dataset.nkeep]; });
  box.scrollTop = top;
}
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-prog]')) {
    if (e.isTrusted) e.target.dataset.touched = '1';
    const v = e.target.parentElement.querySelector('[data-prog-val]');
    if (v && e.target.dataset.touched) v.textContent = `${e.target.value}%`;
  }
  if (e.target.matches('[data-autogrow]')) { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }
});

// ------------------------------------------------------------------ task detail sheet
async function openTask(id) {
  const m = openModal({ title: 'Task', wide: true, body: '<div class="empty"><div class="spinner" style="margin:auto"></div></div>' });
  m.refresh = async () => {
    let t;
    try { t = await api('GET', `/api/tasks/${id}`); } catch (err) {
      if (err.status === 404 || err.status === 403) { if (stack.includes(m)) { closeModalObj(m); toast('This task was removed', 'bad'); } return; }
      throw err;
    }
    if (!stack.includes(m)) return;
    m.data.task = t;
    m.setTitle(t.client_name ? t.client_name : 'Task');
    m.setHead(t.can_edit ? `<button type="button" class="icon-btn" data-act="editTask" aria-label="Edit" title="Edit">${ic('edit')}</button>
      <button type="button" class="icon-btn" data-act="delTask" aria-label="Delete" title="Delete">${ic('trash')}</button>` : '');
    m.setBody(taskSheetHtml(t));
    m.setFoot(taskSheetFoot(t));
  };
  try { await m.refresh(); } catch (err) { toast(err.message, 'bad'); closeModalObj(m); }
}
function taskSheetHtml(t) {
  const brief = t.materials.filter((x) => x.stage === 'brief');
  const work = t.materials.filter((x) => x.stage === 'completion');
  const d = t.deadline ? dueInfo(t.deadline, t.status === 'done') : null;
  return `<div class="chips">
      <span class="pill-status st-${t.status}">${STATUS[t.status]}</span>
      ${t.priority !== 'normal' ? `<span class="chip ${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'amber' : ''}">${ic('flag')}${PRIO[t.priority]} priority</span>` : ''}
      ${t.source === 'self' ? '<span class="chip indigo">Self-added by employee</span>' : ''}
    </div>
    <h2 class="sheet-title">${esc(t.title)}</h2>
    <dl class="props">
      ${t.client_name ? `<dt>${ic('briefcase')}Client</dt><dd><button type="button" class="chip click" data-act="nav" data-to="clients/${t.client_id}">${logo(taskClient(t), 'xs')}${esc(t.client_name)}</button></dd>` : ''}
      <dt>${ic('calendar')}Deadline</dt><dd>${t.deadline ? `${fmtFull(t.deadline)} ${t.status !== 'done' ? `<span class="chip ${d.cls}">${isOverdue(t) ? 'Overdue' : timeLeft(t.deadline)}</span>` : ''}` : '<span class="muted">No deadline</span>'}</dd>
      ${t.team_name ? `<dt>${ic('board')}Team</dt><dd><span class="team-tag" style="--c:${esc(t.team_color || '#4f46e5')}">${esc(t.team_name)}</span></dd>` : ''}
      <dt>${ic('users')}Assigned to</dt><dd>${t.assignees.map((a) => `<span class="chip" style="padding-left:3px">${avatar(a, 'xxs')}${esc(a.name)}</span>`).join('') || '—'}</dd>
      <dt>${ic('user')}Created by</dt><dd>${esc(t.created_by_name || '—')} <span class="muted">· ${fmtShort(t.created_at)}</span></dd>
    </dl>
    ${t.status === 'done' ? `<div class="done-box" style="margin-top:18px">
        <div class="stamp">${ic('check')} Completed by ${esc(t.completed_by_name || '—')}</div>
        <div style="margin-top:2px;font-weight:600">${fmtFull(t.completed_at)}</div>
        ${t.completion_note ? `<div class="desc" style="margin-top:10px">${linkify(t.completion_note)}</div>` : ''}
      </div>` : ''}
    ${t.description ? `<div class="sub-head">Details</div><div class="desc">${linkify(t.description)}</div>` : ''}
    ${progressSection(t)}
    <div class="sub-head">Materials & links</div>${materialList(brief, 'No materials attached')}
    ${t.status === 'done' || work.length ? `<div class="sub-head">${t.status === 'done' ? 'Finished work' : 'Earlier submitted work'}</div>${materialList(work, 'No files or links were attached')}` : ''}`;
}
const UPDATE_IDEAS = ['Started the design', 'Figma file done', 'Prototype complete', 'Sent for client review', 'Working on changes', 'Waiting on client'];
function progressSection(t) {
  const canPost = t.can_work && t.status !== 'done';
  if (!canPost && !t.updates.length) return '';
  const pct = t.progress ?? 0;
  return `<div class="sub-head">Progress updates</div>
    ${t.progress !== null && t.progress !== undefined ? `<div class="row" style="margin-bottom:12px"><div class="progress grow" style="--c:var(--blue)"><i style="width:${pct}%"></i></div><b class="small num">${pct}%</b></div>` : ''}
    ${canPost ? `<form class="update-box" data-submit="postUpdate">
      <textarea class="input" name="text" data-mkeep="upd-text" placeholder="What did you finish? e.g. Figma file done, prototype complete…" rows="2"></textarea>
      <div class="chips" style="margin:8px 0">${UPDATE_IDEAS.map((x) => `<button type="button" class="chip click" data-act="updIdea">${x}</button>`).join('')}</div>
      <div class="row wrap">
        <span class="small muted">Progress</span>
        <input type="range" name="progress" min="0" max="100" step="10" value="${pct}" data-mkeep="upd-prog" data-prog style="flex:1;min-width:120px;accent-color:var(--primary)">
        <b class="small num" data-prog-val style="width:38px">${t.progress !== null && t.progress !== undefined ? `${pct}%` : '—'}</b>
        <button class="btn primary sm">${ic('msg')} Post update</button>
      </div>
      <div class="tiny faint" style="margin-top:8px">${isAdmin() ? 'Posted as a note on the task.' : 'Your admin gets all updates together once an hour — no need to message them.'}</div>
    </form>` : ''}
    ${t.updates.length ? `<div class="feed" style="margin-top:6px">${t.updates.map((u) => `<div class="feed-item">${avatar({ id: u.user_id, name: u.user_name || '?' }, 'xs')}
      <div class="grow"><div class="small"><b>${esc(u.user_name || 'Someone')}</b> <span class="faint">· ${fmtShort(u.created_at)}</span></div>
      <div class="feed-text">${esc(u.text)}${u.progress !== null ? ` <span class="chip blue">${u.progress}%</span>` : ''}</div></div></div>`).join('')}</div>` : ''}`;
}
function timeLeft(iso) {
  const h = Math.round((new Date(iso) - Date.now()) / 3600000);
  return h < 1 ? 'under 1 h left' : h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}
function taskSheetFoot(t) {
  if (!t.can_work) return '';
  if (t.status === 'done') {
    return `<button type="button" class="btn" data-act="taskStatus" data-status="todo">${ic('undo')} Reopen</button>
      <button type="button" class="btn" data-act="addWork">${ic('upload')} Add more files</button>`;
  }
  return `${t.status === 'todo'
    ? `<button type="button" class="btn" data-act="taskStatus" data-status="in_progress">${ic('play')} Start working</button>`
    : `<button type="button" class="btn" data-act="taskStatus" data-status="todo">${ic('undo')} Back to to-do</button>`}
    <button type="button" class="btn success lg" data-act="completeTask">${ic('check')} Mark as done</button>`;
}

// Completion: attach finished work, stamp date & time, notify the super admin.
function openCompleteForm(task) {
  openModal({
    title: 'Mark as done', form: 'complete', sticky: true, data: { task },
    body: `<div class="row" style="margin-bottom:18px"><span class="check on" style="width:30px;height:30px">${ic('check')}</span>
        <div class="grow"><div class="strong" style="font-size:16px;overflow-wrap:anywhere">${esc(task.title)}</div>${task.client_name ? `<div class="small muted">${esc(task.client_name)}</div>` : ''}</div></div>
      <label class="field"><span>What did you do? <span class="faint">(optional)</span></span>
        <textarea class="input" name="note" placeholder="Short summary, anything the admin should know…"></textarea></label>
      <div class="field"><span>Attach the finished work <span class="faint">(optional)</span></span>${attachPicker()}</div>
      <div class="banner" style="margin:4px 0 0"><div class="ico">${ic('clock')}</div><div class="grow small">Stamped with <b>${fmtShort(new Date().toISOString())}</b>${isAdmin() ? '.' : ' and the <b>super admin is notified</b> right away.'}</div></div>`,
    foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button>
      <button class="btn success lg">${ic('check')} Mark as done</button>`,
  });
}

// Create / edit task. A super admin must assign at least one employee.
async function openTaskForm({ task = null, prefill = {} } = {}) {
  const admin = isAdmin();
  const [users, clients, teams] = await Promise.all([admin ? api('GET', '/api/users') : [], api('GET', '/api/clients'), admin ? api('GET', '/api/teams') : []]);
  const t = task || prefill;
  const selected = new Set(task ? task.assignees.map((a) => a.id) : (prefill.assignees || []));
  const title = task ? 'Edit task' : admin ? 'New task' : 'Add a task to my list';
  const save = task ? 'Save changes' : admin ? 'Create & assign' : 'Add to my tasks';
  const people = [...users].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'employee' ? -1 : 1));
  const brief = task ? task.materials.filter((x) => x.stage === 'brief') : [];
  openModal({
    title, form: 'task', sticky: true, wide: true, data: { task, selected, teams, teamId: t.team_id ? Number(t.team_id) : null },
    body: `${!admin ? `<div class="banner"><div class="ico">${ic('user')}</div><div class="grow small">This goes into <b>your own task list</b> — it isn’t posted on the company dashboard. Linking a client is optional.</div></div>` : ''}
      <label class="field"><span>Task title <span class="req">*</span></span>
        <input class="input" name="title" maxlength="300" required value="${esc(t.title || '')}" placeholder="e.g. Design the homepage banner"></label>
      <div class="grid2">
        <label class="field"><span>Client</span><select class="input" name="client_id">
          <option value="">No client</option>${clients.map((c) => `<option value="${c.id}" ${String(t.client_id || '') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Priority</span><select class="input" name="priority">
          ${Object.entries(PRIO).map(([k, l]) => `<option value="${k}" ${(t.priority || 'normal') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>Deadline</span><input class="input" type="datetime-local" name="deadline" value="${toLocalInput(t.deadline)}">
        <div class="date-quick">${QUICK_DATES.map(([k, l]) => `<button type="button" class="btn sm ${k === 'clear' ? 'ghost' : ''}" data-act="quickDate" data-v="${k}">${l}</button>`).join('')}</div></div>
      ${admin ? `<label class="field"><span>Team <span class="faint" style="font-weight:500">— everyone in it shares the task</span></span><select class="input" name="team_id" data-on-change="taskTeam">
        <option value="">No team</option>${teams.map((x) => `<option value="${x.id}" ${String(t.team_id || '') === String(x.id) ? 'selected' : ''} ${x.members.length ? '' : 'disabled'}>${esc(x.name)} (${x.members.length ? plural(x.members.length, 'person') : 'no members yet'})</option>`).join('')}</select></label>
      <div class="field"><span>Assign to <span class="req">*</span> <span class="faint" style="font-weight:500">— required: a team, or one or more people</span></span>
        <div class="assign-box" data-assign>
          <div class="people">${people.map((u) => `<button type="button" class="person ${selected.has(u.id) ? 'on' : ''}" data-act="togglePerson" data-id="${u.id}">${avatar(u)}${esc(u.name)}${u.role === 'superadmin' ? ' <span class="faint small">(admin)</span>' : ''}</button>`).join('')}</div>
          ${people.length <= 1 ? `<div class="small muted" style="margin-top:8px">No employees yet — <a href="#/team" data-act="nav" data-to="team">add your team</a> first.</div>` : ''}
          <div class="err" data-assign-err style="margin-top:8px">${selected.size || t.team_id ? '' : 'Choose a team or at least one employee.'}</div>
        </div></div>` : ''}
      <label class="field"><span>Details</span><textarea class="input" name="description" placeholder="What needs to be done? Add any instructions.">${esc(t.description || '')}</textarea></label>
      ${brief.length ? `<div class="field"><span>Attached</span>${materialList(brief)}</div>` : ''}
      <div class="field" style="margin-bottom:0"><span>${task ? 'Add more materials or links' : 'Materials & links'}</span>${attachPicker()}</div>`,
    foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">${ic('check')} ${save}</button>`,
  });
}

function openClientForm(c = null) {
  const color = c?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  openModal({
    title: c ? 'Edit client' : 'New client', form: 'client', sticky: true, data: { client: c, color, logo: undefined },
    body: `<div class="logo-picker">
        <div data-logo-preview>${logo(c || { name: '?', color })}</div>
        <div class="grow"><div class="label">Client logo</div>
          <div class="small muted" style="margin:2px 0 10px">PNG, JPG or WebP — square works best.</div>
          <div class="row wrap"><label class="btn sm">${ic('upload')} Upload logo<input type="file" accept="image/*" hidden data-logo-file></label>
            <button type="button" class="btn sm ghost ${c?.logo_key ? '' : 'hidden'}" data-act="removeLogo">Remove</button></div></div>
      </div>
      <label class="field"><span>Client / company name <span class="req">*</span></span><input class="input" name="name" required value="${esc(c?.name || '')}" placeholder="e.g. Sunrise Bakery" data-act-input="clientNamePreview"></label>
      <div class="grid2">
        <label class="field"><span>Contact person</span><input class="input" name="contact_person" value="${esc(c?.contact_person || '')}"></label>
        <label class="field"><span>Phone</span><input class="input" name="phone" type="tel" value="${esc(c?.phone || '')}"></label>
      </div>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${esc(c?.email || '')}"></label>
      <div class="field"><span>Brand colour</span><div class="color-row">${PALETTE.map((p) => `<button type="button" class="swatch ${p === color ? 'on' : ''}" style="--c:${p}" data-act="pickColor" data-c="${p}" aria-label="${p}"></button>`).join('')}</div></div>
      <label class="field"><span>Details / notes</span><textarea class="input" name="details" placeholder="Services, scope, important info…">${esc(c?.details || '')}</textarea></label>
      ${c ? '' : `<div class="field" style="margin-bottom:0"><span>Materials & links <span class="faint">(optional)</span></span>${attachPicker()}</div>`}`,
    foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">${c ? 'Save changes' : 'Add client'}</button>`,
  });
}
function refreshLogoPreview(m) {
  if (m.data.logo) return;
  const f = m.el;
  const fake = { name: f.name.value || '?', color: m.data.color, logo_key: m.data.logo === null ? null : m.data.client?.logo_key };
  $('[data-logo-preview]', f).innerHTML = logo(fake);
}

function openUserForm(u = null) {
  openModal({
    title: u ? `Edit ${u.name}` : 'Add employee', form: 'user', sticky: true, data: { user: u },
    body: `<label class="field"><span>Full name <span class="req">*</span></span><input class="input" name="name" required value="${esc(u?.name || '')}"></label>
      ${u ? '' : '<label class="field"><span>Username (for login) <span class="req">*</span></span><input class="input" name="username" required autocapitalize="none" autocomplete="off"></label>'}
      <label class="field"><span>${u ? 'New password (leave empty to keep)' : 'Password'} ${u ? '' : '<span class="req">*</span>'}</span>
        <input class="input" name="password" type="text" autocomplete="new-password" minlength="6" placeholder="At least 6 characters"></label>
      <label class="field"><span>WhatsApp number <span class="faint">(with country code — the bot uses it)</span></span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="91 98765 43210" value="${esc(u?.phone || '')}"></label>
      <label class="field"><span>Email <span class="faint">(optional — for “Forgot password” links)</span></span><input class="input" name="email" type="email" autocomplete="off" value="${esc(u?.email || '')}"></label>
      <label class="field"><span>Role</span><select class="input" name="role">
        <option value="employee" ${u?.role !== 'superadmin' ? 'selected' : ''}>Employee — own tasks, notes, clients</option>
        <option value="superadmin" ${u?.role === 'superadmin' ? 'selected' : ''}>Super admin — full control</option></select></label>
      ${isOwner() ? `<label class="row owner-toggle"><input type="checkbox" name="is_owner" ${u?.is_owner ? 'checked' : ''}>
        <span><b>Owner</b> — also sees Finance: commercials, receivables, client dues and opportunities. Only for super admins.</span></label>` : ''}
      ${u ? '' : '<p class="small muted">Share the username and password with the employee. They can change the password later in Settings.</p>'}`,
    foot: `<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary lg">${u ? 'Save' : 'Add employee'}</button>`,
  });
}

// ------------------------------------------------------------------ click actions
const ACT = {
  nav: (el) => go(el.dataset.to),
  back: () => go(current?.v.back || defaultRoute()),
  retry: () => renderView(),
  closeModal: (el) => { const m = modalOf(el); if (m) closeModalObj(m); },
  askOk: (el) => { modalOf(el).data.ok = true; closeTop(); },
  fab: (el) => ACT[el.dataset.fab]?.(el),
  newTask: () => openTaskForm(),
  newTaskForClient: () => openTaskForm({ prefill: { client_id: current?.data?.id } }),
  newClient: () => openClientForm(),
  newUser: () => openUserForm(),
  toggleNotes: () => (S.notes.open ? closeNotes() : openNotes()),
  closeNotes: () => closeNotes(),
  openTask: (el) => openTask(el.dataset.id),
  async quickDone(el) { openCompleteForm(await api('GET', `/api/tasks/${el.dataset.id}`)); },
  completeTask: (el) => openCompleteForm(modalOf(el).data.task),
  addWork(el) {
    const m = modalOf(el);
    openModal({ title: 'Add finished work', form: 'addWork', sticky: true, data: { task: m.data.task },
      body: `<div class="field" style="margin:0"><span>Files or links</span>${attachPicker()}</div>`,
      foot: '<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary">Upload</button>' });
  },
  async taskStatus(el) {
    const m = modalOf(el);
    el.disabled = true;
    try {
      await api('POST', `/api/tasks/${m.data.task.id}/status`, { status: el.dataset.status });
      toast(el.dataset.status === 'in_progress' ? 'Marked as in progress' : 'Moved back to to-do', 'ok');
      await m.refresh();
      scheduleRefresh();
    } finally { if (el.isConnected) el.disabled = false; }
  },
  editTask: (el) => openTaskForm({ task: modalOf(el).data.task }),
  async delTask(el) {
    const m = modalOf(el);
    if (!(await ask(`Delete “${m.data.task.title}”? Its files are removed too.`, { ok: 'Delete task', danger: true }))) return;
    await api('DELETE', `/api/tasks/${m.data.task.id}`);
    closeModalObj(m); toast('Task deleted', 'ok'); scheduleRefresh();
  },
  togglePerson(el) {
    const m = modalOf(el), id = Number(el.dataset.id);
    m.data.selected.has(id) ? m.data.selected.delete(id) : m.data.selected.add(id);
    el.classList.toggle('on', m.data.selected.has(id));
    const any = m.data.selected.size || m.data.teamId;
    if (any) $('[data-assign]', m.el).classList.remove('invalid');
    $('[data-assign-err]', m.el).textContent = any ? '' : 'Choose a team or at least one employee.';
  },
  updIdea(el) { const ta = el.closest('form').text; ta.value = ta.value.trim() ? `${ta.value.trim()}. ${el.textContent}` : el.textContent; ta.focus(); },
  async sendDigest() {
    const { sent } = await api('POST', '/api/updates/digest');
    toast(sent ? `Sent ${plural(sent, 'update')} in one notification` : 'No new updates since the last digest', sent ? 'ok' : '');
  },
  quickDate(el) { $('[name="deadline"]', modalOf(el).el).value = quickDateValue(el.dataset.v); },
  attShowLink(el) { const f = $('.link-form', el.closest('[data-attach]')); f.classList.remove('hidden'); $('[data-link-url]', f).focus(); },
  attAddLink(el) {
    const box = el.closest('[data-attach]');
    const url = $('[data-link-url]', box), title = $('[data-link-title]', box);
    if (!url.value.trim()) return url.focus();
    attachItems(box).push({ kind: 'link', url: url.value.trim(), title: title.value.trim() });
    url.value = ''; title.value = '';
    renderAttach(box);
  },
  attRemove(el) { const box = el.closest('[data-attach]'); attachItems(box).splice(Number(el.dataset.i), 1); renderAttach(box); },
  async openFile(el) {
    const res = await fetch(`/api/files/${el.dataset.id}`, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!res.ok) throw new Error('Could not open the file');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: el.dataset.name || 'file' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  async delMaterial(el) {
    if (!(await ask('Remove this file or link?', { ok: 'Remove', danger: true }))) return;
    await api('DELETE', `/api/materials/${el.dataset.id}`);
    toast('Removed', 'ok'); scheduleRefresh();
  },
  statGo(el) { S.ui.adminStatus = el.dataset.status; S.ui.layout = 'list'; go('tasks'); },
  myStatus(el) { S.ui.myStatus = el.dataset.status; S.ui.myStatusPicked = true; paint(); },
  adminStatus(el) { S.ui.adminStatus = el.dataset.status; paint(); },
  setLayout(el) { S.ui.layout = el.dataset.v; store.set('dq_layout', el.dataset.v); paint(); },
  clearFilters() { Object.assign(S.ui, { assignee: '', client: '', source: '', taskSearch: '' }); paint(); },
  viewUserTasks(el) { Object.assign(S.ui, { assignee: el.dataset.id, client: '', source: '', adminStatus: 'open' }); go('tasks'); },
  clientTab(el) { S.ui.clientTab = el.dataset.tab; paint(); },
  editClient: () => openClientForm(current.data),
  async delClient(el) {
    if (!(await ask(`Delete “${current.data.name}” with all its tasks, deadlines and files? This cannot be undone.`, { ok: 'Delete client', danger: true }))) return;
    await api('DELETE', `/api/clients/${el.dataset.id}`);
    toast('Client deleted', 'ok'); go('clients');
  },
  pickColor(el) {
    const m = modalOf(el); m.data.color = el.dataset.c;
    $$('.swatch', m.el).forEach((s) => s.classList.toggle('on', s === el));
    refreshLogoPreview(m);
  },
  removeLogo(el) {
    const m = modalOf(el); m.data.logo = null;
    el.classList.add('hidden');
    refreshLogoPreview(m);
  },
  addClientMaterial(el) {
    openModal({ title: 'Add materials & links', form: 'clientMaterials', sticky: true, data: { id: el.dataset.id },
      body: `<div class="field" style="margin:0"><span>Files or links for ${esc(current.data.name)}</span>${attachPicker()}</div>`,
      foot: '<button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary">Save</button>' });
  },
  async toggleDeadline(el) { await api('PATCH', `/api/deadlines/${el.dataset.id}`, { done: el.dataset.done === '1' }); scheduleRefresh(); },
  async delDeadline(el) {
    if (!(await ask('Delete this deadline?', { ok: 'Delete', danger: true }))) return;
    await api('DELETE', `/api/deadlines/${el.dataset.id}`); scheduleRefresh();
  },
  startConvert(el) { S.notes.converting = Number(el.dataset.id); S.notes.editing = null; renderNotes(); $('#notes .convert input')?.focus(); },
  cancelConvert() { S.notes.converting = null; renderNotes(); },
  noteDate(el) { el.closest('form').deadline.value = quickDateValue(el.dataset.v); },
  editNote(el) { S.notes.editing = Number(el.dataset.id); S.notes.converting = null; renderNotes(); $('#notes .note textarea')?.focus(); },
  cancelNoteEdit() { S.notes.editing = null; renderNotes(); },
  async delNote(el) {
    if (!(await ask('Delete this note?', { ok: 'Delete', danger: true }))) return;
    await api('DELETE', `/api/notes/${el.dataset.id}`); loadNotes();
  },
  async editUser(el) {
    const users = await api('GET', '/api/users');
    openUserForm(users.find((u) => String(u.id) === el.dataset.id));
  },
  async delUser(el) {
    if (!(await ask(`Remove ${el.dataset.name}? Their tasks stay, but they will be unassigned and can no longer log in.`, { ok: 'Remove', danger: true }))) return;
    await api('DELETE', `/api/users/${el.dataset.id}`); toast('Removed', 'ok'); scheduleRefresh();
  },
  openNotif(el) {
    api('POST', '/api/notifications/read', { id: el.dataset.id }).then(scheduleRefresh).catch(() => {});
    el.classList.remove('unread');
    if (el.dataset.task) openTask(el.dataset.task);
    else if (el.dataset.type === 'digest') go('updates');
    else if (el.dataset.type === 'reminder') go('tasks');
    else if (el.dataset.type === 'payment' && isOwner()) go('receivables');
    else if (el.dataset.type === 'finance' && isOwner()) go('finance');
    else if (el.dataset.type === 'reset_request' && isAdmin()) go('team');
    else if (el.dataset.type === 'bot') go('settings');
  },
  async readAll() { await api('POST', '/api/notifications/read', {}); scheduleRefresh(); },
  enablePush: () => enablePush(),
  async testNotif() {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) reg.showNotification('Digiteq notifications work ✓', { body: 'This is how alerts will look.', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' });
    else new Notification('Digiteq notifications work ✓');
  },
  theme(el) { setTheme(el.dataset.v); paint(); },
  async install() {
    if (!S.installEvt) return go('settings');
    S.installEvt.prompt();
    await S.installEvt.userChoice;
    S.installEvt = null;
    $$('[data-install]').forEach((b) => b.classList.add('hidden'));
    if (current?.r.name === 'settings') paint();
  },
  logout: () => logout(),
  boardTeam(el) { S.ui.boardTeam = Number(el.dataset.id); paint(); },
  newTeamTask: () => openTaskForm({ prefill: { team_id: current.data.current } }),
  newTeam: () => openTeamForm(null, current.data.users),
  editTeam(el) { openTeamForm(current.data.teams.find((x) => String(x.id) === el.dataset.id), current.data.users); },
  togglePersonTeam(el) {
    const set = modalOf(el).data.selected, id = Number(el.dataset.id);
    set.has(id) ? set.delete(id) : set.add(id);
    el.classList.toggle('on', set.has(id));
  },
  async delTeam(el) {
    const m = modalOf(el);
    if (!(await ask(`Delete team “${m.data.team.name}”? Its tasks stay with the people already on them.`, { ok: 'Delete team', danger: true }))) return;
    await api('DELETE', `/api/teams/${m.data.team.id}`);
    closeModalObj(m); toast('Team deleted', 'ok'); scheduleRefresh();
  },
  forgotPassword: () => showForgot($('.auth-form [name=username]')?.value || ''),
  backToLogin: () => { history.replaceState(null, '', '#/'); showAuth(false); },
  async tempPassword(el) {
    if (!(await ask(`Create a temporary password for ${el.dataset.name}? They’ll be signed out everywhere and must choose their own password at the next sign-in.`, { ok: 'Create temporary password', title: 'Reset password' }))) return;
    const r = await api('POST', `/api/users/${el.dataset.id}/temp-password`);
    openModal({
      title: 'Temporary password',
      body: `<p class="muted small" style="margin-bottom:12px">Give these to <b>${esc(el.dataset.name)}</b> in person, by phone or on WhatsApp. This password is shown only once.</p>
        <div class="temp-pass"><div><span class="tiny muted">Username</span><b>${esc(r.username)}</b></div><div><span class="tiny muted">Temporary password</span><b class="num" data-temp>${esc(r.password)}</b></div></div>`,
      foot: `<button type="button" class="btn" data-act="copyTemp" data-text="${esc(`Username: ${r.username}
Temporary password: ${r.password}`)}">${ic('clip')} Copy</button><button type="button" class="btn primary" data-act="closeModal">Done</button>`,
    });
    scheduleRefresh();
  },
  async copyTemp(el) {
    try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied', 'ok'); } catch { toast('Couldn’t copy — select the text instead', 'bad'); }
  },
};

const INPUT = {
  clientSearch(el) { S.ui.clientSearch = el.value; paint(); },
  taskSearch(el) { S.ui.taskSearch = el.value; paint(); },
};
const CHANGE = {
  filter(el) { S.ui[el.dataset.k] = el.value; paint(); },
  // Switching team swaps the old team's people for nobody: the server adds the new team's members itself.
  taskTeam(el) {
    const m = modalOf(el);
    const old = m.data.teams.find((x) => x.id === m.data.teamId);
    for (const u of old?.members || []) m.data.selected.delete(u.id);
    m.data.teamId = el.value ? Number(el.value) : null;
    $$('.person', m.el).forEach((p) => p.classList.toggle('on', m.data.selected.has(Number(p.dataset.id))));
    const any = m.data.selected.size || m.data.teamId;
    if (any) $('[data-assign]', m.el).classList.remove('invalid');
    $('[data-assign-err]', m.el).textContent = any ? '' : 'Choose a team or at least one employee.';
  },
};

// ------------------------------------------------------------------ form submits
const SUBMIT = {
  async login(f) {
    const d = await api('POST', '/api/login', { username: f.username.value, password: f.password.value });
    S.loginPassword = d.user.must_change_password ? f.password.value : null; // kept in memory only, for the forced change
    signIn(d);
  },
  async forgot(f) { await api('POST', '/api/password/forgot', { username: f.username.value }); showForgotSent(); },
  async resetPassword(f) {
    if (f.password.value !== f.confirm.value) throw new Error('The two passwords don’t match');
    const d = await api('POST', '/api/password/reset', { token: f.dataset.token, password: f.password.value });
    history.replaceState(null, '', '#/');
    toast('You’re signed in with your new password', 'ok', { title: 'Password changed' });
    signIn(d);
  },
  async forceChange(f) {
    if (f.password.value !== f.confirm.value) throw new Error('The two passwords don’t match');
    await api('POST', '/api/me/password', { current: S.loginPassword || f.current.value, password: f.password.value });
    S.loginPassword = null; S.user.must_change_password = false;
    toast('Password saved', 'ok');
    startApp();
  },
  async team(f, m) {
    const body = { name: f.name.value, keywords: f.keywords.value, members: [...m.data.selected] };
    await (m.data.team ? api('PATCH', `/api/teams/${m.data.team.id}`, body) : api('POST', '/api/teams', body));
    closeModalObj(m); toast(body.name, 'ok', { title: 'Team saved' }); scheduleRefresh();
  },
  async myPhone(f) {
    const r = await api('POST', '/api/me/phone', { phone: f.phone.value });
    S.user.phone = r.phone; toast(r.phone ? 'WhatsApp number saved' : 'WhatsApp number removed', 'ok');
  },
  async myEmail(f) {
    const r = await api('POST', '/api/me/email', { email: f.email.value });
    S.user.email = r.email; toast(r.email ? 'Recovery email saved' : 'Recovery email removed', 'ok');
  },
  async setup(f) { signIn(await api('POST', '/api/setup', { name: f.name.value, username: f.username.value, password: f.password.value })); },
  async task(f, m) {
    const admin = isAdmin();
    const body = {
      title: f.title.value.trim(), client_id: f.client_id.value || null, priority: f.priority.value,
      deadline: fromLocalInput(f.deadline.value), description: f.description.value,
    };
    if (!body.title) { f.title.focus(); throw new Error('Please enter a task title'); }
    if (admin) {
      body.assignees = [...m.data.selected];
      body.team_id = f.team_id.value || null;
      if (!body.assignees.length && !body.team_id) {
        const box = $('[data-assign]', f);
        box.classList.remove('invalid'); void box.offsetWidth; box.classList.add('invalid');
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        throw new Error('Assign this task to a team or at least one employee');
      }
    }
    body.materials = await collectAttachments(f);
    const t = m.data.task ? await api('PATCH', `/api/tasks/${m.data.task.id}`, body) : await api('POST', '/api/tasks', body);
    closeModalObj(m);
    toast(m.data.task ? 'Changes saved' : admin ? `Assigned to ${t.team_name || t.assignees.map((a) => a.name).join(', ')}` : 'Added to your tasks', 'ok', { title: m.data.task ? 'Task updated' : t.title });
    scheduleRefresh();
  },
  async complete(f, m) {
    const t = await api('POST', `/api/tasks/${m.data.task.id}/complete`, { note: f.note.value, materials: await collectAttachments(f) });
    closeModalObj(m);
    toast(`${fmtShort(t.completed_at)}${isAdmin() ? '' : ' — super admin notified'}`, 'ok', { title: 'Task done ✅' });
    scheduleRefresh();
  },
  async addWork(f, m) {
    const materials = await collectAttachments(f);
    if (!materials.length) throw new Error('Add at least one file or link');
    await api('POST', `/api/tasks/${m.data.task.id}/materials`, { stage: 'completion', materials });
    closeModalObj(m); toast('Uploaded', 'ok'); scheduleRefresh();
  },
  async client(f, m) {
    const body = { name: f.name.value, contact_person: f.contact_person.value, phone: f.phone.value, email: f.email.value, details: f.details.value, color: m.data.color };
    if (m.data.logo !== undefined) body.logo = m.data.logo;
    if (m.data.client) {
      await api('PATCH', `/api/clients/${m.data.client.id}`, body);
      closeModalObj(m); toast('Client saved', 'ok'); return scheduleRefresh();
    }
    const materials = await collectAttachments(f);
    const c = await api('POST', '/api/clients', body);
    if (materials.length) await api('POST', `/api/clients/${c.id}/materials`, { materials });
    closeModalObj(m); toast(c.name, 'ok', { title: 'Client added' });
    S.ui.clientTab = 'tasks';
    go(`clients/${c.id}`);
  },
  async clientMaterials(f, m) {
    const materials = await collectAttachments(f);
    if (!materials.length) throw new Error('Add at least one file or link');
    await api('POST', `/api/clients/${m.data.id}/materials`, { materials });
    closeModalObj(m); toast('Saved', 'ok'); S.ui.clientTab = 'materials'; scheduleRefresh();
  },
  async addDeadline(f) {
    await api('POST', `/api/clients/${f.dataset.id}/deadlines`, { title: f.title.value, due_at: fromLocalInput(f.due_at.value) });
    f.reset(); $$('[data-keep]', f).forEach((i) => { i.value = ''; });
    toast('Deadline added', 'ok'); scheduleRefresh();
  },
  async user(f, m) {
    const body = { name: f.name.value, password: f.password.value, role: f.role.value, email: f.email.value, phone: f.phone.value };
    if (f.is_owner) body.is_owner = f.is_owner.checked && f.role.value === 'superadmin';
    if (m.data.user) await api('PATCH', `/api/users/${m.data.user.id}`, body);
    else await api('POST', '/api/users', { ...body, username: f.username.value });
    closeModalObj(m); toast(m.data.user ? 'Saved' : 'Employee added', 'ok'); scheduleRefresh();
  },
  async newNote(f) {
    const ta = f.content;
    if (!ta.value.trim()) return ta.focus();
    await api('POST', '/api/notes', { content: ta.value });
    ta.value = ''; ta.style.height = '';
    loadNotes();
  },
  async editNote(f) {
    await api('PATCH', `/api/notes/${f.dataset.id}`, { content: f.content.value });
    S.notes.editing = null; loadNotes();
  },
  // One click "Add to tasks" → this confirm: the note becomes a task in the user's own list.
  async noteToTask(f) {
    const title = f.title.value.trim();
    if (!title) { f.title.focus(); throw new Error('Give the task a title'); }
    const note = S.notes.list.find((n) => String(n.id) === f.dataset.id);
    const description = note.content.startsWith(title) ? note.content.slice(title.length).trim() : note.content;
    const body = { title, description, deadline: fromLocalInput(f.deadline.value), note_id: note.id };
    if (isAdmin()) body.assignees = [S.user.id];
    await api('POST', '/api/tasks', body);
    S.notes.converting = null;
    toast(title, 'ok', { title: 'Added to my tasks' });
    loadNotes(); scheduleRefresh();
  },
  async postUpdate(f, m) {
    const text = f.text.value.trim();
    if (!text) { f.text.focus(); throw new Error('Write what you finished or are working on'); }
    await api('POST', `/api/tasks/${m.data.task.id}/updates`, { text, progress: f.progress.dataset.touched ? Number(f.progress.value) : null });
    f.text.value = ''; delete f.progress.dataset.touched;
    toast(isAdmin() ? 'Update posted' : 'Your admin gets it in the next hourly update', 'ok', { title: 'Update posted' });
    await m.refresh(); scheduleRefresh();
  },
  async password(f) {
    await api('POST', '/api/me/password', { current: f.current.value, password: f.password.value });
    f.reset(); toast('Password updated', 'ok');
  },
};

// ------------------------------------------------------------------ board drag & drop (desktop)
let dragId = null, dragKind = 'task';
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.task[draggable="true"]');
  if (!card) return;
  dragId = card.dataset.id;
  dragKind = card.dataset.kind || 'task';
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
document.addEventListener('dragend', (e) => { e.target.closest?.('.task')?.classList.remove('dragging'); $$('.col.drop').forEach((c) => c.classList.remove('drop')); });
document.addEventListener('dragover', (e) => {
  const col = e.target.closest?.('.col');
  if (!col || !dragId) return;
  e.preventDefault();
  $$('.col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
  col.classList.add('drop');
});
document.addEventListener('drop', async (e) => {
  const col = e.target.closest?.('.col');
  if (!col || !dragId) return;
  e.preventDefault();
  col.classList.remove('drop');
  const id = dragId; dragId = null;
  if (dragKind === 'deal') { try { await dropDeal(id, col.dataset.col); } catch (err) { toast(err.message, 'bad'); } return; }
  const task = current?.data?.tasks?.find((t) => String(t.id) === id);
  const to = col.dataset.col;
  if (!task || task.status === to) return;
  try {
    if (to === 'done') openCompleteForm(task); // finishing always goes through the completion sheet
    else { await api('POST', `/api/tasks/${id}/status`, { status: to }); toast(`Moved to ${STATUS[to]}`, 'ok'); scheduleRefresh(); }
  } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ global event wiring
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  e.preventDefault(); e.stopPropagation();
  try { await fn(el, e); } catch (err) { toast(err.message, 'bad'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (stack.length) { e.preventDefault(); closeTop(); return; }
    if (S.notes.open) { e.preventDefault(); closeNotes(); return; }
  }
  if (e.key === 'Enter' && e.target.matches?.('[role="button"]')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches?.('textarea')) { e.preventDefault(); e.target.form?.requestSubmit(); }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-on-input]');
  if (el) INPUT[el.dataset.onInput]?.(el);
  if (e.target.matches('[data-act-input="clientNamePreview"]')) { const m = modalOf(e.target); if (m) refreshLogoPreview(m); }
});
document.addEventListener('change', (e) => { const el = e.target.closest('[data-on-change]'); if (el) CHANGE[el.dataset.onChange]?.(el); });
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-submit]');
  if (!f) return;
  e.preventDefault();
  const fn = SUBMIT[f.dataset.submit];
  const btns = $$('button:not([type="button"])', f);
  const errBox = $('[data-form-err]', f);
  btns.forEach((b) => { b.disabled = true; });
  try { if (errBox) errBox.textContent = ''; await fn(f, modalOf(f)); } catch (err) {
    if (errBox) errBox.textContent = err.message; else toast(err.message, 'bad');
  } finally { btns.forEach((b) => { b.disabled = false; }); }
});
window.addEventListener('hashchange', () => { if (S.user) renderView(); });
let lastMobile = isMobile();
window.addEventListener('resize', () => { if (isMobile() !== lastMobile) { lastMobile = isMobile(); if (current) paint(); } });

// ------------------------------------------------------------------ live updates: adaptive polling
let refreshTimer = null, pollSession = null;
let lastActivity = Date.now();
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, 200);
}
async function refreshAll() {
  if (!S.user) return;
  api('GET', '/api/me').then((d) => {
    if (!S.user) return;
    const roleChanged = d.user.role !== S.user.role || d.user.is_owner !== S.user.is_owner;
    if (d.currency) S.currency = d.currency;
    S.emailReset = !!d.email_reset;
    S.user = d.user; S.unread = d.unread;
    if (roleChanged) { mountShell(); renderView(); } else updateBadges();
  }).catch(() => {});
  if (current) renderView(true);
  if (S.notes.open) loadNotes();
  for (const m of [...stack]) m.refresh?.().catch(() => {});
}
function showNewNotification(n) {
  if (n.type === 'completed' || n.type === 'assigned') ding();
  toast(n.body, n.type === 'completed' ? 'ok' : '', { title: n.title, ms: 7000, onClick: () => n.task_id && openTask(n.task_id) });
  if (document.hidden && !S.pushOn && 'Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(n.title, {
      body: n.body, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', tag: `n${n.id}`,
      data: { url: n.task_id ? `/#/task/${n.task_id}` : '/#/notifications' },
    })).catch(() => {});
  }
}
function stopPolling() {
  if (pollSession) { clearTimeout(pollSession.timer); pollSession.controller?.abort(); }
  pollSession = null;
  clearTimeout(refreshTimer);
}
function startPolling() {
  stopPolling();
  pollSession = { version: null, lastId: null, timer: null, running: false, again: false };
  lastActivity = Date.now();
  pollNow();
}
async function pollNow() {
  const session = pollSession;
  if (!session || !S.user) return;
  clearTimeout(session.timer);
  if (session.running) { session.again = true; return; }
  session.running = true;
  try {
    session.controller = new AbortController();
    // Bound a hung request so Offline and retries still work after a network drop.
    const timeout = setTimeout(() => session.controller.abort(), 20000);
    let res;
    try {
      res = await fetch(`/api/sync?n=${session.lastId ?? ''}`, { cache: 'no-store',
        headers: { Authorization: `Bearer ${S.token}` }, signal: session.controller.signal });
    } finally { clearTimeout(timeout); }
    if (session !== pollSession) return;
    if (res.status === 401) { logout(true); return; }
    if (!res.ok) throw new Error('Sync failed');
    const data = await res.json();
    if (session !== pollSession) return;
    setLive(true);
    if (data.version !== session.version) {
      lastActivity = Date.now();
      scheduleRefresh();
    }
    session.version = data.version;
    S.unread = data.unread; updateBadges();
    for (const n of data.notifications) showNewNotification(n);
    // The API caps a page at 20. Drain the backlog before advancing to last_id.
    session.lastId = data.notifications.length ? data.notifications.at(-1).id : data.last_id;
    if (session.lastId < data.last_id) session.again = true;
  } catch {
    if (session === pollSession) setLive(false);
  } finally {
    session.running = false;
    if (session === pollSession && S.user) {
      const delay = session.again ? 0 : document.hidden ? 30000 : Date.now() - lastActivity >= 120000 ? 8000 : 3000;
      session.again = false;
      session.timer = setTimeout(pollNow, delay);
    }
  }
}
document.addEventListener('click', () => { lastActivity = Date.now(); }, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (!S.user) return;
  pollNow();
  if (!document.hidden) scheduleRefresh();
});
window.addEventListener('online', () => { if (S.user) pollNow(); });

// ------------------------------------------------------------------ push notifications
const b64ToU8 = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  S.pushOn = true;
  return true;
}
async function enablePush() {
  if (!('Notification' in window)) return toast(isIOS() ? 'On iPhone, first install the app (Share → Add to Home Screen), then turn notifications on.' : 'This browser does not support notifications', 'bad');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications were blocked. You can allow them in the browser settings.', 'bad'); return paint(); }
  try { await subscribePush(); } catch { /* push service unavailable: in-app alerts still work */ }
  toast('Notifications are on', 'ok');
  paint();
}

// ------------------------------------------------------------------ auth & boot
function authShell(inner) {
  current = null;
  closeNotes(true);
  const perks = [['briefcase', 'Every client on one card — tasks, deadlines, files'], ['users', 'Assign work to one or many teammates'], ['bell', 'Instant alerts when work is finished'], ['note', 'Private notes that turn into tasks in one click']];
  $('#app').innerHTML = `<div class="auth">
    <div class="auth-side">
      <div class="brand" style="padding:0"><img src="/icons/icon-192.png" alt=""><div><b>Digiteq</b><span>Company dashboard</span></div></div>
      <div><h2>Your team’s work, clear and on time.</h2><div style="max-width:420px">Clients, tasks and deadlines in one place — updated live on every phone and PC.</div>
        <ul>${perks.map(([i, t]) => `<li><span class="ico">${ic(i)}</span>${t}</li>`).join('')}</ul></div>
      <div class="small" style="opacity:.6">© ${new Date().getFullYear()} Digiteq</div>
    </div>
    <div class="auth-main">${inner}</div></div>`;
  setTimeout(() => $('.auth-main input:not([type=hidden])')?.focus(), 50);
}
const authHead = (title, text) => `<img class="logo-sm" src="/icons/icon-192.png" alt=""><h1>${title}</h1><p class="muted" style="margin-bottom:24px">${text}</p>`;
const formErr = '<div class="err" data-form-err style="min-height:20px;margin-bottom:8px"></div>';
function showAuth(needsSetup) {
  authShell(`<form class="auth-form" data-submit="${needsSetup ? 'setup' : 'login'}">
      ${authHead(needsSetup ? 'Set up your workspace' : 'Welcome back', needsSetup ? 'Create the <b>owner</b> account. You can add your team right after.' : 'Sign in with the username and password from your admin.')}
      ${needsSetup ? '<label class="field"><span>Your name</span><input class="input" name="name" required autocomplete="name"></label>' : ''}
      <label class="field"><span>${needsSetup ? 'Username' : 'Username or email'}</span><input class="input" name="username" required autocapitalize="none" autocomplete="username" ${needsSetup ? '' : 'placeholder="e.g. priya or priya@company.com"'}></label>
      <label class="field"><span class="row between">Password${needsSetup ? '' : '<button type="button" class="link-btn" data-act="forgotPassword">Forgot password?</button>'}</span>
        <input class="input" name="password" type="password" required minlength="${needsSetup ? 6 : 1}" autocomplete="${needsSetup ? 'new-password' : 'current-password'}"></label>
      ${formErr}
      <button class="btn primary block lg">${needsSetup ? 'Create account' : 'Sign in'} ${ic('arrow')}</button>
    </form>`);
}
function showForgot(prefill = '') {
  authShell(`<form class="auth-form" data-submit="forgot">
      ${authHead('Forgot your password?', 'Enter your username (or the email on your account). We’ll send you a reset link, or ask your admin to reset it for you.')}
      <label class="field"><span>Username or email</span><input class="input" name="username" required autocapitalize="none" autocomplete="username" value="${esc(prefill)}"></label>
      ${formErr}
      <button class="btn primary block lg">Reset my password ${ic('arrow')}</button>
      <button type="button" class="btn ghost block" style="margin-top:10px" data-act="backToLogin">${ic('back')} Back to sign in</button>
    </form>`);
}
function showForgotSent() {
  authShell(`<div class="auth-form">
      ${authHead('Help is on the way', 'If that account exists, one of these just happened:')}
      <div class="card pad" style="display:grid;gap:14px">
        <div class="row top"><div class="mat-icon">${ic('mail')}</div><div class="small"><b>A reset link was emailed</b><br>if your account has an email. It works for 1 hour.</div></div>
        <div class="row top"><div class="mat-icon file">${ic('key')}</div><div class="small"><b>Your admin was notified</b><br>They’ll give you a temporary password. You’ll choose a new one when you sign in.</div></div>
      </div>
      <button type="button" class="btn primary block lg" style="margin-top:18px" data-act="backToLogin">Back to sign in</button>
    </div>`);
}
async function showReset(token) {
  let who;
  try { who = await api('GET', `/api/password/reset/${encodeURIComponent(token)}`); } catch (err) {
    authShell(`<div class="auth-form">${authHead('Link expired', esc(err.message))}
      <button type="button" class="btn primary block lg" data-act="forgotPassword">Send a new link</button>
      <button type="button" class="btn ghost block" style="margin-top:10px" data-act="backToLogin">Back to sign in</button></div>`);
    return;
  }
  authShell(`<form class="auth-form" data-submit="resetPassword" data-token="${esc(token)}">
      ${authHead('Choose a new password', `For <b>${esc(who.name)}</b> (@${esc(who.username)}). You’ll be signed out of every other device.`)}
      <label class="field"><span>New password</span><input class="input" name="password" type="password" required minlength="6" autocomplete="new-password"></label>
      <label class="field"><span>Repeat new password</span><input class="input" name="confirm" type="password" required minlength="6" autocomplete="new-password"></label>
      ${formErr}
      <button class="btn primary block lg">Save and sign in ${ic('arrow')}</button>
    </form>`);
}
// After signing in with a temporary password the user must pick their own before using the app.
function showForceChange() {
  const known = !!S.loginPassword;
  authShell(`<form class="auth-form" data-submit="forceChange">
      ${authHead('Set your own password', `Hi ${esc(S.user.name.split(' ')[0])}, you signed in with a temporary password. Choose a new one to continue.`)}
      ${known ? '' : '<label class="field"><span>Temporary password</span><input class="input" name="current" type="password" required autocomplete="current-password"></label>'}
      <label class="field"><span>New password</span><input class="input" name="password" type="password" required minlength="6" autocomplete="new-password"></label>
      <label class="field"><span>Repeat new password</span><input class="input" name="confirm" type="password" required minlength="6" autocomplete="new-password"></label>
      ${formErr}
      <button class="btn primary block lg">Save and continue ${ic('arrow')}</button>
      <button type="button" class="btn ghost block" style="margin-top:10px" data-act="logout">Log out</button>
    </form>`);
}
function signIn({ token, user }) {
  S.token = token; S.user = user;
  store.set('dq_token', token);
  startApp();
}
async function logout(expired = false) {
  const token = S.token;
  stopPolling(); setLive(false);
  while (stack.length) closeTop(true);
  closeNotes(true);
  try {
    const sub = await (await navigator.serviceWorker?.ready)?.pushManager?.getSubscription();
    if (sub && token && !expired) await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  } catch { /* ignore */ }
  if (token && !expired) api('POST', '/api/logout').catch(() => {});
  S.token = null; S.user = null; S.pushOn = false; S.loginPassword = null; S.notes.list = null;
  store.set('dq_token', null);
  if (expired) toast('Your session ended. Please sign in again.', 'bad');
  history.replaceState(null, '', '#/');
  boot();
}
function startApp() {
  if (S.user.must_change_password) { showForceChange(); return; }
  mountShell();
  if (!location.hash || location.hash === '#/') history.replaceState(null, '', `#/${defaultRoute()}`);
  renderView();
  startPolling();
  if ('Notification' in window && Notification.permission === 'granted') subscribePush().catch(() => {});
}
async function boot() {
  const reset = location.hash.match(/^#\/reset\/([0-9a-f]{64})$/);
  if (reset) { showReset(reset[1]); return; }
  if (S.token) {
    try {
      const d = await api('GET', '/api/me');
      S.user = d.user; S.unread = d.unread; S.currency = d.currency || 'INR'; S.emailReset = !!d.email_reset;
      return startApp();
    } catch (err) {
      if (err.status === 0) {
        $('#app').innerHTML = `<div class="boot"><div class="card" style="max-width:380px">${empty('alert', 'Can’t reach the server', 'Check your internet connection.', '<button class="btn primary" onclick="location.reload()">Try again</button>')}</div></div>`;
        return;
      }
      S.token = null; store.set('dq_token', null);
    }
  }
  try { const { needsSetup } = await api('GET', '/api/setup'); showAuth(needsSetup); } catch { showAuth(false); }
}

// ------------------------------------------------------------------ PWA: service worker + install prompt
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) {
      const m = e.data.url.match(/#\/task\/(\d+)/);
      if (m && S.user) openTask(m[1]); else if (S.user) location.hash = e.data.url.replace(/^.*#/, '#');
    }
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.installEvt = e;
  $$('[data-install]').forEach((b) => b.classList.remove('hidden'));
  if (current?.r.name === 'settings') paint();
});
window.addEventListener('appinstalled', () => { S.installEvt = null; $$('[data-install]').forEach((b) => b.classList.add('hidden')); toast('App installed ✓', 'ok'); });

registerFinance({
  S, VIEWS, ACT, SUBMIT, INPUT, CHANGE, $, $$, esc, ic, logo, avatar, empty, plural, linkify, api, toast, ask, go, paint,
  scheduleRefresh, openModal, closeModalObj, modalOf, isMobile, cur: () => current,
});
registerBotUI({ S, VIEWS, ACT, SUBMIT, api, toast, esc, ic, empty, plural, timeAgo, scheduleRefresh, cur: () => current });
boot();
