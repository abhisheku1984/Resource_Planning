/* =========================================================================
   Core: tiny helpers, icon set, API client, toast + modal infrastructure.
   No framework — a small reactive render loop keeps the bundle dependency free
   and the interaction model predictable for non-technical supervisors.
   ========================================================================= */
'use strict';

export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
};

function append(el, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

export const mount = (el, ...children) => {
  el.replaceChildren();
  append(el, children);
  return el;
};

export const svg = (paths, size = 16, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${extra || 1.9}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  contact: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2.4"/><path d="M5.6 17c.6-1.9 2-2.8 3.4-2.8s2.8.9 3.4 2.8"/><path d="M15.5 9.5h3M15.5 13h3"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.5 2.5 4.5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  sortAsc: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  sortDesc: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M7 3v6h8V3M7 21v-7h10v7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  truck: '<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.3a2 2 0 0 0-.6-1.4L18 9h-4v8h3"/><circle cx="7.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 9-9M17 3l4 4M14.5 5.5 18 9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.9 3.7M6.3 6.3A17 17 0 0 0 2 12s3.6 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M2 2l20 20"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  pie: '<path d="M21.2 15.9A10 10 0 1 1 8.1 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  warning: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9Z"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  sparkles: '<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
};

export const icon = (name, size = 16) => {
  const el = document.createElement('span');
  el.style.display = 'inline-flex';
  el.style.alignItems = 'center';
  el.innerHTML = svg(ICONS[name] || ICONS.info, size);
  return el.firstElementChild;
};

export const iconSvg = (name, size = 16) => svg(ICONS[name] || ICONS.info, size);

/* ------------------------------ formatting ------------------------------ */
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
export const fmtRelative = (iso) => {
  if (!iso) return '—';
  const then = new Date(iso.replace(' ', 'T') + (iso.includes('T') ? '' : 'Z')).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';

export const debounce = (fn, ms = 300) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/* ------------------------------ API client ------------------------------ */
const TOKEN_KEY = 'rp.token';

export const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  tree: [],
  fields: [],
  suppliers: [],
  // columns the CRM / Update panel shows (from /bootstrap, admin-configurable)
  crmKeys: [],
  route: { name: 'dashboard', params: {} },
};

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Network unavailable. Your changes were not saved.', 0, { offline: true });
  }
  if (res.status === 401) {
    setToken(null);
    throw new ApiError('Your session expired. Please sign in again.', 401, {});
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * Downloads any authenticated workbook route (export, blank import template) as
 * a file. The route decides the name through Content-Disposition.
 */
export async function downloadWorkbook(path, query, fallbackName = 'download.xlsx') {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== null && v !== undefined && v !== '') params.set(k, v);
  const res = await fetch(`${path}?${params}`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || 'Download failed.', res.status, data);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { filename };
}

export async function downloadExport(query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) { for (const value of v) params.append(`${k}[]`, value); }
    else if (v !== null && v !== undefined && v !== '') params.set(k, v);
  }
  const res = await fetch(`/api/export?${params}`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || 'Export failed.', res.status, data);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : 'resource-planning.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { filename, rows: Number(res.headers.get('X-Export-Rows') || 0) };
}

/* ------------------------------ toasts ------------------------------ */
const toastHost = () => {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
};

export function toast(title, message = '', kind = 'info', ms = 4200) {
  const iconName = kind === 'success' ? 'checkCircle' : kind === 'error' ? 'alert' : kind === 'warn' ? 'warning' : 'info';
  const el = h('div', { class: `toast ${kind}` },
    h('span', { class: 'toast-icon' }, icon(iconName, 16)),
    h('div', { class: 'grow' },
      h('div', { class: 'toast-title' }, title),
      message ? h('div', { class: 'toast-msg' }, message) : null,
    ),
    h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'),
  );
  toastHost().appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 200); }, ms);
  return el;
}

/* ------------------------------ modal ------------------------------ */
let openModal = null;

export function modal({ title, subtitle, body, footer, size = '', onClose = null, dismissable = true }) {
  closeModal();
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
  const box = h('div', { class: `modal ${size}` },
    h('div', { class: 'modal-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'modal-title' }, title),
        subtitle ? h('div', { class: 'modal-sub' }, subtitle) : null,
      ),
      h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onclick: () => closeModal() }, icon('x', 16)),
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  overlay.appendChild(box);
  if (dismissable) {
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  }
  const esc = (e) => { if (e.key === 'Escape' && dismissable) closeModal(); };
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
  openModal = { overlay, onClose, esc };
  const focusable = box.querySelector('input, select, textarea, button.btn-primary');
  if (focusable) setTimeout(() => focusable.focus(), 40);
  return { box, close: closeModal };
}

export function closeModal() {
  if (!openModal) return;
  const { overlay, onClose, esc } = openModal;
  document.removeEventListener('keydown', esc);
  overlay.remove();
  openModal = null;
  if (onClose) onClose();
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    modal({
      title,
      body: h('p', { class: 'muted', style: { fontSize: '13px', lineHeight: '1.6' } }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, confirmLabel),
      ],
      onClose: () => done(false),
    });
  });
}

/* ------------------------------ misc ------------------------------ */
export const saveStateIndicator = (kind, label) =>
  h('span', { class: `save-state ${kind}` }, h('span', { class: 'dot' }), label);

export const spinner = (large = false) => h('span', { class: `spinner ${large ? 'spinner-lg' : ''}` });

export const emptyState = ({ title, message, action, iconName = 'folder' }) =>
  h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, 22)),
    h('div', { class: 'empty-title' }, title),
    message ? h('div', { class: 'empty-body' }, message) : null,
    action || null,
  );

export const statusBadge = (value) => {
  if (!value) return h('span', { class: 'badge badge-neutral' }, '—');
  const map = {
    Active: 'success', Completed: 'success', Billable: 'success', Allocated: 'success',
    'On Leave': 'warn', Training: 'info', Shadow: 'info', 'Partially Allocated': 'warn',
    'Billing Hold': 'danger', Released: 'danger', Failed: 'danger', Dropped: 'danger',
    Bench: 'warn', 'In Progress': 'info', 'Not Started': 'neutral', Pending: 'warn', Partial: 'warn',
    'Non-Billable': 'neutral', 'Rolling Off': 'warn', Waived: 'neutral',
  };
  const kind = map[value] || 'neutral';
  return h('span', { class: `badge badge-${kind}` }, h('span', { class: 'dot' }), value);
};

export const navigate = (name, params = {}) => {
  state.route = { name, params };
  window.dispatchEvent(new CustomEvent('rp:navigate'));
};

export const setRouteFromHash = () => {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, qs] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const name = parts[0] || 'dashboard';
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  if (parts[1]) params.id = parts[1];
  state.route = { name, params };
};

export const go = (path) => { location.hash = path.startsWith('#') ? path : `#${path}`; };
