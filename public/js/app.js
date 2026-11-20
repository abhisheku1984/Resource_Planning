/* =========================================================================
   App shell: authentication, navigation structure, routing.
   ========================================================================= */
import {
  h, mount, icon, api, state, setToken, toast, closeModal, navigate,
  setRouteFromHash, initials, spinner, emptyState,
} from './core.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderWorkspace } from './views/workspace.js';
import { renderDirectory } from './views/directory.js';
import { renderDataHub } from './views/datahub.js';
import { renderAdmin } from './views/admin.js';
import { renderAudit } from './views/audit.js';

const root = document.getElementById('root');

/* ---------------------------------------------------------------- navigation */
const NAV = [
  { section: 'Overview' },
  { name: 'dashboard', label: 'Dashboard', icon: 'layout' },
  { section: 'Workforce' },
  { name: 'workspace', label: 'Project Workspace', icon: 'layers', badge: 'projects' },
  { name: 'directory', label: 'Employee Directory', icon: 'users', badge: 'employees' },
  { section: 'Operations' },
  { name: 'datahub', label: 'Data Hub', icon: 'table', after: 'datahub' },
  { name: 'audit', label: 'Audit Trail', icon: 'history' },
  { section: 'Administration', adminOnly: true },
  { name: 'admin', label: 'Administration', icon: 'settings', adminOnly: true, after: 'admin' },
  { name: 'access', label: 'Users & Access', icon: 'shield', adminOnly: true, after: 'access' },
];

let shellBuilt = false;
let crmCollapsed = false;

const counts = () => {
  const employees = new Set();
  let projects = 0;
  let subprojects = 0;
  for (const p of state.tree) {
    projects += 1;
    for (const s of p.subprojects) {
      subprojects += 1;
    }
  }
  return { projects, subprojects, employees: state.totals?.employees || 0 };
};

async function boot() {
  setRouteFromHash();
  if (!state.token) return renderLogin(root, onAuthed);
  try {
    await loadBootstrap();
    buildShell();
    renderRoute();
  } catch (err) {
    if (err.status === 401 || err.status === 0) {
      setToken(null);
      renderLogin(root, onAuthed, err.status === 0 ? 'Cannot reach the server. Check your connection and try again.' : '');
      return;
    }
    mount(root, h('div', { class: 'empty' },
      emptyState({ title: 'Could not load the workspace', message: err.message, iconName: 'alert' }),
      h('button', { class: 'btn btn-primary', onclick: () => boot() }, 'Retry'),
    ));
  }
}

async function loadBootstrap() {
  const data = await api('/bootstrap');
  state.user = data.user;
  state.tree = data.tree;
  state.fields = data.fields;
  state.suppliers = data.suppliers;
  state.totals = data.totals;
  state.statusCounts = data.statusCounts;
}

function onAuthed() {
  loadBootstrap().then(() => {
    buildShell();
    if (!location.hash) navigate('dashboard');
    else { setRouteFromHash(); renderRoute(); }
  }).catch((err) => {
    toast('Sign-in issue', err.message, 'error');
    setToken(null);
    renderLogin(root, onAuthed);
  });
}

/* ---------------------------------------------------------------- shell */
function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' });
  const main = h('div', { class: 'main' });
  const topbar = h('header', { class: 'topbar' });
  const content = h('div', { id: 'content' });
  main.append(topbar, content);
  mount(root, h('div', { class: 'app' }, sidebar, main));
  shellBuilt = true;
  renderSidebar();
  renderTopbar();
}

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const c = counts();
  const user = state.user || {};
  const active = state.route.name;

  const items = NAV.filter((n) => !n.adminOnly || user.isAdmin).map((n) => {
    if (n.section) {
      if (n.section === 'Administration' && !user.isAdmin) return null;
      return h('div', { class: 'nav-section' }, n.section);
    }
    let badge = null;
    if (n.badge === 'projects') badge = c.projects;
    if (n.badge === 'employees') badge = state.totals?.employees;
    return h('button', {
      class: `nav-item ${active === n.name || (n.name === 'admin' && active === 'access') ? 'active' : ''}`,
      onclick: () => { go(n.name); sidebar.classList.remove('open'); },
    },
      icon(n.icon, 16),
      h('span', { class: 'grow' }, n.label),
      n.name === 'datahub' && state.totals?.pendingReviews
        ? h('span', { class: 'count-pill', title: 'Pending duplicate reviews' }, state.totals.pendingReviews)
        : badge !== null && badge !== undefined ? h('span', { class: 'count-pill' }, badge) : null,
    );
  });

  mount(sidebar,
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, 'RP'),
      h('div', { class: 'brand-text' },
        h('div', { class: 'brand-name' }, 'Resource Planning'),
        h('div', { class: 'brand-sub' }, user.isAdmin ? 'Administrator' : 'Supervisor'),
      ),
    ),
    h('nav', { class: 'nav', 'aria-label': 'Primary' }, items),
    h('div', { class: 'sidebar-foot' },
      h('button', {
        class: 'user-chip',
        onclick: () => openAccountPanel(),
        title: 'Account and session',
      },
        h('div', { class: 'avatar' }, initials(user.name)),
        h('div', { class: 'user-meta' },
          h('div', { class: 'user-name truncate' }, user.name || 'Signed in'),
          h('div', { class: 'user-role truncate' }, user.title || (user.isAdmin ? 'Administrator' : 'Supervisor')),
        ),
        icon('logout', 15),
      ),
    ),
  );
}

function renderTopbar() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  topbar.replaceChildren(
    h('button', {
      class: 'btn btn-ghost btn-icon menu-btn',
      'aria-label': 'Toggle navigation',
      onclick: () => document.getElementById('sidebar').classList.toggle('open'),
    }, icon('menu', 18)),
    h('div', { class: 'crumbs grow', id: 'crumbs' }),
    h('div', { class: 'row', style: { gap: '8px' } },
      h('button', {
        class: 'btn btn-ghost btn-icon',
        title: 'Refresh data',
        'aria-label': 'Refresh data',
        onclick: () => refreshAll(),
      }, icon('refresh', 16)),
      h('div', { class: 'avatar avatar-sm', title: state.user?.name }, initials(state.user?.name || '')),
    ),
  );
  renderCrumbs();
}

export function setCrumbs(items) {
  const host = document.getElementById('crumbs');
  if (!host) return;
  const out = [];
  items.forEach((item, i) => {
    if (i) out.push(h('span', { class: 'sep' }, '/'));
    out.push(h('span', {
      class: `crumb ${i === items.length - 1 ? 'current' : ''}`,
      ...(item.onclick ? { onclick: item.onclick } : {}),
    }, item.label));
  });
  mount(host, out);
}

function renderCrumbs() {
  const r = state.route;
  const map = {
    dashboard: ['Dashboard'],
    workspace: ['Project Workspace'],
    directory: ['Employee Directory'],
    datahub: ['Data Hub'],
    audit: ['Audit Trail'],
    admin: ['Administration'],
    access: ['Administration', 'Users & Access'],
  };
  const base = map[r.name] || ['Workspace'];
  setCrumbs(base.map((label, i) => ({
    label,
    onclick: i < base.length - 1 ? () => go(i === 0 ? 'dashboard' : 'admin') : null,
  })));
}

const go = (name, params = {}) => {
  location.hash = `#/${name}`;
  if (params && Object.keys(params).length) {
    const qs = new URLSearchParams(params).toString();
    location.hash = `#/${name}?${qs}`;
  }
};

async function refreshAll() {
  const btn = document.querySelector('.topbar .btn-icon');
  try {
    await loadBootstrap();
    renderSidebar();
    renderRoute();
    toast('Refreshed', 'Latest data loaded from the database.', 'success', 2000);
  } catch (err) {
    toast('Refresh failed', err.message, 'error');
  }
}

/* ---------------------------------------------------------------- routing */
function renderRoute() {
  const content = document.getElementById('content');
  if (!content) return;
  closeModal();
  renderSidebar();
  renderCrumbs();
  const r = state.route;
  const ctx = { content, setCrumbs, reload: renderRoute, crmCollapsed };

  switch (r.name) {
    case 'dashboard':
      renderDashboard(content, ctx);
      break;
    case 'workspace':
      renderWorkspace(content, { ...ctx, params: r.params });
      break;
    case 'directory':
      renderDirectory(content, ctx);
      break;
    case 'datahub':
      renderDataHub(content, ctx);
      break;
    case 'audit':
      renderAudit(content, ctx);
      break;
    case 'admin':
    case 'access':
      renderAdmin(content, { ...ctx, tab: r.name === 'access' ? 'access' : (r.params.tab || 'hierarchy') });
      break;
    default:
      renderDashboard(content, ctx);
  }
}

/* ---------------------------------------------------------------- account */
function openAccountPanel() {
  import('./views/account.js').then((m) => m.openAccountModal());
}

/* ---------------------------------------------------------------- events */
window.addEventListener('hashchange', () => {
  if (!shellBuilt) return;
  setRouteFromHash();
  renderRoute();
});

window.addEventListener('rp:navigate', () => { if (shellBuilt) renderRoute(); });

// keep the shared reference to nav helper used by views
export const router = { go, navigate, setCrumbs, refresh: refreshAll };

window.__rp = { go, navigate, setCrumbs, refreshAll, state };

boot();
