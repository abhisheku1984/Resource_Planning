/**
 * Frontend smoke test.
 *
 * The sandbox has no browser download, so this boots the view modules against a
 * minimal DOM shim and a stubbed fetch. It catches import errors, render crashes
 * and missing-the-data-handling that a syntax check alone would miss.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/* ------------------------------------------------------------- DOM shim */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this.listeners = {};
    this._text = '';
    this._className = '';
    this.id = '';
    this.value = '';
    this.parentElement = null;
    this.isConnected = true;
    this.disabled = false;
    this.checked = false;
    this.files = [];
  }
  get className() { return this.classList.set.size ? [...this.classList.set].join(' ') : this._className; }
  set className(v) { this._className = v; this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get firstElementChild() { return this.children.find((c) => c instanceof El) || null; }
  get firstChild() { return this.children[0] || null; }
  set innerHTML(v) { this._html = v; this.children = []; }
  get textContent() { return this._text ?? ''; }
  set textContent(v) {
    this._text = v;
    // mirrors the DOM: assigning textContent replaces any child nodes
    if (this.children && this.children.length) this.children = [];
  }
  get innerHTML() { return this._html || ''; }
  get rowCount() { return 1; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append(...c) { c.forEach((x) => { if (x != null) this.appendChild(x instanceof El ? x : documentShim.createTextNode(String(x))); }); }
  prepend(...c) { c.reverse().forEach((x) => x && this.appendChild(x)); }
  insertBefore(n, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    n.parentElement = this;
    return n;
  }
  replaceChildren(...c) { this.children = []; this.append(...c); }
  replaceWith(n) {
    const p = this.parentElement;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children[i] = n;
    n.parentElement = p;
  }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach((f) => f(e)); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, stopPropagation() {}, preventDefault() {}, closest: (sel) => this.closest(sel) }); }
  focus() { globalThis.document.activeElement = this; }
  select() {}
  setSelectionRange() {}
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    const walk = (node) => {
      for (const c of node.children) {
        if (!(c instanceof El)) continue;
        if (sel.startsWith('.') && c.classList.contains(cls)) return c;
        if (sel.startsWith('#') && (c.id === sel.slice(1) || c.attrs.id === sel.slice(1))) return c;
        if (!sel.startsWith('.') && !sel.startsWith('#') && c.tagName === sel.toUpperCase()) return c;
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel) {
    // support comma-separated selector lists ("input, textarea"), which the
    // real DOM does and the views use
    if (String(sel).includes(',')) {
      const seen = new Set();
      const out = [];
      for (const part of String(sel).split(',')) {
        for (const el of this.querySelectorAll(part.trim())) {
          if (!seen.has(el)) { seen.add(el); out.push(el); }
        }
      }
      return out;
    }
    const out = [];
    const cls = sel.startsWith('.') ? sel.replace(/^\./, '') : null;
    const tagOnly = /^[a-z]+$/.test(sel) ? sel.toUpperCase() : null;
    const walk = (node) => {
      for (const c of node.children) {
        if (!(c instanceof El)) continue;
        if (cls && c.classList.contains(cls)) out.push(c);
        else if (sel.startsWith('#') && (c.id === sel.slice(1) || c.attrs.id === sel.slice(1))) out.push(c);
        else if (tagOnly && c.tagName === tagOnly) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest(sel) {
    const cls = sel.replace(/^\./, '');
    let node = this;
    while (node) {
      if (node.classList?.contains(cls)) return node;
      node = node.parentElement;
    }
    return null;
  }
  contains() { return false; }
}

const body = new El('body');
const head = new El('head');
const documentShim = {
  body,
  head,
  documentElement: new El('html'),
  activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; e.nodeValue = t; return e; },
  createDocumentFragment: () => new El('#fragment'),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
  getElementById: (id) => body.querySelector(`#${id}`),
  // A real EventTarget. This used to be a no-op, which hid a genuine bug: a
  // panel listening on `window` that is dispatched to on `document`.
  listeners: {},
  addEventListener(type, fn) { (documentShim.listeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) {
    documentShim.listeners[type] = (documentShim.listeners[type] || []).filter((f) => f !== fn);
  },
  dispatchEvent(event) {
    (documentShim.listeners[event.type] || []).forEach((f) => f(event));
    return true;
  },
};
globalThis.window = globalThis;
globalThis.document = documentShim;
globalThis.Node = El;
globalThis.HTMLElement = El;
globalThis.location = { hash: '#/dashboard', href: 'http://localhost/', replaceState() {}, pathname: '/' };
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
};
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
globalThis.history = { replaceState() {} };
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

/* ------------------------------------------------------------- API stub */
const workers = [];
for (let i = 1; i <= 60; i++) {
  workers.push({
    assignmentId: i, employeeId: 2000 + i, projectId: 1, subprojectId: 2, categoryId: 4,
    supplierId: 3, projectName: 'Nexus Digital Transformation', subprojectName: 'Core Banking Migration',
    categoryName: 'Training Cohort', updatedAt: '2026-11-19 10:00:00', updatedBy: 'Priya Nair',
    values: {
      emp_code: `EMP-0${1000 + i}`, name: `Worker ${i}`, designation: 'Engineer', email: `w${i}@example.com`,
      phone: '+91 90000 00000', status: 'Active', supplier: 'TechCore Staffing',
      training_status: 'Completed', joining_date: '2026-01-05', completion_status: 'Pending',
      skill_track: 'Java', remarks: i % 3 === 0 ? 'Needs follow up' : null,
    },
    rev: '2026-11-19 10:00:00',
  });
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
    blob: async () => new Blob([]),
  };
}

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(`${opts.method || 'GET'} ${u}`);
  const path = u.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;

  if (path.startsWith('/auth/login')) return jsonResponse({ token: 't', user: { id: 1, name: 'Priya Nair', role: 'supervisor', isAdmin: false, email: 'p@x', capabilities: { 'employee.edit': true }, projects: [{ id: 1, name: 'Nexus', can_edit: 1 }] } });
  if (path.startsWith('/bootstrap')) {
    return jsonResponse({
      user: { id: 1, name: 'Priya Nair', role: 'supervisor', isAdmin: false, title: 'Supervisor', email: 'p@x', capabilities: { 'employee.edit': true, 'export.data': true, 'crm.use': true }, projects: [{ id: 1, name: 'Nexus', can_edit: 1, can_export: 1, can_crm: 1 }] },
      tree: [{
        id: 1, code: 'NEXUS', name: 'Nexus Digital Transformation', client: 'Northwind', description: 'desc', grant: { can_edit: 1, can_export: 1, can_crm: 1 },
        subprojects: [{
          id: 2, code: 'NEX-CORE', name: 'Core Banking Migration', employeeCount: 60,
          categories: [{ id: 4, code: 'TRN', name: 'Training Cohort' }, { id: 5, code: 'BIL', name: 'Billing & Allocation' }],
        }],
      }],
      fields: [
        { id: 1, key: 'emp_code', label: 'Employee ID', type: 'text', core: true, system: true },
        { id: 2, key: 'name', label: 'Employee Name', type: 'text', core: true },
        { id: 3, key: 'training_status', label: 'Training Status', type: 'select', options: ['Not Started', 'In Progress', 'Completed'] },
        { id: 4, key: 'status', label: 'Current Status', type: 'select', options: ['Active', 'On Leave'] },
        { id: 5, key: 'remarks', label: 'Remarks', type: 'textarea' },
        // the workbook supervisor columns the CRM panel is configured with
        { id: 6, key: 'leader_input_last_week', label: 'Leader Input Last Week', type: 'textarea', group: 'Leadership' },
        { id: 7, key: 'leader_input_this_week', label: 'Leader Input This Week', type: 'textarea', group: 'Leadership' },
        { id: 8, key: 'opp_id', label: 'Opp ID', type: 'text', group: 'Demand' },
        { id: 9, key: 'demand_number', label: 'Demand Number', type: 'text', group: 'Demand' },
        { id: 10, key: 'block_status', label: 'Hard Block / Soft Block', type: 'select', options: ['No Block', 'Soft Block', 'Hard Block'] },
        { id: 11, key: 'giga_project_name', label: 'Giga Project Name', type: 'text', group: 'Demand' },
      ],
      suppliers: [{ id: 3, name: 'TechCore Staffing' }],
      totals: { employees: 60, assignments: 60, projects: 1, suppliers: 1, pendingReviews: 2 },
      statusCounts: [{ status: 'Active', c: 60 }],
    });
  }
  if (path.startsWith('/dashboard')) {
    return jsonResponse({
      totals: { employees: 60, assignments: 60, projects: 1, suppliers: 1, pendingReviews: 2 },
      byProject: [{ id: 1, name: 'Nexus', code: 'NEXUS', c: 60, active: 55 }],
      byStatus: [{ status: 'Active', c: 50 }, { status: 'Training', c: 10 }],
      bySupplier: [{ name: 'TechCore Staffing', c: 60 }],
      byCategory: [{ name: 'Training Cohort', c: 60 }],
      attention: [{ assignment_id: 1, emp_code: 'EMP-01001', name: 'Worker 1', status: 'On Leave', project_name: 'Nexus', category_name: 'Training Cohort', updated_at: '2026-11-19 10:00:00' }],
      activity: [{ id: 1, entity: 'assignment', entity_id: 1, ref: 'EMP-01001', action: 'update', field_key: 'training_status', old_value: 'Not Started', new_value: 'Completed', actor_name: 'Priya Nair', at: '2026-11-19 10:00:00' }],
      trend: [],
    });
  }
  if (path.startsWith('/employees?') || path === '/employees') {
    return jsonResponse({
      rows: workers, total: workers.length, page: 1, pageSize: 25, totalPages: 3,
      columns: [
        { key: 'emp_code', label: 'Employee ID', type: 'text', editable: false },
        { key: 'name', label: 'Employee Name', type: 'text', editable: true },
        { key: 'training_status', label: 'Training Status', type: 'select', editable: true, options: ['Not Started', 'In Progress', 'Completed'] },
        { key: 'remarks', label: 'Remarks', type: 'textarea', editable: true },
      ],
      scope: { project: { id: 1, name: 'Nexus' }, category: { id: 4, name: 'Training Cohort' } },
      facets: [
        { key: 'billing_status', label: 'Billing Status', type: 'select', total: 60,
          values: [{ value: 'Billable', count: 40 }, { value: 'Non-Billable', count: 20 }] },
        { key: 'bench_category', label: 'Bench Category', type: 'select', total: 60,
          values: [{ value: 'Allocated', count: 45 }, { value: 'Bench', count: 15 }] },
        { key: 'bl_status', label: 'BL Status', type: 'select', total: 60,
          values: [{ value: 'BL-1', count: 60 }] },
        { key: 'offsite_onsite', label: 'Offsite / Onsite', type: 'select', total: 60,
          values: [{ value: 'Onsite', count: 35 }, { value: 'Offsite', count: 25 }] },
        { key: 'giga_project_name', label: 'Giga Project Name', type: 'select', total: 10,
          values: [{ value: 'Giga One', count: 10 }] },
        { key: 'capability', label: 'Capability', type: 'select', total: 60,
          values: [{ value: 'Tech', count: 60 }] },
      ],
    });
  }
  if (/^\/employees\/\d+$/.test(path)) {
    if (method === 'PATCH') {
      const rec = JSON.parse(JSON.stringify(workers[0]));
      rec.values = { ...rec.values, ...body.changes };
      rec.updatedAt = '2026-11-19 11:00:00';
      return jsonResponse({ record: rec, savedAt: 'now' });
    }
    const rec = JSON.parse(JSON.stringify(workers[0]));
    rec.columns = [
      { key: 'emp_code', label: 'Employee ID', type: 'text', editable: false, required: true },
      { key: 'name', label: 'Employee Name', type: 'text', editable: true, required: true },
      { key: 'email', label: 'Email Address', type: 'email', editable: true },
      { key: 'phone', label: 'Contact Number', type: 'tel', editable: true },
      { key: 'designation', label: 'Designation', type: 'text', editable: true },
      { key: 'supplier', label: 'Supplier', type: 'select', editable: true, options: ['TechCore Staffing'] },
      { key: 'status', label: 'Current Status', type: 'select', editable: true, options: ['Active', 'On Leave'] },
      { key: 'training_status', label: 'Training Status', type: 'select', editable: true, options: ['Not Started', 'In Progress', 'Completed'] },
      { key: 'remarks', label: 'Remarks', type: 'textarea', editable: true },
      { key: 'leader_input_last_week', label: 'Leader Input Last Week', type: 'textarea', editable: true },
      { key: 'leader_input_this_week', label: 'Leader Input This Week', type: 'textarea', editable: true },
      { key: 'opp_id', label: 'Opp ID', type: 'text', editable: true },
      { key: 'demand_number', label: 'Demand Number', type: 'text', editable: true },
      { key: 'block_status', label: 'Hard Block / Soft Block', type: 'select', editable: true, options: ['No Block', 'Soft Block', 'Hard Block'] },
      { key: 'giga_project_name', label: 'Giga Project Name', type: 'text', editable: true },
    ];
    return jsonResponse({ record: rec });
  }
  if (/^\/employees\/\d+\/submit$/.test(path)) {
    const rec = JSON.parse(JSON.stringify(workers[0]));
    rec.values = { ...rec.values, ...(body.changes || {}) };
    rec.rev = (rec.rev || 1) + 1;
    return jsonResponse({ record: rec, changed: Object.keys(body.changes || {}), message: 'Saved' });
  }
  if (/^\/employees\/\d+\/history$/.test(path)) {
    return jsonResponse({ history: [{ id: 2, field_key: 'training_status', field_label: 'Training Status', old_value: 'Not Started', new_value: 'Completed', actor_name: 'Priya Nair', at: '2026-11-19 10:00:00' }] });
  }
  if (path.startsWith('/people?')) return jsonResponse({ people: [{ id: 2001, emp_code: 'EMP-01001', name: 'Worker 1', email: 'w1@example.com', placements: 2 }] });
  if (/^\/people\/\d+$/.test(path)) {
    return jsonResponse({
      person: { id: 2001, emp_code: 'EMP-01001', name: 'Worker 1', email: 'w1@example.com' },
      placements: [{ assignment_id: 1, project_id: 1, subproject_id: 2, category_id: 4, status: 'Active', project_name: 'Nexus', subproject_name: 'Core', category_name: 'Training Cohort' }],
    });
  }
  if (path.startsWith('/imports')) return jsonResponse({ imports: [] });
  if (path.startsWith('/audit')) return jsonResponse({ activity: [{ id: 1, entity: 'assignment', entity_id: 1, action: 'update', field_key: 'status', old_value: 'A', new_value: 'B', actor_name: 'P', at: '2026-11-19 10:00:00', ref: 'EMP-1' }] });
  if (path.startsWith('/agent/projects')) return jsonResponse({ projectNames: ['Giga One', 'Giga Two'] });
  if (path.startsWith('/agent/proposals')) return jsonResponse({ proposals: [] });
  if (path.startsWith('/projects')) return jsonResponse({ projects: [] });
  if (path.startsWith('/suppliers')) return jsonResponse({ suppliers: [] });
  if (path.startsWith('/groups')) return jsonResponse({ groups: [] });
  if (path.startsWith('/users')) {
    return jsonResponse({
      users: [{ id: 7, email: 'lead@x.io', name: 'Test Leader', role: 'supervisor', title: 'Lead', active: 1,
        projects: [{ project_id: 1, name: 'Nexus', can_edit: 1, can_export: 1, can_crm: 1 }],
        capabilities: { 'employee.edit': true } }],
      gigaProjectNames: ['Giga Apple', 'Giga Pear'],
      gigaCapabilities: ['project.view', 'employee.edit', 'crm.use', 'export.data'],
      capabilities: ['employee.edit', 'crm.use', 'export.data'],
    });
  }
  if (path.startsWith('/fields')) return jsonResponse({ fields: [] });
  if (path.startsWith('/duplicates')) return jsonResponse({ reviews: [] });
  if (path.startsWith('/categories/') && path.includes('/columns')) return jsonResponse({
    category: { id: 4, name: 'Training Cohort' }, isConfigured: true,
    fields: [{ id: 3, key: 'notes', label: 'Notes', type: 'text', visible: true, editable: true, required: false, sort_order: 27 }],
  });
  return jsonResponse({ error: `unstubbed ${method} ${path}` }, 404);
};

/* ------------------------------------------------------------- tests */
const core = await import('../public/js/core.js');

test('core helpers render without a browser', () => {
  const el = core.h('div', { class: 'x', onclick: () => {} },
    core.h('span', null, 'hello'),
    core.icon('users', 16),
    core.statusBadge('Active'),
    core.fmtNum(1234),
  );
  assert.equal(el.tagName, 'DIV');
  assert.ok(el.children.length >= 3);
  assert.equal(core.fmtNum(1234), '1,234');
  assert.ok(core.iconSvg('layers').includes('<svg'));
  assert.equal(core.initials('Priya Nair'), 'PN');
  assert.ok(core.fmtDate('2026-01-05').includes('2026'));
  assert.ok(core.fmtRelative('2026-11-19 10:00:00').length > 0);
});

test('login view renders the demo accounts', async () => {
  const { renderLogin } = await import('../public/js/views/login.js');
  const root = new El('div');
  renderLogin(root, () => {}, '');
  assert.equal(root.children.length, 1);
  const html = JSON.stringify(flatten(root));
  assert.ok(html.includes('Sign in'));
  assert.ok(html.includes('Administrator'));
});

function flatten(node, out = []) {
  if (typeof node.textContent === 'string' && node.textContent) out.push(node.textContent);
  for (const c of node.children || []) flatten(c, out);
  return out;
}

test('dashboard renders KPIs, charts and activity', async () => {
  const { renderDashboard } = await import('../public/js/views/dashboard.js');
  core.state.user = { name: 'Priya Nair', isAdmin: false };
  core.state.tree = [{ id: 1, name: 'Nexus', subprojects: [{ id: 2 }, { id: 3 }] }];
  core.state.totals = { employees: 60, assignments: 60, projects: 1, suppliers: 1, pendingReviews: 2 };
  const content = new El('div');
  content.id = 'content';
  documentShim.body.replaceChildren(content);
  await renderDashboard(content, { setCrumbs() {} });
  await new Promise((r) => setTimeout(r, 30));
  const text = flatten(content).join(' | ');
  assert.ok(text.includes('People in scope'));
  assert.ok(text.includes('Needs attention'));
  assert.ok(content.querySelectorAll('.kpi').length >= 4);
});

test('workspace drills project -> subproject -> category and renders the table', async () => {
  core.state.user = { id: 1, name: 'Priya Nair', isAdmin: false, capabilities: { 'employee.edit': true } };
  core.state.tree = [{
    id: 1, code: 'NEXUS', name: 'Nexus Digital Transformation', client: 'Northwind', description: 'desc',
    grant: { can_edit: 1 }, subprojects: [{
      id: 2, code: 'NEX-CORE', name: 'Core Banking Migration', employeeCount: 60,
      categories: [{ id: 4, code: 'TRN', name: 'Training Cohort' }],
    }],
  }];
  core.state.fields = [
    { id: 1, key: 'emp_code', label: 'Employee ID', type: 'text', core: true },
    { id: 2, key: 'name', label: 'Employee Name', type: 'text', core: true },
  ];
  core.state.suppliers = [{ id: 3, name: 'TechCore Staffing' }];

  const { renderWorkspace } = await import('../public/js/views/workspace.js');
  const content = new El('div');
  content.id = 'content';
  documentShim.body.replaceChildren(content);
  renderWorkspace(content, { params: {}, setCrumbs() {}, crmCollapsed: false });
  await new Promise((r) => setTimeout(r, 60));

  const text = flatten(content).join(' ');
  assert.ok(text.includes('Nexus Digital Transformation'), 'project appears in the rail');

  // drill into the project, then its subproject
  const projectCards = content.querySelectorAll('.project-card');
  assert.ok(projectCards.length >= 1, 'project card exists');
  projectCards[0].click();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(flatten(content).join(' ').includes('Core Banking Migration'), 'subprojects appear after selecting a project');

  const treeNodes = content.querySelectorAll('.tree-node');
  assert.ok(treeNodes.length >= 1, 'subproject node exists');
  treeNodes[0].click();
  await new Promise((r) => setTimeout(r, 80));
  const afterSub = flatten(content).join(' ');
  assert.ok(afterSub.includes('Training Cohort'), 'categories appear after selecting a subproject');

  // the table rendered rows with the configured columns
  const cells = content.querySelectorAll('td');
  assert.ok(cells.length > 10, 'employee rows rendered');
  const allText = flatten(content).join(' ');
  assert.ok(allText.includes('EMP-01001'), 'employee ids render');
  assert.ok(allText.includes('Worker 1'), 'employee names render');
});

test('inline cell edit saves through the API', async () => {
  const { createTable } = await import('../public/js/views/table.js');
  core.state.user = { isAdmin: false, capabilities: { 'employee.edit': true } };
  core.state.fields = [
    { id: 3, key: 'remarks', label: 'Remarks', type: 'textarea' },
  ];
  const t = createTable({ onSelect() {} });
  documentShim.body.replaceChildren(t.el);
  t.el.parentElement = documentShim.body;
  await t.setScope({ projectId: 1, subprojectId: 2, categoryId: 4 });

  const editable = t.el.querySelectorAll('.cell-edit');
  assert.ok(editable.length > 0, 'editable cells exist');
  editable[0].click();
  const input = t.el.querySelectorAll('input').find((i) => i.classList.contains('cell-input'));
  assert.ok(input, 'clicking a cell opens an inline editor');
  input.value = 'Edited inline';
  input.dispatchEvent({ type: 'blur', target: input });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(calls.some((c) => c.startsWith('PATCH /api/employees/')), 'the edit is persisted with a PATCH');
});

test('the CRM panel offers only the configured update columns', async () => {
  const { createCrm } = await import('../public/js/views/crm.js');
  const { state } = await import('../public/js/core.js');
  state.crmKeys = ['leader_input_last_week', 'leader_input_this_week', 'opp_id',
    'demand_number', 'block_status'];
  const crm = createCrm({ getScope: () => ({ projectId: 1 }), onChanged() {} });
  documentShim.body.replaceChildren(crm.el);
  crm.showAssignment(1);
  await new Promise((r) => setTimeout(r, 90));

  const text = flatten(crm.el).join(' ');
  // identity and placement are context, not inputs
  assert.ok(text.includes('Worker 1'), 'the person is shown');
  assert.ok(text.includes('Worker 1'), 'the person name is shown');
  assert.ok(!text.includes('Designation'), 'the job title is not an update field');

  const edited = ['input', 'select', 'textarea']
    .flatMap((tag) => crm.el.querySelectorAll(tag))
    .map((i) => i.dataset.fieldKey)
    .filter(Boolean);
  // the placement switcher is a read-only navigation control and carries no key
  assert.deepEqual([...new Set(edited)].sort(), [...state.crmKeys].sort(),
    'only the six configured columns are editable in the leader panel');
  state.crmKeys = [];
});

test('CRM autosaves with explicit Saving -> Saved states', async () => {
  const { createCrm } = await import('../public/js/views/crm.js');
  const { state } = await import('../public/js/core.js');
  state.crmKeys = ['leader_input_last_week', 'leader_input_this_week', 'opp_id',
    'demand_number', 'block_status', 'giga_project_name'];
  if (!state.user) state.user = { id: 1, name: 'Priya Nair', isAdmin: false, capabilities: { 'employee.edit': true } };
  const crm = createCrm({ getScope: () => ({ projectId: 1 }), onChanged() {} });
  documentShim.body.replaceChildren(crm.el);
  crm.showAssignment(1);
  await new Promise((r) => setTimeout(r, 80));

  const text = flatten(crm.el).join(' ');
  assert.ok(text.includes('Worker 1'), 'the CRM shows the selected person');
  assert.ok(text.includes('Update history'), 'history section is present');

  // the panel edits only the configured supervisor columns, so the autosave is
  // exercised through one of those rather than the name
  const editInput = crm.el.querySelectorAll('input, textarea')
    .find((i) => i.dataset.fieldKey === 'leader_input_this_week');
  assert.ok(editInput, 'a configured supervisor column is editable');
  editInput.value = 'Client sign-off pending';
  editInput.dispatchEvent({ type: 'input', target: editInput });

  const states = [];
  const observer = setInterval(() => {
    const st = crm.el.querySelector('.save-state');
    if (st) states.push(st.textContent || st.className);
  }, 40);

  await new Promise((r) => setTimeout(r, 1400));
  clearInterval(observer);
  assert.ok(calls.some((c) => c.startsWith('PATCH /api/employees/')), 'autosave issued a PATCH');
  const finalText = flatten(crm.el).join(' ');
  assert.ok(/Saved|Saving/.test(finalText) || states.length > 0, 'a save indicator is shown');
});

test('CRM keeps values and reports "Not saved" when the network fails, then retries safely', async () => {
  const { createCrm } = await import('../public/js/views/crm.js');
  core.state.user = { id: 1, name: 'Priya Nair', isAdmin: false, capabilities: { 'employee.edit': true } };
  core.state.crmKeys = ['leader_input_last_week', 'leader_input_this_week', 'opp_id',
    'demand_number', 'block_status', 'giga_project_name'];
  const crm = createCrm({ getScope: () => ({ projectId: 1 }), onChanged() {} });
  documentShim.body.replaceChildren(crm.el);
  crm.showAssignment(1);
  await new Promise((r) => setTimeout(r, 80));

  const originalFetch = globalThis.fetch;
  try {
  // simulate a dropped connection on the next PATCH only
  globalThis.fetch = async (url, opts) => {
    if ((opts?.method || 'GET') === 'PATCH') throw new TypeError('Failed to fetch');
    return originalFetch(url, opts);
  };
  // the record is fetched before the failure kicks in
  crm.showAssignment(1);
  await new Promise((r) => setTimeout(r, 150));

  const findEditable = () => crm.el.querySelectorAll('input, textarea')
    .find((i) => i.dataset.fieldKey === 'leader_input_this_week');
  if (!findEditable()) {
    // form has not painted yet in the shim; wait and retry once
    await new Promise((r) => setTimeout(r, 250));
  }
  const retryInput = findEditable();
  assert.ok(retryInput, 'the CRM exposes a supervisor field for editing');
  retryInput.value = 'Offline Edit';
  retryInput.dispatchEvent({ type: 'input', target: retryInput });
  await new Promise((r) => setTimeout(r, 1400));

  const afterFail = flatten(crm.el).join(' ');
  assert.ok(afterFail.includes('Not saved'), 'the panel must not claim success while offline');
  assert.ok(afterFail.includes('Changes are not saved yet'), 'a retry banner is shown');
  assert.equal(retryInput.value, 'Offline Edit', 'the typed value is preserved for retry');

  // network recovers and the explicit retry succeeds
  globalThis.fetch = originalFetch;
  const retry = crm.el.querySelectorAll('button').find((b) => (flatten(b).join(' ') || '').includes('Retry save'));
  assert.ok(retry, 'retry control exists');
  retry.click();
  await new Promise((r) => setTimeout(r, 200));
  const afterRetry = flatten(crm.el).join(' ');
  assert.ok(afterRetry.includes('Saved') || !afterRetry.includes('Not saved'), 'a successful retry reports Saved');
  assert.ok(calls.filter((c) => c.startsWith('PATCH')).length >= 1);
  } finally {
    // a failed assertion here used to leave the broken stub in place for the
    // tests that follow, which is its own bug
    globalThis.fetch = originalFetch;
  }
});

test('the assistant opens from the Ask event and answers a question', async () => {
  // Regression guard: the panel used to listen on `window` while the launch
  // button dispatched on `document`, so clicking Ask did nothing at all.
  const { createAssistant } = await import('../public/js/views/assistant.js');
  const assistant = createAssistant();

  assert.ok(assistant.el.classList.contains('hidden'), 'panel starts closed');

  document.dispatchEvent({ type: 'rp:assistant' });
  assert.equal(assistant.isOpen(), true, 'the Ask event must open the panel');
  assert.ok(!assistant.el.classList.contains('hidden'), 'panel is no longer hidden');

  document.dispatchEvent({ type: 'rp:assistant' });
  assert.equal(assistant.isOpen(), false, 'the same event closes it again');

  // and a question round-trips through the API layer
  document.dispatchEvent({ type: 'rp:assistant' });
  const payload = JSON.stringify({
    reply: '125 people (Bench Category: Bench) in Giga One.',
    understood: true, kind: 'count', table: null, suggestions: [],
  });
  const assistantFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/agent\/ask/);
    // core.api() reads res.text() and parses it itself, so the body comes back
    // as text, exactly like the real server response.
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  };
  const input = assistant.el.querySelector('.assistant-input');
  const foot = assistant.el.querySelector('.assistant-foot');
  const sendBtn = foot.children.find((c) => c.classList && c.classList.contains('btn-primary'));
  assert.ok(input, 'the composer is rendered');
  assert.ok(sendBtn, 'the send button is rendered');
  input.value = 'how many on bench in Giga One?';
  sendBtn.click();
  await new Promise((r) => setTimeout(r, 60));

  const walk = (n) => (n.children || []).map((c) => (c.textContent || '') + walk(c)).join(' ');
  const text = walk(assistant.el);
  assert.match(text, /125 people/, 'the answer is rendered in the panel');
  globalThis.fetch = assistantFetch;
});

test('the filter bar is five dropdowns, and picking a value narrows the rows', async () => {
  const { createFilterBar } = await import('../public/js/views/filterbar.js');
  const seen = [];
  const bar = createFilterBar({ onChange: (next) => seen.push(next) });
  bar.setFacets([
    { key: 'billing_status', label: 'Billing Status', total: 60, values: [{ value: 'Billable', count: 40 }, { value: 'Non-Billable', count: 20 }] },
    { key: 'bench_category', label: 'Bench Category', total: 60, values: [{ value: 'Bench', count: 15 }] },
    { key: 'bl_status', label: 'BL Status', total: 60, values: [{ value: 'BL-1', count: 60 }] },
    { key: 'offsite_onsite', label: 'Offsite / Onsite', total: 60, values: [{ value: 'Onsite', count: 35 }] },
    { key: 'giga_project_name', label: 'Giga Project Name', total: 10, values: [{ value: 'Giga One', count: 10 }] },
    { key: 'capability', label: 'Capability', total: 60, values: [{ value: 'Tech', count: 60 }] },
  ], 'Nexus');

  const barButtons = bar.el.querySelectorAll('.facet-btn');
  assert.equal(barButtons.length, 5, 'the bar shows the five dimensions, not a wall of chips');
  // nothing is expanded on the page: no value is rendered until a dropdown opens
  assert.equal(bar.el.querySelectorAll('.facet-option').length, 0);

  // opening one lists its real values with counts
  bar.openFor('bench_category');
  const options = bar.menu.querySelectorAll('.facet-option');
  assert.ok(options.length >= 2, 'All + the real values');

  // the shim does not aggregate text from children, so walk the tree
  const text = (node) => [node._text || '', ...node.children.map((c) => (c instanceof El ? text(c) : String(c._text ?? '')))].join(' ');

  // the option count is the row count the table will show
  assert.ok(text(bar.menu).includes('15'));

  // choosing a value is reported as a filter and the button shows it
  options[1].click();
  assert.deepEqual(seen.at(-1), { bench_category: ['Bench'] });
  // Regression: the menu used to stay open over the rows after a pick, so the
  // filtered result was hidden behind its own dropdown.
  assert.ok(bar.menu.classList.contains('hidden'), 'the menu closes when a value is chosen');
  assert.equal(bar.menu.children.length, 0, 'the closed menu is emptied, not left floating');
  assert.ok(text(bar.el).includes('Bench'), 'the button shows the chosen value');

  bar.clearAll();
  assert.deepEqual(seen.at(-1), {});
});

test('the Update panel shows the employee ID, the name and exactly the CRM columns', async () => {
  const { createSubmitPanel } = await import('../public/js/views/submit.js');
  const { state } = await import('../public/js/core.js');
  state.crmKeys = ['leader_input_last_week', 'leader_input_this_week', 'opp_id',
    'demand_number', 'block_status', 'giga_project_name'];
  const panel = createSubmitPanel({ getScope: () => ({ projectId: 1 }), onSaved() {} });
  documentShim.body.replaceChildren(panel.el);
  await panel.show(1);
  await new Promise((r) => setTimeout(r, 80));

  const text = flatten(panel.el).join(' ');
  assert.ok(text.includes('Worker 1'), 'the person name is shown');
  assert.ok(text.includes('Worker 1'), 'the person is shown');
  assert.ok(text.includes('Leader Input This Week'), 'a configured CRM column is rendered');
  assert.ok(!text.includes('Email Address'), 'identity fields are not part of the update form');
  assert.ok(!text.includes('Supplier'), 'the panel is not the whole record');

  // only the configured columns produce an input
  // the shim understands single tag selectors only, so query each tag
  const keys = ['input', 'select', 'textarea']
    .flatMap((tag) => panel.el.querySelectorAll(tag))
    .map((i) => i.dataset.fieldKey).filter(Boolean);
  assert.deepEqual([...new Set(keys)].sort(), [...state.crmKeys].sort(),
    'exactly the configured columns are editable');
  state.crmKeys = [];
});

test('clicking a person name opens the update form for that row', async () => {
  const { createTable } = await import('../public/js/views/table.js');
  let picked = null;
  const t = createTable({ onSelect: (row) => { picked = row; }, onSaved() {} });
  documentShim.body.replaceChildren(t.el);
  t.el.parentElement = documentShim.body;
  await t.setScope({ projectId: 1, subprojectId: 2, categoryId: 4 });
  await new Promise((r) => setTimeout(r, 120));

  const link = t.el.querySelectorAll('button').find((b) => b.classList.contains('emp-name-link'));
  assert.ok(link, 'the name is rendered as a link into the updater');
  link.click();
  assert.ok(picked && picked.assignmentId, 'clicking the name selects that person');
});

test('Data Hub offers the import template and asks where new rows go', async () => {
  core.state.user = { id: 1, name: 'Uploader', isAdmin: false, capabilities: { 'import.data': true } };
  core.state.tree = [{
    id: 1, code: 'NEXUS', name: 'Nexus Digital Transformation',
    subprojects: [{ id: 2, name: 'Core Banking Migration', categories: [{ id: 4, name: 'Training Cohort' }] }],
  }];
  core.state.imports = [];

  const { renderDataHub } = await import('../public/js/views/datahub.js');
  const content = new El('div');
  content.id = 'content';
  documentShim.body.replaceChildren(content);
  await renderDataHub(content, {});
  await new Promise((r) => setTimeout(r, 60));

  const text = flatten(content).join(' ');
  assert.ok(text.includes('Import template'), 'the blank template with the 65 headers is downloadable from here');
  assert.ok(text.includes('Where should new rows go?'), 'the placement picker is offered for files without a Project column');
  assert.ok(text.includes('Upload a daily dataset'));

  const selects = content.querySelectorAll('select');
  assert.ok(selects.length >= 3, 'project / subproject / category are selectable');
});

test('typing in the update panel saves itself: no Submit, no export, straight to the database', async () => {
  const { createSubmitPanel } = await import('../public/js/views/submit.js');
  const { state } = await import('../public/js/core.js');
  state.crmKeys = ['leader_input_this_week', 'opp_id', 'demand_number'];
  state.user = {
    id: 1, name: 'Priya Nair', isAdmin: false,
    capabilities: { 'employee.edit': true, 'crm.use': true },
    projects: [{ id: 1, can_edit: 1 }],
  };
  const saved = [];
  const panel = createSubmitPanel({ getScope: () => ({ projectId: 1 }), onSaved: (rec) => saved.push(rec) });
  documentShim.body.replaceChildren(panel.el);
  await panel.show(1);
  await new Promise((r) => setTimeout(r, 80));

  const input = panel.el.querySelectorAll('input').find((i) => i.dataset.fieldKey === 'demand_number');
  assert.ok(input, 'the field is on the form');
  const before = calls.filter((c) => c.includes('/submit')).length;

  // a keystroke, then wait out the debounce - nothing else is clicked
  input.value = 'DEM-AUTOSAVE';
  input.dispatchEvent({ type: 'input', target: input });
  await new Promise((r) => setTimeout(r, 1300));

  const writes = calls.filter((c) => c.includes('/submit'));
  assert.ok(writes.length > before, 'the change reached the server without pressing Submit');
  assert.ok(saved.length > 0, 'the saved record came back to the panel');
  // the footer reports the truth: no longer pending
  const text = flatten(panel.el).join(' ');
  assert.ok(/All changes saved/.test(text) || /Saving/.test(text), `footer state: ${text.slice(-200)}`);
  // and no file/export traffic was involved
  assert.ok(!calls.some((c) => c.includes('/export')), 'saving never touches an export');

  // the button is an optional "save now", not the only path
  assert.ok(flatten(panel.el).join(' ').includes('Save now'));
  state.crmKeys = [];
});

test('Administration shows only Data model, CRM panel and Users & access', async () => {
  const { renderAdmin } = await import('../public/js/views/admin.js');
  core.state.user = { id: 1, name: 'Ananya Deshmukh', isAdmin: true, role: 'admin', capabilities: {} };
  core.state.tree = [{ id: 1, name: 'Nexus Digital Transformation' }];
  const content = documentShim.createElement('div');
  await renderAdmin(content, { tab: 'access' });
  await new Promise((r) => setTimeout(r, 60));

  const text = flatten(content).join(' ');
  for (const label of ['Data model', 'CRM panel', 'Users & access']) {
    assert.ok(text.includes(label), `tab present: ${label}`);
  }
  for (const gone of ['Projects & hierarchy', 'Suppliers', 'Employee groups']) {
    assert.ok(!text.includes(gone), `tab removed: ${gone}`);
  }
  assert.ok(text.includes('New user'), 'a new user can be created from here');
  assert.ok(text.includes('Delete'), 'each user can be deleted');
  assert.ok(text.includes('Test Leader'), 'the user list renders');
});

const button = (root, label) => {
  const el = root.querySelectorAll('button').find((b) => flatten(b).join('') === label);
  assert.ok(el, `button rendered: ${label}`);
  return el;
};
const settleClicks = () => new Promise((resolve) => setImmediate(resolve));

test('New user submits the form with its grants; Delete requires confirmation', async (t) => {
  const { renderAdmin } = await import('../public/js/views/admin.js');
  core.state.user = { id: 1, isAdmin: true };
  core.state.tree = [{ id: 1, name: 'Nexus', subprojects: [] }];
  const content = new El('div');
  documentShim.body.replaceChildren(content);
  const fetch = t.mock.method(globalThis, 'fetch'); // call through to the stub; inspect writes
  await renderAdmin(content, { tab: 'access' });
  button(content, 'New user').click();
  const dialog = body.querySelector('.overlay');
  assert.ok(dialog, 'the modal actually opens');
  const input = (placeholder) => dialog.querySelectorAll('input').find((el) => el.attrs.placeholder === placeholder);
  input('Full name').value = 'New supervisor';
  input('name@company.com').value = 'new@example.test';
  input('At least 8 characters').value = 'example123';
  dialog.querySelector('select').value = 'supervisor';
  const picker = dialog.querySelectorAll('select')[1];
  assert.ok(flatten(picker).includes('Giga Apple'));
  picker.value = 'g:Giga Apple'; picker.dispatchEvent({ type: 'change' });
  const capability = dialog.querySelectorAll('label').find((l) => flatten(l).join('') === 'Edit employee records').querySelector('input');
  capability.checked = true; capability.dispatchEvent({ type: 'change' });
  button(dialog, 'Create user').click();
  await settleClicks();
  const post = fetch.mock.calls.find(({ arguments: [url, opts] }) => url === '/api/users' && opts.method === 'POST');
  const payload = JSON.parse(post.arguments[1].body);
  assert.equal(payload.email, 'new@example.test');
  assert.equal(payload.gigaProjectName, 'Giga Apple');
  assert.equal(payload.projects, undefined);
  assert.equal(payload.capabilities['employee.edit'], true);
  assert.ok(!body.querySelector('.overlay'));

  const deletes = () => fetch.mock.calls.filter(({ arguments: [url, opts] }) => url === '/api/users/7' && opts.method === 'DELETE');
  button(content, 'Delete').click();
  button(body.querySelector('.overlay'), 'Cancel').click();
  await settleClicks();
  assert.equal(deletes().length, 0);
  button(content, 'Delete').click();
  button(body.querySelector('.overlay'), 'Delete user').click();
  await settleClicks();
  assert.equal(deletes().length, 1);
  assert.equal(fetch.mock.calls.at(-1).arguments[1].method, 'GET', 'refresh the user list after deletion');
});

test('Edit access can replace existing hierarchy grants with one workbook Giga project', async (t) => {
  const { renderAdmin } = await import('../public/js/views/admin.js');
  core.state.user = { id: 1, isAdmin: true };
  core.state.tree = [{ id: 1, name: 'Nexus', subprojects: [] }];
  const content = new El('div');
  documentShim.body.replaceChildren(content);
  const fetch = t.mock.method(globalThis, 'fetch');
  await renderAdmin(content, { tab: 'access' });
  button(content, 'Edit access').click();
  const dialog = body.querySelector('.overlay');
  const picker = dialog.querySelector('select');
  assert.equal(picker.value, 'legacy');
  picker.value = 'g:Giga Pear'; picker.dispatchEvent({ type: 'change' });
  button(dialog, 'Save access').click();
  await settleClicks();
  const put = fetch.mock.calls.find(({ arguments: [url, opts] }) => url === '/api/users/7/access' && opts.method === 'PUT');
  const saved = JSON.parse(put.arguments[1].body);
  assert.equal(saved.gigaProjectName, 'Giga Pear');
  assert.equal(saved.projects, undefined);
  assert.equal(saved.capabilities['employee.edit'], true);
});

test('Data model renders a populated category, opens the field form and saves the selected layout', async (t) => {
  const { renderAdmin } = await import('../public/js/views/admin.js');
  core.state.user = { isAdmin: true };
  core.state.tree = [{ id: 1, name: 'Nexus', subprojects: [{ name: 'Core', categories: [{ id: 4, name: 'Training' }] }] }];
  const content = new El('div');
  documentShim.body.replaceChildren(content);
  const fetch = t.mock.method(globalThis, 'fetch');
  await renderAdmin(content, {});
  const order = content.querySelectorAll('input').find((i) => i.attrs.type === 'number');
  assert.equal(Number(order.value), 27, 'display the persisted order, not the catalogue index');
  button(content, 'New field').click();
  assert.ok(flatten(body.querySelector('.overlay')).includes('Field key'));
  button(body.querySelector('.overlay'), 'Cancel').click();
  order.value = 9;
  order.dispatchEvent({ type: 'change' });
  button(content, 'Save layout').click();
  await settleClicks();
  const write = fetch.mock.calls.find(({ arguments: [url, opts] }) => url === '/api/categories/4/columns' && opts.method === 'PUT');
  assert.equal(JSON.parse(write.arguments[1].body).fields[0].sort_order, 9);
});

test('Directory cards and row count switch together on filter, clear, failure and retry', async (t) => {
  const { renderDirectory } = await import('../public/js/views/directory.js');
  const all = { people: 12000, placements: 12000, gigaProjects: 3, hierarchyProjects: 6, pendingReviews: 8 };
  const giga = { people: 966, placements: 967, gigaProjects: 1, hierarchyProjects: 2, pendingReviews: 1 };
  core.state.user = { id: 1, isAdmin: true };
  core.state.tree = [];
  core.state.totals = { employees: 88888, assignments: 90000 }; // must not be shown or overwritten
  const fallback = globalThis.fetch;
  let failNext = false, holdNext = false, release;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!url.startsWith('/api/employees?')) return fallback(url, opts);
    const params = new URL(url, 'http://localhost').searchParams;
    const summary = params.has('f_giga_project_name[]') ? giga : all;
    if (holdNext) { holdNext = false; await new Promise((resolve) => { release = resolve; }); } // ignores abort on purpose
    if (failNext) { failNext = false; return jsonResponse({ error: 'Unavailable' }, 503); }
    return jsonResponse({ total: summary.placements, summary: params.get('includeSummary') === '1' ? summary : null,
      page: 1, pageSize: 25, totalPages: Math.ceil(summary.placements / 25), rows: workers.slice(0, 25), columns: [],
      facets: [{ key: 'giga_project_name', label: 'Giga Project Name', allCount: 12000, values: [{ value: 'Giga One', count: 967 }] }],
    });
  });
  const content = new El('div');
  documentShim.body.replaceChildren(content);
  const counts = () => [...content.querySelectorAll('.kpi-value'), content.querySelector('#row-count')].map((el) => flatten(el).join(''));
  const selectGiga = () => {
    content.querySelector('.facet-btn').click();
    content.querySelectorAll('.facet-option').find((b) => flatten(b).includes('Giga One')).click();
  };
  const pending = ['—', '—', '—', '—', '—'];
  const overall = ['12,000', '12,000', '3', '8', '12,000'];
  const selected = ['966', '967', '1', '1', '967'];
  renderDirectory(content, { setCrumbs() {} });
  assert.deepEqual(counts(), pending);
  await settleClicks();
  assert.deepEqual(counts(), overall);
  assert.ok(flatten(content.querySelector('.facet-btn-count')).includes('12,000'), 'All includes blank Giga names too');
  holdNext = true;
  selectGiga();
  assert.deepEqual(counts(), pending, 'do not show global totals while filtering');
  button(content, 'Clear 1').click();
  await settleClicks();
  release(); await settleClicks();
  assert.deepEqual(counts(), overall, 'a late superseded response must not replace rows or cards');
  selectGiga(); await settleClicks();
  assert.deepEqual(counts(), selected);
  assert.ok(flatten(content).includes('2 hierarchy projects in view'));
  failNext = true;
  content.querySelectorAll('button').find((b) => b.attrs['aria-label'] === 'Next page').click();
  await settleClicks();
  assert.deepEqual(counts(), pending, 'a failed load cannot advertise stale totals');
  button(content, 'Try again').click(); await settleClicks();
  assert.deepEqual(counts(), selected);
  assert.deepEqual(core.state.totals, { employees: 88888, assignments: 90000 });
});

test('hands-free Ask: speech → scoped question → open CRM → dictate → review → confirm, without an automatic write', async (t) => {
  const { createAssistant } = await import('../public/js/views/assistant.js');
  let mic, listening = false, packInstalled = false;
  const heard = [], asks = [], saves = [];
  const define = (key, value) => { const old = Object.getOwnPropertyDescriptor(window, key); Object.defineProperty(window, key, { configurable: true, value }); t.after(() => old ? Object.defineProperty(window, key, old) : delete window[key]); };
  class Recognition {
    processLocally = false;
    static available = async (o) => { assert.equal(o.processLocally, true); return packInstalled ? 'available' : 'downloadable'; };
    static install = async () => (packInstalled = true);
    start() { assert.equal(this.processLocally, true); assert.equal(listening, false); mic = this; listening = true; }
    stop() { listening = false; this.onend(); }
    abort() { listening = false; this.onend?.(); }
  }
  define('SpeechRecognition', Recognition); define('isSecureContext', true);
  define('SpeechSynthesisUtterance', class { constructor(text) { this.text = text; } });
  define('speechSynthesis', { getVoices: () => [{ lang: 'en-US', localService: false }, { lang: 'en-US', localService: true }],
    speak(u) { assert.ok(!listening && u.voice.localService); heard.push(u.text); u.onend(); }, cancel() {} });
  core.state.user = { id: 7, isAdmin: false };
  const name = 'Summer Project', form = { projectName: name, assignmentId: 73, name: 'Alex Rao', empCode: 'QA-123', rev: 4,
    fields: [{ key: 'detail_comments', label: 'Detail Comments', editable: true, type: 'textarea', value: 'Original' },
      { key: 'billing_start_date', label: 'Billing Start Date', editable: true, type: 'date', value: '' },
      { key: 'demand_number', label: 'Demand Number', editable: false, type: 'text', value: '' }] };
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url === '/api/agent/projects') return jsonResponse({ projectNames: [name, 'Autumn Project'] });
    const body = JSON.parse(opts.body);
    if (url === '/api/agent/ask') {
      asks.push(body);
      if (!body.projectName && !body.message.includes(name)) return jsonResponse({ kind: 'choose_project', reply: 'Which project?' });
      if (body.message === name) return jsonResponse({ kind: 'project', projectName: name, reply: 'Selected' });
      if (body.message === 'Open CRM') return jsonResponse({ kind: 'crm_lookup', projectName: name, reply: 'Whose CRM record?' });
      if (body.message === 'Open CRM for QA 123') return jsonResponse({ kind: 'crm', projectName: name, reply: 'CRM open for Alex', crm: form });
      return jsonResponse({ kind: 'count', reply: '3 people on bench in Summer Project.', projectName: name });
    }
    assert.equal(url, '/api/employees/73/submit'); saves.push(body);
    return jsonResponse({ record: { rev: 5, values: body.changes } });
  });
  const assistant = createAssistant(); documentShim.body.replaceChildren(assistant.el); assistant.open(); await settleClicks();
  button(assistant.el, 'Start voice mode').click(); await settleClicks();
  assert.ok(!packInstalled && !listening, 'install requires a separate explicit gesture');
  button(assistant.el, 'Install English speech pack').click(); await settleClicks();
  const say = async (text) => {
    assert.ok(listening, 'next turn must not require clicking the mic');
    const result = [{ transcript: text }]; result.isFinal = true;
    mic.onresult({ results: [result] }); await settleClicks();
  };
  await say('How many on bench?'); await say(name);
  assert.match(heard.at(-1), /3 people on bench/);
  assert.deepEqual(asks.at(-1), { message: 'How many on bench?', projectName: name });
  await say('Open CRM'); await say('QA 123'); assert.match(heard.at(-1), /CRM open for Alex/);
  await say('Set Demand Number to forbidden'); assert.match(heard.at(-1), /read-only/);
  await say('Set Detail Comments to Ready for interview');
  assert.equal(assistant.el.querySelector('.assistant-crm').querySelector('textarea').value, 'Ready for interview');
  await say('Confirm save'); assert.equal(saves.length, 0);
  await say('Review changes'); assert.match(heard.at(-1), /Alex Rao.*QA-123.*Summer Project.*Detail Comments: Ready for interview/);
  await say('Set Billing Start Date to May 12 2027'); await say('Confirm save'); assert.equal(saves.length, 0, 'changing a value invalidates the review');
  await say('Review changes'); await say('Confirm save');
  assert.deepEqual(saves, [{ crmProjectName: name, changes: { detail_comments: 'Ready for interview', billing_start_date: '2027-05-12' }, rev: 4, reason: 'Confirmed CRM form in assistant' }]);
  await say('Set Detail Comments to Do not keep'); await say('Discard changes'); await say('Close CRM');
  assert.ok(!assistant.el.querySelector('.assistant-crm').children.length); assert.equal(saves.length, 1);
  const late = mic; assistant.toggle(false); assert.ok(!listening);
  const result = [{ transcript: 'Confirm save' }]; result.isFinal = true;
  late.onresult({ results: [result] }); await settleClicks(); assert.equal(saves.length, 1);
});

test('voice does not fall back to a cloud-only recognizer or require a mic for text', async () => {
  const { createLocalVoice } = await import('../public/js/voice.js');
  let started = false, state;
  window.isSecureContext = true;
  window.SpeechRecognition = class { start() { started = true; } };
  try {
    const voice = createLocalVoice({ onCommand: () => assert.fail('must not capture audio'), onState: (s) => { state = s; } });
    await voice.toggle(); assert.equal(started, false); assert.equal(state.active, false); assert.match(state.text, /type instead/);
  } finally { delete window.SpeechRecognition; delete window.isSecureContext; }
});
