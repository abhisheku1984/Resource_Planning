'use strict';
const { sendWorkbook, workbookBytes } = require('./send-workbook');
const express = require('express');
const { q, tx } = require('./db');
const auth = require('./auth');
const access = require('./access');
const schema = require('./schema');
const emp = require('./employees');
const query = require('./query');
const agent = require('./agent');
const { checkCrmSubmit } = require('./assistant-crm');
const agentstore = require('./agentstore');
const guideReview = require('./guide-review');
const excel = require('./excel');
const rosterCycle = require('./roster-cycle');
const { record, auditScope, recentActivity } = require('./audit');

const router = express.Router();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  next();
};
const requireCap = (cap) => (req, res, next) => {
  if (!auth.can(req.user, cap)) return res.status(403).json({ error: 'You do not have permission for this action.' });
  next();
};
const asInt = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
router.post('/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const user = q.get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', String(email || '').trim());
  if (!user || !auth.verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = auth.createSession(user.id);
  record({ entity: 'user', entityId: user.id, ref: user.email, action: 'login', actor: auth.hydrateUser(user) });
  res.json({ token, user: auth.hydrateUser(user) });
}));

router.post('/auth/logout', requireAuth, wrap((req, res) => {
  auth.destroySession(req.token);
  res.json({ ok: true });
}));

router.get('/auth/me', requireAuth, wrap((req, res) => {
  res.json({ user: req.user });
}));

router.post('/auth/password', requireAuth, wrap((req, res) => {
  const { current, next: nextPw } = req.body || {};
  const row = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verifyPassword(String(current || ''), row.password_hash)) {
    return res.status(422).json({ error: 'Current password is incorrect.' });
  }
  if (String(nextPw || '').length < 8) return res.status(422).json({ error: 'Use at least 8 characters.' });
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(String(nextPw)), req.user.id);
  q.run('DELETE FROM sessions WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// bootstrap: everything the shell needs in one round trip
// ---------------------------------------------------------------------------
router.get('/bootstrap', requireAuth, wrap((req, res) => {
  const tree = schema.hierarchy(req.user);
  const fields = schema.listFields(req.user);
  res.json({
    user: req.user,
    tree,
    fields,
    suppliers: access.suppliersFor(req.user, true),
    // the columns the CRM / Update panel shows, in order
    crmKeys: schema.crmKeys(),
    statusCounts: statusCounts(req.user),
    totals: totals(req.user),
  });
}));

function totals(user) {
  const acl = access.assignmentScope(user);
  const counts = q.get(`SELECT COUNT(DISTINCT employee_id) employees, COUNT(*) assignments
                         FROM assignments a WHERE a.active = 1 AND ${acl.sql}`, ...acl.args);
  return {
    ...counts,
    projects: auth.visibleProjectIds(user).length,
    suppliers: access.suppliersFor(user, true).length,
    pendingReviews: user.isAdmin ? Number(q.get("SELECT COUNT(*) c FROM duplicate_reviews WHERE status = 'pending'").c) : 0,
  };
}

function statusCounts(user) {
  const acl = access.assignmentScope(user);
  return q.all(`SELECT status, COUNT(*) c FROM assignments a WHERE a.active = 1 AND ${acl.sql} GROUP BY status ORDER BY c DESC`, ...acl.args);
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', requireAuth, wrap((req, res) => {
  const acl = access.assignmentScope(req.user);
  const byProject = q.all(
    `SELECT p.id, p.name, p.code, COUNT(a.id) c, SUM(a.status = 'Active') active
       FROM assignments a JOIN projects p ON a.project_id = p.id
      WHERE a.active = 1 AND ${acl.sql} GROUP BY p.id ORDER BY c DESC`, ...acl.args);
  const bySupplier = q.all(
    `SELECT ifnull(sup.name, 'Unassigned') name, COUNT(*) c
       FROM assignments a LEFT JOIN suppliers sup ON sup.id = a.supplier_id
      WHERE a.active = 1 AND ${acl.sql} GROUP BY sup.id ORDER BY c DESC LIMIT 8`, ...acl.args);
  const summary = { totals: totals(req.user), byProject, byStatus: statusCounts(req.user), bySupplier };
  // The overview only needs counts. Other callers can still request the full dashboard response.
  if (req.query.summaryOnly === '1') return res.json(summary);
  const byCategory = q.all(
    `SELECT c.name, COUNT(*) c FROM assignments a JOIN categories c ON a.category_id = c.id
      WHERE a.active = 1 AND ${acl.sql} GROUP BY c.id ORDER BY c DESC LIMIT 10`, ...acl.args);
  const attention = q.all(
    `SELECT a.id assignment_id, e.emp_code, e.name, a.status, a.updated_at,
            p.name project_name, s.name subproject_name, c.name category_name
       FROM assignments a JOIN employees e ON e.id = a.employee_id
       JOIN projects p ON p.id = a.project_id JOIN subprojects s ON s.id = a.subproject_id JOIN categories c ON c.id = a.category_id
      WHERE a.active = 1 AND ${acl.sql} AND (a.status IN ('On Leave', 'Billing Hold', 'Released') OR a.supplier_id IS NULL)
      ORDER BY a.updated_at DESC LIMIT 8`, ...acl.args);
  const audit = auditScope(req.user);
  const canAudit = auth.can(req.user, 'audit.view');
  const trend = canAudit ? q.all(`SELECT substr(at, 1, 10) day, COUNT(*) c FROM audit_log l
                       WHERE at >= date('now', '-13 day') AND ${audit.sql} GROUP BY day ORDER BY day`, ...audit.args) : [];
  res.json({ ...summary, byCategory,
    activity: canAudit ? recentActivity(req.user, {limit: 12}) : [], attention, trend });
}));

// ---------------------------------------------------------------------------
// projects / subprojects / categories / suppliers / groups
// ---------------------------------------------------------------------------
router.get('/projects', requireAuth, wrap((req, res) => {
  res.json({ projects: schema.hierarchy(req.user) });
}));

router.post('/projects', requireAuth, requireAdmin, wrap((req, res) => {
  const { code, name, client, description, status, start_date } = req.body || {};
  if (!code || !name) return res.status(422).json({ error: 'Project code and name are required.' });
  const exists = q.get('SELECT id FROM projects WHERE lower(code) = lower(?)', code);
  if (exists) return res.status(422).json({ error: 'That project code is already in use.' });
  const r = q.run(
    'INSERT INTO projects (code, name, client, description, status, start_date) VALUES (?, ?, ?, ?, ?, ?)',
    code, name, client || null, description || null, status || 'active', start_date || null
  );
  const id = Number(r.lastInsertRowid);
  // New subprojects/categories start from the default column set, so the first
  // admin visit sees a usable table instead of an empty one.
  record({ entity: 'project', entityId: id, ref: code, action: 'create', newValue: name, actor: req.user });
  res.json({ project: q.get('SELECT * FROM projects WHERE id = ?', id) });
}));

router.patch('/projects/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const before = q.get('SELECT * FROM projects WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Project not found.' });
  const allowed = ['code', 'name', 'client', 'description', 'status', 'start_date', 'active'];
  const sets = [];
  const args = [];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(req.body[k] === '' ? null : req.body[k]);
    if (String(before[k] ?? '') !== String(req.body[k] ?? '')) {
      record({ entity: 'project', entityId: id, ref: before.code, action: 'update', fieldKey: k, oldValue: before[k], newValue: req.body[k], actor: req.user });
    }
  }
  if (!sets.length) return res.json({ project: before });
  q.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  res.json({ project: q.get('SELECT * FROM projects WHERE id = ?', id) });
}));

router.post('/subprojects', requireAuth, requireAdmin, wrap((req, res) => {
  const { project_id, code, name, description } = req.body || {};
  if (!project_id || !code || !name) return res.status(422).json({ error: 'Project, code and name are required.' });
  const dup = q.get('SELECT id FROM subprojects WHERE project_id = ? AND lower(code) = lower(?)', Number(project_id), code);
  if (dup) return res.status(422).json({ error: 'That subproject code already exists in this project.' });
  const r = q.run('INSERT INTO subprojects (project_id, code, name, description) VALUES (?, ?, ?, ?)', Number(project_id), code, name, description || null);
  const id = Number(r.lastInsertRowid);
  record({ entity: 'subproject', entityId: id, ref: code, action: 'create', newValue: name, actor: req.user });
  res.json({ subproject: q.get('SELECT * FROM subprojects WHERE id = ?', id) });
}));

router.patch('/subprojects/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const before = q.get('SELECT * FROM subprojects WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Subproject not found.' });
  const allowed = ['code', 'name', 'description', 'active', 'sort_order'];
  const sets = []; const args = [];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k} = ?`); args.push(req.body[k] === '' ? null : req.body[k]);
  }
  if (sets.length) q.run(`UPDATE subprojects SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  record({ entity: 'subproject', entityId: id, ref: before.code, action: 'update', actor: req.user });
  res.json({ subproject: q.get('SELECT * FROM subprojects WHERE id = ?', id) });
}));

router.post('/categories', requireAuth, requireAdmin, wrap((req, res) => {
  const { subproject_id, code, name, description } = req.body || {};
  if (!subproject_id || !code || !name) return res.status(422).json({ error: 'Subproject, code and name are required.' });
  const dup = q.get('SELECT id FROM categories WHERE subproject_id = ? AND lower(code) = lower(?)', Number(subproject_id), code);
  if (dup) return res.status(422).json({ error: 'That category code already exists in this subproject.' });
  const r = q.run('INSERT INTO categories (subproject_id, code, name, description) VALUES (?, ?, ?, ?)', Number(subproject_id), code, name, description || null);
  const id = Number(r.lastInsertRowid);
  record({ entity: 'category', entityId: id, ref: code, action: 'create', newValue: name, actor: req.user });
  res.json({ category: q.get('SELECT * FROM categories WHERE id = ?', id) });
}));

router.patch('/categories/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const before = q.get('SELECT * FROM categories WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Category not found.' });
  const allowed = ['code', 'name', 'description', 'active', 'sort_order'];
  const sets = []; const args = [];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k} = ?`); args.push(req.body[k] === '' ? null : req.body[k]);
  }
  if (sets.length) q.run(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  record({ entity: 'category', entityId: id, ref: before.code, action: 'update', actor: req.user });
  res.json({ category: q.get('SELECT * FROM categories WHERE id = ?', id) });
}));

router.get('/suppliers', requireAuth, wrap((req, res) => {
  res.json({ suppliers: access.suppliersFor(req.user) });
}));

router.post('/suppliers', requireAuth, requireAdmin, wrap((req, res) => {
  const { code, name, contact_name, email, phone } = req.body || {};
  if (!name) return res.status(422).json({ error: 'Supplier name is required.' });
  const finalCode = (code || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  const dup = q.get('SELECT id FROM suppliers WHERE lower(name) = lower(?)', name);
  if (dup) return res.status(422).json({ error: 'That supplier already exists.' });
  const r = q.run('INSERT INTO suppliers (code, name, contact_name, email, phone) VALUES (?, ?, ?, ?, ?)', finalCode, name, contact_name || null, email || null, phone || null);
  record({ entity: 'supplier', entityId: Number(r.lastInsertRowid), ref: finalCode, action: 'create', newValue: name, actor: req.user });
  res.json({ supplier: q.get('SELECT * FROM suppliers WHERE id = ?', Number(r.lastInsertRowid)) });
}));

router.patch('/suppliers/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const before = q.get('SELECT * FROM suppliers WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Supplier not found.' });
  const allowed = ['name', 'contact_name', 'email', 'phone', 'active'];
  const sets = []; const args = [];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k} = ?`); args.push(req.body[k] === '' ? null : req.body[k]);
  }
  if (sets.length) q.run(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  record({ entity: 'supplier', entityId: id, ref: before.code, action: 'update', fieldKey: 'record', actor: req.user });
  res.json({ supplier: q.get('SELECT * FROM suppliers WHERE id = ?', id) });
}));

router.get('/groups', requireAuth, wrap((req, res) => {
  // Groups are global registers, not Giga-scoped workforce records.
  if (req.user.gigaAccess) return res.json({ groups: [] });
  const groups = q.all('SELECT * FROM employee_groups ORDER BY name').map((g) => ({
    ...g,
    members: q.all(
      `SELECT e.id, e.emp_code, e.name FROM group_members gm JOIN employees e ON e.id = gm.employee_id WHERE gm.group_id = ? ORDER BY e.name`,
      g.id
    ),
  }));
  res.json({ groups });
}));

router.post('/groups', requireAuth, requireAdmin, wrap((req, res) => {
  const { name, description, memberIds } = req.body || {};
  if (!name) return res.status(422).json({ error: 'Group name is required.' });
  const dup = q.get('SELECT id FROM employee_groups WHERE lower(name) = lower(?)', name);
  if (dup) return res.status(422).json({ error: 'A group with that name already exists.' });
  return tx(() => {
    const r = q.run('INSERT INTO employee_groups (name, description) VALUES (?, ?)', name, description || null);
    const id = Number(r.lastInsertRowid);
    for (const m of memberIds || []) {
      q.run('INSERT OR IGNORE INTO group_members (group_id, employee_id) VALUES (?, ?)', id, Number(m));
    }
    record({ entity: 'group', entityId: id, ref: name, action: 'create', newValue: `${(memberIds || []).length} members`, actor: req.user });
    res.json({ group: { id, name, description } });
  });
}));

router.put('/groups/:id/members', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const members = (req.body.members || []).map(Number);
  return tx(() => {
    q.run('DELETE FROM group_members WHERE group_id = ?', id);
    for (const m of members) q.run('INSERT OR IGNORE INTO group_members (group_id, employee_id) VALUES (?, ?)', id, m);
    record({ entity: 'group', entityId: id, action: 'update', fieldKey: 'members', newValue: String(members.length), actor: req.user });
    res.json({ ok: true, count: members.length });
  });
}));

// ---------------------------------------------------------------------------
// dynamic field catalogue & per-category configuration
// ---------------------------------------------------------------------------
router.get('/fields', requireAuth, wrap((req, res) => {
  res.json({ fields: schema.listFields(req.user) });
}));

router.post('/fields', requireAuth, requireAdmin, wrap((req, res) => {
  const { key, label, type, options } = req.body || {};
  if (!key || !label) return res.status(422).json({ error: 'Field key and label are required.' });
  const cleanKey = String(key).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!cleanKey) return res.status(422).json({ error: 'Invalid field key.' });
  if (q.get('SELECT id FROM fields WHERE key = ?', cleanKey)) {
    return res.status(422).json({ error: 'A field with that key already exists.' });
  }
  const r = q.run(
    'INSERT INTO fields (key, label, type, options) VALUES (?, ?, ?, ?)',
    cleanKey, label, type || 'text', options ? JSON.stringify(options) : null
  );
  record({ entity: 'field', entityId: Number(r.lastInsertRowid), ref: cleanKey, action: 'create', newValue: label, actor: req.user });
  res.json({ field: schema.listFields().find((f) => f.key === cleanKey) });
}));

router.patch('/fields/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const before = q.get('SELECT * FROM fields WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Field not found.' });
  const allowed = ['label', 'type', 'help'];
  const sets = []; const args = [];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k} = ?`); args.push(req.body[k]);
  }
  if (req.body.options !== undefined) {
    sets.push('options = ?');
    args.push(req.body.options === null ? null : JSON.stringify(req.body.options));
  }
  if (sets.length) q.run(`UPDATE fields SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  record({ entity: 'field', entityId: id, ref: before.key, action: 'update', actor: req.user });
  res.json({ field: schema.listFields().find((f) => f.key === before.key) });
}));

router.get('/categories/:id/columns', requireAuth, wrap((req, res) => {
  const categoryId = Number(req.params.id);
  const cat = q.get(
    `SELECT c.*, s.project_id FROM categories c JOIN subprojects s ON s.id = c.subproject_id WHERE c.id = ?`,
    categoryId
  );
  if (!cat) return res.status(404).json({ error: 'Category not found.' });
  emp.assertProjectAccess(req.user, cat.project_id);
  access.assertGigaPlacement(req.user, { categoryId });
  const fields = schema.categoryLayout(categoryId, req.user);
  res.json({ category: cat, fields, isConfigured: fields.some((f) => f.configured) });
}));

router.put('/categories/:id/columns', requireAuth, requireAdmin, wrap((req, res) => {
  const categoryId = Number(req.params.id);
  const cat = q.get('SELECT * FROM categories WHERE id = ?', categoryId);
  if (!cat) return res.status(404).json({ error: 'Category not found.' });
  const rows = (req.body.fields || []).map((f) => ({
    field_id: Number(f.field_id || f.id),
    visible: f.visible !== false,
    editable: f.editable !== false,
    required: !!f.required,
    filterable: f.filterable,
    submit_field: f.submit_field ?? f.submitField,
    sort_order: f.sort_order,
    section: f.section,
  }));
  const columns = schema.setCategoryFields(categoryId, rows, req.user);
  res.json({ columns: columns.map((c) => ({ key: c.key, label: c.label, editable: c.editable, visible: c.visible })) });
}));

// ---------------------------------------------------------------------------
// employees / dynamic table
// ---------------------------------------------------------------------------
router.get('/employees', requireAuth, wrap((req, res) => {
  const params = {
    ...req.query,
    projectId: asInt(req.query.projectId || req.query.project_id),
    subprojectId: asInt(req.query.subprojectId || req.query.subproject_id),
    categoryId: asInt(req.query.categoryId || req.query.category_id),
    supplierId: asInt(req.query.supplierId || req.query.supplier_id),
  };
  res.json(query.listEmployees(req.user, { ...params, ...req.body?.filters }));
}));

/**
 * Filter facets for the bench board: for each filterable column in scope, the
 * distinct values and counts. Drives the "space filter" chips.
 */
/** Facet values for a scope, as a standalone call (used by the directory page). */
router.get('/employees/facets', requireAuth, wrap((req, res) => {
  const params = {
    ...req.query,
    projectId: asInt(req.query.projectId || req.query.project_id),
    subprojectId: asInt(req.query.subprojectId || req.query.subproject_id),
    categoryId: asInt(req.query.categoryId || req.query.category_id),
    supplierId: asInt(req.query.supplierId || req.query.supplier_id),
  };
  const ctx = query.prepareEmployeeQuery(req.user, params);
  res.json({ facets: query.facetsFor(ctx), scope: schema.scopeLabels(ctx.scope) });
}));

/**
 * Supervisor submit: one explicit Save that writes every field on the form in a
 * single transaction, then returns the authoritative row so the table and the
 * export both reflect it immediately.
 */
function submitEmployee(req, res, guided = false) {
  if (!auth.can(req.user, 'employee.edit') && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You do not have permission to update employee records.' });
  }
  const id = Number(req.params.id);
  const body = req.body || {};
  const changes = guided ? guideReview.consume(req.user, req.token, id, body) : body.changes || {};
  if (!guided && Object.hasOwn(body, 'crmProjectName')) checkCrmSubmit(req.user, id, body);
  const before = query.getAssignment(req.user, id, 'can_edit');
  if (!before) return res.status(404).json({ error: 'Employee record not found.' });

  emp.updateAssignment(req.user, id, changes, {
    expectedRev: body.rev || null,
    reason: guided ? 'Confirmed guided CRM update' : body.reason || 'Supervisor submit',
  });
  const after = query.getAssignment(req.user, id);

  const changedKeys = Object.keys(changes).filter((k) => {
    const a = before.values[k];
    const b = after.values[k];
    return String(a ?? '') !== String(b ?? '');
  });

  res.json({
    record: after,
    changed: changedKeys,
    savedAt: new Date().toISOString(),
    message: changedKeys.length
      ? `Saved ${changedKeys.length} field${changedKeys.length === 1 ? '' : 's'}. The next Excel export will include these values.`
      : 'No changes to save.',
  });
}
router.post('/employees/:id/submit', requireAuth, wrap((req, res) => submitEmployee(req, res)));
router.post('/agent/crm/:id/review', requireAuth, requireCap('employee.edit'), wrap((req, res) => {
  res.json(guideReview.issue(req.user, req.token, Number(req.params.id), req.body || {}));
}));
router.post('/agent/crm/:id/confirm', requireAuth, requireCap('employee.edit'), wrap((req, res) => submitEmployee(req, res, true)));

router.get('/employees/:id', requireAuth, wrap((req, res) => {
  const data = query.getAssignment(req.user, Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Employee record not found.' });
  res.json({ record: data });
}));

router.patch('/employees/:id', requireAuth, wrap((req, res) => {
  if (!auth.can(req.user, 'employee.edit') && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You do not have permission to edit employee records.' });
  }
  const updated = emp.updateAssignment(req.user, Number(req.params.id), req.body.changes || {}, {
    expectedRev: req.body.rev || null,
    reason: req.body.reason || 'Inline table edit',
  });
  res.json({ record: updated, savedAt: new Date().toISOString() });
}));

router.get('/employees/:id/history', requireAuth, wrap((req, res) => {
  const data = query.getAssignment(req.user, Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Employee record not found.' });
  const employeeHistory = recentActivity(req.user, {entity: 'employee', entityId: data.employeeId, limit: 50});
  const assignmentHistory = recentActivity(req.user, {entity: 'assignment', entityId: Number(req.params.id), limit: 100});
  const labels = new Map(schema.listFields().map((f) => [f.key, f.label]));
  const merged = [...employeeHistory, ...assignmentHistory]
    .sort((a, b) => b.id - a.id)
    .map((h) => ({ ...h, field_label: labels.get(h.field_key) || (h.field_key ? h.field_key : 'Record') }));
  res.json({ history: merged });
}));

router.post('/employees', requireAuth, wrap((req, res) => {
  if (!auth.can(req.user, 'employee.create') && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You do not have permission to add employees.' });
  }
  const result = emp.createPerson(req.user, req.body || {});
  res.json(result);
}));

// CRM search across the people directory (respects project visibility)
router.get('/people', requireAuth, requireCap('crm.use'), wrap((req, res) => {
  const term = String(req.query.q || '').trim().toLowerCase();
  const acl = access.assignmentScope(req.user, 'can_crm');
  const like = `%${term}%`;
  const rows = q.all(
    `SELECT e.id, e.emp_code, e.name, e.first_name, e.last_name, e.email, e.phone, COUNT(a.id) placements
       FROM employees e JOIN assignments a ON a.employee_id = e.id AND a.active = 1
      WHERE ${acl.sql} AND e.active = 1
        AND (lower(e.emp_code) LIKE ? OR lower(e.name) LIKE ? OR lower(ifnull(e.email,'')) LIKE ? OR ifnull(e.phone,'') LIKE ?)
      GROUP BY e.id ORDER BY e.name LIMIT 25`, ...acl.args, like, like, like, like);
  res.json({ people: rows });
}));

router.get('/people/:id', requireAuth, requireCap('crm.use'), wrap((req, res) => {
  const id = Number(req.params.id);
  const employee = q.get('SELECT * FROM employees WHERE id = ?', id);
  if (!employee) return res.status(404).json({ error: 'Person not found.' });
  const acl = access.assignmentScope(req.user, 'can_crm');
  const placements = q.all(
        `SELECT a.id assignment_id, a.project_id, a.subproject_id, a.category_id, a.status, a.updated_at,
                p.name project_name, s.name subproject_name, c.name category_name, sup.name supplier
           FROM assignments a
           JOIN projects p ON p.id = a.project_id
           JOIN subprojects s ON s.id = a.subproject_id
           JOIN categories c ON c.id = a.category_id
           LEFT JOIN suppliers sup ON sup.id = a.supplier_id
          WHERE a.employee_id = ? AND a.active = 1 AND ${acl.sql}
          ORDER BY p.name`,
        id, ...acl.args
      );
  if (!placements.length && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You do not have access to this person.' });
  }
  res.json({ person: employee, placements });
}));

// ---------------------------------------------------------------------------
// duplicate review queue
// ---------------------------------------------------------------------------
router.get('/duplicates', requireAuth, requireAdmin, wrap((req, res) => {
  const rows = q.all(
    `SELECT d.*, e.name candidate_name, e.emp_code candidate_code
       FROM duplicate_reviews d LEFT JOIN employees e ON e.id = d.candidate_employee_id
      WHERE d.status = ? ORDER BY d.id DESC`,
    req.query.status || 'pending'
  );
  res.json({ reviews: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
}));

router.post('/duplicates/:id/resolve', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const review = q.get('SELECT * FROM duplicate_reviews WHERE id = ?', id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (review.status !== 'pending') return res.status(409).json({ error: 'This review is no longer pending.' });
  const { action } = req.body || {}; // link | create | dismiss
  if (!['link', 'create', 'dismiss'].includes(action)) {
    return res.status(422).json({ error: 'Choose an action: link, create or dismiss.' });
  }
  return tx(() => {
    let linked = null;
    if (action === 'link' && review.candidate_employee_id) {
      linked = review.candidate_employee_id;
      q.run("UPDATE duplicate_reviews SET status = 'linked', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", req.user.id, id);
    } else if (action === 'create') {
      const payload = review.payload || {};
      if (payload.project_id && payload.subproject_id && payload.category_id) {
        const out = emp.createPerson(req.user, { ...payload, emp_code: payload.emp_code || review.emp_code, name: payload.name || review.name });
        linked = out.employeeId;
      }
      q.run("UPDATE duplicate_reviews SET status = 'created', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", req.user.id, id);
    } else {
      q.run("UPDATE duplicate_reviews SET status = 'dismissed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", req.user.id, id);
    }
    record({ entity: 'duplicate_review', entityId: id, ref: review.emp_code, action: 'resolve', newValue: action, actor: req.user });
    res.json({ ok: true, action, employeeId: linked });
  });
}));


// ---------------------------------------------------------------------------
// In-app assistant (§25). Rules-based, offline, propose-only.
// ---------------------------------------------------------------------------
/**
 * Ask a question or request a change. Questions are answered from the database
 * within the caller's project scope; change requests become proposals that an
 * administrator must approve. This endpoint never writes master data.
 */
router.get('/agent/projects', requireAuth, wrap((req, res) => {
  res.json({ projectNames: agent.visibleProjectNames(req.user) });
}));

router.post('/agent/ask', requireAuth, wrap((req, res) => {
  const message = String(req.body?.message || '').trim();
  const language = req.body?.language ?? 'en';
  if (!['en', 'hi'].includes(language)) return res.status(422).json({ error: 'Choose English or Hindi.' });
  if (message.length > 1000) return res.status(422).json({ error: language === 'hi' ? 'सवाल 1,000 अक्षरों तक रखें।' : 'Keep your question under 1,000 characters.' });
  const choice = req.body?.guideChoice;
  if (choice != null && (typeof choice !== 'object' || Array.isArray(choice) ||
      typeof choice.person !== 'string' || choice.person.length > 200 ||
      (choice.placementId != null && (!Number.isSafeInteger(choice.placementId) || choice.placementId < 1)))) {
    return res.status(422).json({ error: 'Invalid employee or placement choice.' });
  }
  const plan = agent.understand(req.user, message, req.body?.projectName, language, choice, req.body?.projectPicked === true);
  let proposal = null;
  if (plan.proposal) {
    // raising a proposal needs the ability to edit at all; approving it is admin-only
    if (!auth.can(req.user, 'employee.edit') && !req.user.isAdmin) {
      return res.status(403).json({ error: 'You do not have permission to request changes.' });
    }
    access.assertAssignment(req.user, plan.proposal.assignmentId, 'can_edit');
    proposal = agentstore.raiseProposal(req.user, plan.proposal, message);
  }
  res.json({
    reply: plan.reply,
    understood: !!plan.understood,
    projectName: plan.projectName || null,
    crm: plan.crm || null,
    ...(plan.guide && { guide: plan.guide }),
    ...(plan.ambiguousProject && { ambiguousProject: true }),
    ...(plan.source && { source: plan.source }),
    kind: plan.kind || 'answer',
    table: plan.table || null,
    data: plan.data || null,
    suggestions: plan.suggestions || [],
    proposal,
  });
}));

router.get('/agent/proposals', requireAuth, wrap((req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const name = req.query.projectName ? String(req.query.projectName) : null;
  res.json({ proposals: agentstore.listProposals(req.user, status, name), pending: agentstore.pendingCount(req.user, name) });
}));

router.post('/agent/proposals/:id/approve', requireAuth, requireAdmin, wrap((req, res) => {
  const out = agentstore.approve(req.user, Number(req.params.id), req.body?.note || null);
  res.json({ ...out, message: 'Approved and saved to the database.' });
}));

router.post('/agent/proposals/:id/reject', requireAuth, requireAdmin, wrap((req, res) => {
  res.json({ proposal: agentstore.reject(req.user, Number(req.params.id), req.body?.note || null), message: 'Rejected. Nothing was changed.' });
}));

// ---------------------------------------------------------------------------
// CRM panel configuration
// ---------------------------------------------------------------------------
/**
 * Which columns the CRM / Update panel offers. Read by every role (the panel has
 * to render), written only by an administrator.
 */
router.get('/settings/crm-fields', requireAuth, wrap((req, res) => {
  const keys = schema.crmKeys();
  res.json({
    keys,
    fields: schema.listFields(req.user).filter((f) => keys.includes(f.key)),
    available: schema.listFields().map((f) => ({ key: f.key, label: f.label, type: f.type, group: f.group })),
  });
}));

router.put('/settings/crm-fields', requireAuth, requireCap('schema.manage'), wrap((req, res) => {
  const keys = schema.setCrmKeys(req.body?.keys || [], req.user);
  res.json({ keys, fields: schema.listFields().filter((f) => keys.includes(f.key)) });
}));

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------
router.get('/export', requireAuth, requireCap('export.data'), wrap(async (req, res) => {
  const scope = {
    ...Object.fromEntries(Object.entries(req.query).filter(([k]) => k.startsWith('f_') || k === 'search' || k === 'status')),
    projectId: asInt(req.query.projectId),
    subprojectId: asInt(req.query.subprojectId),
    categoryId: asInt(req.query.categoryId),
    supplierId: asInt(req.query.supplierId),
  };
  for (const k of Object.keys(scope)) if (!scope[k]) delete scope[k];
  if (scope.projectId) emp.assertProjectAccess(req.user, scope.projectId, 'can_export');
  if (scope.subprojectId) {
    const sub = q.get('SELECT * FROM subprojects WHERE id = ?', scope.subprojectId);
    if (sub) emp.assertProjectAccess(req.user, sub.project_id, 'can_export');
  }
  const parts = ['resource-planning'];
  if (scope.projectId) parts.push(`project-${scope.projectId}`);
  if (scope.subprojectId) parts.push(`subproject-${scope.subprojectId}`);
  if (scope.categoryId) parts.push(`category-${scope.categoryId}`);
  if (scope.supplierId) parts.push(`supplier-${scope.supplierId}`);
  if (req.query.forReplacement === '1') {
    if (!req.user.isAdmin || req.user.gigaAccess) throw access.denied('Administrator access required.');
    if (Object.keys(scope).length) throw access.invalid('Export the complete unfiltered roster before replacing it.');
    res.setHeader('X-Roster-Receipt', rosterCycle.startExport(req.user));
    parts.push('before-replacement', new Date().toISOString().replace(/[:.]/g, '-'));
  } else parts.push(new Date().toISOString().slice(0, 10));
  await excel.streamWorkbook(res, req.user, scope, `${parts.join('-')}.xlsx`);
  record({ entity: 'export', entityId: null, ref: parts.join('-'), action: 'export', actor: req.user, meta: scope });
}));

// ---------------------------------------------------------------------------
// import & synchronization
// ---------------------------------------------------------------------------
const importRoute = replace => wrap(async (req, res) => {
  const { filename, content, force, dryRun, projectId, subprojectId, categoryId } = req.body || {};
  if (!content) return res.status(422).json({ error: 'Choose an Excel (.xlsx) file to upload.' });
  if (replace && !/\.xlsx$/i.test(filename || '')) throw access.invalid('Choose a complete .xlsx workbook.');
  const buffer = workbookBytes(content);
  // Your HR master workbook carries no Project / Subproject / Category column.
  // The chosen placement (or the database's single category) files the people.
  const defaultPlacement = Number(categoryId) && Number(subprojectId) && Number(projectId)
    ? { projectId: Number(projectId), subprojectId: Number(subprojectId), categoryId: Number(categoryId) }
    : null;
  const result = await excel.importWorkbook(req.user, buffer, {
    filename: filename || 'upload.xlsx', force: !!force, dryRun: !!dryRun, defaultPlacement,
    replace: replace ? { receipt: req.body.receipt, confirmation: req.body.confirmation } : null,
  });
  res.json({ result });
});
router.post('/import', requireAuth, requireCap('import.data'), importRoute(false));
router.post('/import/replace', requireAuth, requireAdmin, importRoute(true));

// the file you fill in: your own 65 headers plus the 3 placement columns
router.get('/import/template', requireAuth, requireCap('import.data'), wrap(async (req, res) => {
  const wb = await excel.buildTemplateWorkbook({});
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="resource-planning-import-template.xlsx"');
  await sendWorkbook(res, wb);
}));

router.get('/imports', requireAuth, wrap((req, res) => {
  // One master upload can contain many unrelated Giga projects.
  if (req.user.gigaAccess) return res.json({ imports: [] });
  res.json({
    imports: q.all(
      `SELECT i.*, u.name uploaded_by_name FROM imports i LEFT JOIN users u ON u.id = i.uploaded_by ORDER BY i.id DESC LIMIT 20`
    ),
  });
}));

// ---------------------------------------------------------------------------
// users & access control
// ---------------------------------------------------------------------------
router.get('/users', requireAuth, requireAdmin, wrap((req, res) => {
  const users = q.all('SELECT id, email, name, role, title, active, created_at FROM users ORDER BY role, name')
    .map((u) => {
      const gigaAccess = u.role === 'admin' ? null : access.gigaGrant(u.id);
      return { ...u, gigaAccess,
        // Admins implicitly hold every grant; expose the full list so the UI can
        // render them consistently with supervisors.
        projects: u.role === 'admin'
          ? q.all('SELECT id AS project_id, name, 1 AS can_edit, 1 AS can_export, 1 AS can_crm FROM projects ORDER BY name')
          : q.all(
              `SELECT up.project_id, p.name, up.can_edit, up.can_export, up.can_crm
                 FROM user_projects up JOIN projects p ON p.id = up.project_id WHERE up.user_id = ?`,
              u.id
            ),
        capabilities: auth.capabilitiesFor(u, gigaAccess),
      };
    });
  res.json({ users, capabilities: auth.ALL_CAPABILITIES, gigaCapabilities: access.GIGA_CAPABILITIES, gigaProjectNames: access.gigaNames() });
}));

// Called inside the account transaction. A stale grant must fail the whole
// write, not leave a sign-in behind which the administrator cannot retry.
function writeUserAccess(id, { projects, capabilities, gigaProjectName }) {
  const current = access.gigaGrant(id);
  if (gigaProjectName !== undefined || current) {
    if (projects !== undefined) throw access.invalid('Choose either a Giga project or hierarchy grants, not both.');
    if (gigaProjectName !== undefined) access.setGigaGrant(id, gigaProjectName);
    // Changing from hierarchy to Giga must not carry over master-data privileges.
    q.run(`DELETE FROM user_capabilities WHERE user_id = ? AND capability NOT IN (${access.GIGA_CAPABILITIES.map(() => '?').join(',')})`,
      id, ...access.GIGA_CAPABILITIES);
  }
  if (projects !== undefined) {
    if (!Array.isArray(projects)) throw Object.assign(new Error('Expected a list of project grants.'), { status: 422 });
    q.run('DELETE FROM user_projects WHERE user_id = ?', id);
    const seen = new Set();
    const flag = (v) => v === undefined || v === true || v === 1 ? 1 : 0;
    for (const grant of projects) {
      const pid = Number(grant?.project_id ?? grant?.id);
      if (!Number.isSafeInteger(pid) || seen.has(pid) || !q.get('SELECT id FROM projects WHERE id = ?', pid)) {
        throw Object.assign(new Error('A project grant is invalid or duplicated. Refresh the project list and try again.'), { status: 422 });
      }
      seen.add(pid);
      q.run('INSERT INTO user_projects (user_id, project_id, can_edit, can_export, can_crm) VALUES (?, ?, ?, ?, ?)',
        id, pid, flag(grant.can_edit), flag(grant.can_export), flag(grant.can_crm));
    }
  }
  if (capabilities !== undefined) {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      throw Object.assign(new Error('Expected a set of capabilities.'), { status: 422 });
    }
    for (const [cap, allowed] of Object.entries(capabilities)) {
      if (!auth.ALL_CAPABILITIES.includes(cap)) throw access.invalid(`Unknown capability: ${cap}`);
      if ((current || gigaProjectName !== undefined) && !access.GIGA_CAPABILITIES.includes(cap)) {
        if (allowed) throw access.invalid('Global capabilities cannot be granted to a Giga-scoped account.');
        continue;
      }
      q.run(`INSERT INTO user_capabilities (user_id, capability, allowed) VALUES (?, ?, ?)
             ON CONFLICT(user_id, capability) DO UPDATE SET allowed = excluded.allowed`,
        id, cap, allowed === true || allowed === 1 ? 1 : 0);
    }
  }
}

function accountName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw access.invalid('Enter a display name for this account.');
  if (name.length > 160) throw access.invalid('The display name must be 160 characters or fewer.');
  return name;
}

function accountForEdit(id) {
  const user = q.get('SELECT id, email, role, name FROM users WHERE id = ?', id);
  if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
  return user;
}

// Call inside the edit transaction: a failed grant change must also roll back
// the rename and its audit entry. The email and session identity never change.
function renameAccount(user, value, actor) {
  const name = accountName(value);
  if (name !== user.name) {
    q.run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
    record({ entity: 'user', entityId: user.id, ref: user.email, action: 'update', fieldKey: 'name',
      oldValue: user.name, newValue: name, actor });
  }
  return name;
}

router.post('/users', requireAuth, requireAdmin, wrap((req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim();
  const name = accountName(body.name);
  const role = body.role === 'admin' ? 'admin' : 'supervisor';
  if (role === 'admin' && body.gigaProjectName !== undefined) throw access.invalid('Administrator accounts cannot be restricted to a Giga project.');
  if (!email) throw access.invalid('Email is required.');
  if (typeof body.password !== 'string' || body.password.length < 8) return res.status(422).json({ error: 'Use a password of at least 8 characters.' });
  const user = tx(() => {
    if (q.get('SELECT id FROM users WHERE lower(email) = lower(?)', email)) {
      throw Object.assign(new Error('A user with that email already exists.'), { status: 422 });
    }
    const r = q.run('INSERT INTO users (email, name, role, title, password_hash) VALUES (?, ?, ?, ?, ?)',
      email, name, role, body.title || null, auth.hashPassword(body.password));
    const id = Number(r.lastInsertRowid);
    if (role !== 'admin') writeUserAccess(id, body);
    record({ entity: 'user', entityId: id, ref: email, action: 'create', newValue: `${name} (${role})`, actor: req.user });
    return q.get('SELECT id, email, name, role, title FROM users WHERE id = ?', id);
  });
  res.json({ user });
}));

router.delete('/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(422).json({ error: 'You cannot delete your own account.' });
  tx(() => {
    const target = q.get('SELECT email, name, role, active FROM users WHERE id = ?', id);
    if (!target) throw Object.assign(new Error('User not found.'), { status: 404 });
    if (target.role === 'admin' && target.active && !q.get("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", id)) {
      throw Object.assign(new Error('At least one administrator must remain.'), { status: 422 });
    }
    // Keep the work. These nullable author references in existing databases
    // do not cascade. Audit and proposal rows already carry author names;
    // retain the assignment's Last Updated By for the table and export too.
    q.run('UPDATE employees SET created_by = NULL WHERE created_by = ?', id);
    q.run('UPDATE employees SET updated_by = NULL WHERE updated_by = ?', id);
    q.run('UPDATE assignments SET archived_updater_name = ?, updated_by = NULL WHERE updated_by = ?', target.name, id);
    q.run('UPDATE assignment_values SET updated_by = NULL WHERE updated_by = ?', id);
    q.run('UPDATE imports SET uploaded_by = NULL WHERE uploaded_by = ?', id);
    q.run('UPDATE import_jobs SET user_id = NULL WHERE user_id = ?', id);
    q.run('UPDATE agent_actions SET requested_by = NULL WHERE requested_by = ?', id);
    q.run('UPDATE agent_actions SET decided_by = NULL WHERE decided_by = ?', id);
    // Only credentials, sessions and access grants are removed.
    q.run('DELETE FROM users WHERE id = ?', id);
    record({ entity: 'user', entityId: id, ref: target.email, action: 'delete', oldValue: `${target.name} (${target.role})`, actor: req.user });
  });
  res.json({ ok: true });
}));

router.patch('/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id), body = req.body || {};
  const user = tx(() => {
    const target = accountForEdit(id);
    if (Object.hasOwn(body, 'name')) renameAccount(target, body.name, req.user);
    const sets = [], args = [];
    for (const k of ['role', 'title', 'active']) {
      if (body[k] === undefined) continue;
      sets.push(`${k} = ?`); args.push(body[k]);
    }
    if (body.password) {
      if (String(body.password).length < 8) throw access.invalid('Use a password of at least 8 characters.');
      sets.push('password_hash = ?'); args.push(auth.hashPassword(String(body.password)));
    }
    if (sets.length) {
      q.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
      record({ entity: 'user', entityId: id, ref: target.email, action: 'update', actor: req.user });
    }
    return q.get('SELECT id, email, name, role, title, active FROM users WHERE id = ?', id);
  });
  res.json({ user });
}));

router.put('/users/:id/access', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id), body = req.body || {};
  const user = tx(() => {
    const target = accountForEdit(id);
    const grantKeys = ['projects', 'capabilities', 'gigaProjectName'];
    const editGrants = grantKeys.some((k) => Object.hasOwn(body, k));
    if (Object.keys(body).some((k) => k !== 'name' && !grantKeys.includes(k))) {
      throw access.invalid('Only the display name and access settings can be changed here.');
    }
    if (editGrants && target.role === 'admin') throw access.invalid('Administrators have full access. Only the display name can be changed here.');
    const name = Object.hasOwn(body, 'name') ? renameAccount(target, body.name, req.user) : target.name;
    if (editGrants) {
      const before = access.gigaGrant(id);
      writeUserAccess(id, body);
      const after = access.gigaGrant(id);
      const label = (grant) => grant ? grant.name || 'No project access' : 'Hierarchy grants';
      record({ entity: 'user', entityId: id, ref: target.email, action: 'update', fieldKey: 'access',
        oldValue: label(before), newValue: label(after), actor: req.user });
    }
    return { id, name };
  });
  res.json({ ok: true, user });
}));

// ---------------------------------------------------------------------------
// audit trail
// ---------------------------------------------------------------------------
router.get('/audit', requireAuth, requireCap('audit.view'), wrap((req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({ activity: recentActivity(req.user, { limit, entity: req.query.entity || undefined }) });
}));

router.get('/audit/:entity/:id', requireAuth, requireCap('audit.view'), wrap((req, res) => {
  res.json({ history: recentActivity(req.user, { entity: req.params.entity, entityId: Number(req.params.id), limit: 200 }) });
}));

// ---------------------------------------------------------------------------
// error handler
// ---------------------------------------------------------------------------
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || 'Something went wrong. Please try again.',
    errors: err.errors || null,
    code: err.code || null,
    current: err.current || null,
  });
});

module.exports = { router, visibleProjectIds: auth.visibleProjectIds };
