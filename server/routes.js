'use strict';
const express = require('express');
const { q, tx } = require('./db');
const auth = require('./auth');
const schema = require('./schema');
const emp = require('./employees');
const excel = require('./excel');
const { record, historyFor, recentActivity } = require('./audit');

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
  const fields = schema.listFields();
  res.json({
    user: req.user,
    tree,
    fields,
    suppliers: q.all('SELECT * FROM suppliers WHERE active = 1 ORDER BY name'),
    statusCounts: statusCounts(req.user),
    totals: totals(req.user),
  });
}));

function visibleProjectIds(user) {
  return user.isAdmin ? q.all('SELECT id FROM projects').map((r) => r.id) : user.projects.map((p) => p.id);
}

function totals(user) {
  const ids = visibleProjectIds(user);
  if (!ids.length) return { employees: 0, assignments: 0, projects: 0, suppliers: 0, pendingReviews: 0 };
  const ph = ids.map(() => '?').join(',');
  const employees = Number(q.get(
    `SELECT COUNT(DISTINCT employee_id) c FROM assignments WHERE active = 1 AND project_id IN (${ph})`, ...ids
  ).c);
  const assignments = Number(q.get(
    `SELECT COUNT(*) c FROM assignments WHERE active = 1 AND project_id IN (${ph})`, ...ids
  ).c);
  return {
    employees,
    assignments,
    projects: treeCount(user),
    suppliers: Number(q.get('SELECT COUNT(*) c FROM suppliers WHERE active = 1').c),
    pendingReviews: user.isAdmin ? Number(q.get("SELECT COUNT(*) c FROM duplicate_reviews WHERE status = 'pending'").c) : 0,
  };
}

function treeCount(user) {
  const ids = visibleProjectIds(user);
  return ids.length;
}

function statusCounts(user) {
  const ids = visibleProjectIds(user);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return q.all(
    `SELECT status, COUNT(*) c FROM assignments WHERE active = 1 AND project_id IN (${ph}) GROUP BY status ORDER BY c DESC`,
    ...ids
  );
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', requireAuth, wrap((req, res) => {
  const ids = visibleProjectIds(req.user);
  if (!ids.length) {
    return res.json({ totals: totals(req.user), byProject: [], byStatus: [], bySupplier: [], byCategory: [], activity: [], attention: [] });
  }
  const ph = ids.map(() => '?').join(',');

  const byProject = q.all(
    `SELECT p.id, p.name, p.code, COUNT(a.id) c,
            SUM(CASE WHEN a.status = 'Active' THEN 1 ELSE 0 END) active
       FROM projects p LEFT JOIN assignments a ON a.project_id = p.id AND a.active = 1
      WHERE p.id IN (${ph}) GROUP BY p.id ORDER BY c DESC`,
    ...ids
  );

  const byStatus = q.all(
    `SELECT status, COUNT(*) c FROM assignments WHERE active = 1 AND project_id IN (${ph}) GROUP BY status ORDER BY c DESC`,
    ...ids
  );

  const bySupplier = q.all(
    `SELECT ifnull(sup.name, 'Unassigned') name, COUNT(*) c
       FROM assignments a LEFT JOIN suppliers sup ON sup.id = a.supplier_id
      WHERE a.active = 1 AND a.project_id IN (${ph})
      GROUP BY sup.id ORDER BY c DESC LIMIT 8`,
    ...ids
  );

  const byCategory = q.all(
    `SELECT c.name, COUNT(a.id) c FROM categories c
       JOIN subprojects s ON s.id = c.subproject_id
       LEFT JOIN assignments a ON a.category_id = c.id AND a.active = 1
      WHERE s.project_id IN (${ph})
      GROUP BY c.id ORDER BY c DESC LIMIT 10`,
    ...ids
  );

  const attention = q.all(
    `SELECT a.id assignment_id, e.emp_code, e.name, a.status, a.updated_at,
            p.name project_name, s.name subproject_name, c.name category_name
       FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       JOIN projects p ON p.id = a.project_id
       JOIN subprojects s ON s.id = a.subproject_id
       JOIN categories c ON c.id = a.category_id
      WHERE a.active = 1 AND a.project_id IN (${ph})
        AND (a.status IN ('On Leave', 'Billing Hold', 'Released') OR a.supplier_id IS NULL)
      ORDER BY a.updated_at DESC LIMIT 8`,
    ...ids
  );

  const trend = q.all(
    `SELECT substr(at, 1, 10) day, COUNT(*) c FROM audit_log
      WHERE at >= date('now', '-13 day') GROUP BY day ORDER BY day`,
  );

  res.json({
    totals: totals(req.user),
    byProject,
    byStatus,
    bySupplier,
    byCategory,
    activity: recentActivity({ projectIds: req.user.isAdmin ? null : ids, limit: 12 }),
    attention,
    trend,
  });
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
  res.json({ suppliers: q.all('SELECT * FROM suppliers ORDER BY name') });
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
  res.json({ fields: schema.listFields() });
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
  const configured = q.all('SELECT * FROM category_fields WHERE category_id = ?', categoryId);
  const configuredMap = new Map(configured.map((c) => [c.field_id, c]));
  const all = schema.listFields().map((f) => {
    const c = configuredMap.get(f.id);
    return {
      ...f,
      visible: c ? !!c.visible : true,
      editable: c ? !!c.editable : true,
      required: c ? !!c.required : false,
      configured: !!c,
      canHide: !f.system,
    };
  });
  res.json({ category: cat, fields: all, isConfigured: configured.length > 0 });
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
  res.json(emp.listEmployees(req.user, params));
}));

router.get('/employees/:id', requireAuth, wrap((req, res) => {
  const data = emp.getAssignment(Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Employee record not found.' });
  emp.assertProjectAccess(req.user, data.projectId);
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
  const data = emp.getAssignment(Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Employee record not found.' });
  emp.assertProjectAccess(req.user, data.projectId);
  const employeeHistory = historyFor('employee', data.employeeId, 50);
  const assignmentHistory = historyFor('assignment', Number(req.params.id), 100);
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
router.get('/people', requireAuth, wrap((req, res) => {
  const term = String(req.query.q || '').trim().toLowerCase();
  const ids = visibleProjectIds(req.user);
  if (!ids.length) return res.json({ people: [] });
  const ph = ids.map(() => '?').join(',');
  const like = `%${term}%`;
  const rows = q.all(
    `SELECT DISTINCT e.id, e.emp_code, e.name, e.email, e.phone, e.designation,
            (SELECT COUNT(*) FROM assignments a2 WHERE a2.employee_id = e.id AND a2.active = 1 AND a2.project_id IN (${ph})) placements
       FROM employees e
       JOIN assignments a ON a.employee_id = e.id AND a.active = 1
      WHERE a.project_id IN (${ph}) AND e.active = 1
        AND (lower(e.emp_code) LIKE ? OR lower(e.name) LIKE ? OR lower(ifnull(e.email,'')) LIKE ? OR ifnull(e.phone,'') LIKE ?)
      ORDER BY e.name LIMIT 25`,
    ...ids, ...ids, like, like, like, like
  );
  res.json({ people: rows });
}));

router.get('/people/:id', requireAuth, wrap((req, res) => {
  const id = Number(req.params.id);
  const employee = q.get('SELECT * FROM employees WHERE id = ?', id);
  if (!employee) return res.status(404).json({ error: 'Person not found.' });
  const ids = visibleProjectIds(req.user);
  const placements = ids.length
    ? q.all(
        `SELECT a.id assignment_id, a.project_id, a.subproject_id, a.category_id, a.status, a.updated_at,
                p.name project_name, s.name subproject_name, c.name category_name, sup.name supplier
           FROM assignments a
           JOIN projects p ON p.id = a.project_id
           JOIN subprojects s ON s.id = a.subproject_id
           JOIN categories c ON c.id = a.category_id
           LEFT JOIN suppliers sup ON sup.id = a.supplier_id
          WHERE a.employee_id = ? AND a.active = 1 AND a.project_id IN (${ids.map(() => '?').join(',')})
          ORDER BY p.name`,
        id, ...ids
      )
    : [];
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
// exports
// ---------------------------------------------------------------------------
router.get('/export', requireAuth, requireCap('export.data'), wrap(async (req, res) => {
  const scope = {
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
  parts.push(new Date().toISOString().slice(0, 10));
  await excel.streamWorkbook(res, req.user, scope, `${parts.join('-')}.xlsx`);
  record({ entity: 'export', entityId: null, ref: parts.join('-'), action: 'export', actor: req.user, meta: scope });
}));

// ---------------------------------------------------------------------------
// import & synchronization
// ---------------------------------------------------------------------------
router.post('/import', requireAuth, requireCap('import.data'), wrap(async (req, res) => {
  const { filename, content, force, dryRun } = req.body || {};
  if (!content) return res.status(422).json({ error: 'Choose an Excel (.xlsx) file to upload.' });
  const buffer = Buffer.from(String(content).split(',').pop(), 'base64');
  const result = await excel.importWorkbook(req.user, buffer, { filename: filename || 'upload.xlsx', force: !!force, dryRun: !!dryRun });
  res.json({ result });
}));

router.get('/imports', requireAuth, wrap((req, res) => {
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
    .map((u) => ({
      ...u,
      // Admins implicitly hold every grant; expose the full list so the UI can
      // render them consistently with supervisors.
      projects: u.role === 'admin'
        ? q.all('SELECT id AS project_id, name, 1 AS can_edit, 1 AS can_export, 1 AS can_crm FROM projects ORDER BY name')
        : q.all(
            `SELECT up.project_id, p.name, up.can_edit, up.can_export, up.can_crm
               FROM user_projects up JOIN projects p ON p.id = up.project_id WHERE up.user_id = ?`,
            u.id
          ),
      capabilities: Object.fromEntries(
        q.all('SELECT capability, allowed FROM user_capabilities WHERE user_id = ?', u.id).map((c) => [c.capability, !!c.allowed])
      ),
    }));
  res.json({ users, capabilities: auth.ALL_CAPABILITIES });
}));

router.post('/users', requireAuth, requireAdmin, wrap((req, res) => {
  const { email, name, role, password, title } = req.body || {};
  if (!email || !name) return res.status(422).json({ error: 'Name and email are required.' });
  if (q.get('SELECT id FROM users WHERE lower(email) = lower(?)', email)) {
    return res.status(422).json({ error: 'A user with that email already exists.' });
  }
  if (String(password || '').length < 8) return res.status(422).json({ error: 'Use a password of at least 8 characters.' });
  const r = q.run(
    'INSERT INTO users (email, name, role, title, password_hash) VALUES (?, ?, ?, ?, ?)',
    email, name, role === 'admin' ? 'admin' : 'supervisor', title || null, auth.hashPassword(password)
  );
  const id = Number(r.lastInsertRowid);
  record({ entity: 'user', entityId: id, ref: email, action: 'create', newValue: `${name} (${role})`, actor: req.user });
  res.json({ user: q.get('SELECT id, email, name, role, title FROM users WHERE id = ?', id) });
}));

router.patch('/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const before = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'User not found.' });
  const allowed = ['name', 'role', 'title', 'active'];
  const sets = []; const args = [];
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k} = ?`); args.push(req.body[k]);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(422).json({ error: 'Use a password of at least 8 characters.' });
    sets.push('password_hash = ?'); args.push(auth.hashPassword(String(req.body.password)));
  }
  if (sets.length) q.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  record({ entity: 'user', entityId: id, ref: before.email, action: 'update', actor: req.user });
  res.json({ user: q.get('SELECT id, email, name, role, title, active FROM users WHERE id = ?', id) });
}));

router.put('/users/:id/access', requireAuth, requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const { projects, capabilities } = req.body || {};
  return tx(() => {
    if (Array.isArray(projects)) {
      q.run('DELETE FROM user_projects WHERE user_id = ?', id);
      for (const p of projects) {
        q.run(
          `INSERT INTO user_projects (user_id, project_id, can_edit, can_export, can_crm) VALUES (?, ?, ?, ?, ?)`,
          id, Number(p.project_id ?? p.id), p.can_edit === false ? 0 : 1, p.can_export === false ? 0 : 1, p.can_crm === false ? 0 : 1
        );
      }
    }
    if (capabilities && typeof capabilities === 'object') {
      for (const [cap, allowed] of Object.entries(capabilities)) {
        q.run(
          `INSERT INTO user_capabilities (user_id, capability, allowed) VALUES (?, ?, ?)
           ON CONFLICT(user_id, capability) DO UPDATE SET allowed = excluded.allowed`,
          id, cap, allowed ? 1 : 0
        );
      }
    }
    record({ entity: 'user', entityId: id, action: 'update', fieldKey: 'access', newValue: 'access policy updated', actor: req.user });
    res.json({ ok: true });
  });
}));

// ---------------------------------------------------------------------------
// audit trail
// ---------------------------------------------------------------------------
router.get('/audit', requireAuth, wrap((req, res) => {
  const ids = visibleProjectIds(req.user);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const entity = req.query.entity;
  const rows = entity
    ? q.all('SELECT * FROM audit_log WHERE entity = ? ORDER BY id DESC LIMIT ?', entity, limit)
    : recentActivity({ projectIds: req.user.isAdmin ? null : ids, limit });
  if (!req.user.isAdmin) {
    // supervisors only see activity tied to their projects
    const visible = rows.filter((r) => !r.project_id || ids.includes(r.project_id));
    return res.json({ activity: visible });
  }
  res.json({ activity: rows });
}));

router.get('/audit/:entity/:id', requireAuth, wrap((req, res) => {
  res.json({ history: historyFor(req.params.entity, Number(req.params.id), 200) });
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

module.exports = { router, visibleProjectIds };
