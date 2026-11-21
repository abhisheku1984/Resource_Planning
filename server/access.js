'use strict';
const { q } = require('./db');

// Bound names (never LIKE, a text search or a client-supplied table filter).
// A Giga grant is an alternative to legacy hierarchy grants, not their union.
const GIGA_CAPABILITIES = ['project.view', 'employee.edit', 'employee.create', 'crm.use', 'export.data', 'audit.view'];
const denied = (message = 'This record is outside your project access.') => Object.assign(new Error(message), { status: 403 });
const invalid = (message) => Object.assign(new Error(message), { status: 422 });

function gigaNames() {
  return q.all('SELECT DISTINCT project_name FROM giga_assignments ORDER BY project_name COLLATE NOCASE, project_name').map((r) => r.project_name);
}
function gigaGrant(userId) {
  return q.get('SELECT project_name AS name FROM user_giga_access WHERE user_id = ?', userId) || null;
}
function setGigaGrant(id, name) {
  if (typeof name === 'string') name = name.trim();
  if (name !== null && (typeof name !== 'string' || name === '' ||
      (!q.get('SELECT 1 FROM giga_assignments WHERE project_name = ? LIMIT 1', name) && gigaGrant(id)?.name !== name))) {
    throw invalid('Choose a Giga Project Name from the current workbook data, or select No project access.');
  }
  q.run(`INSERT INTO user_giga_access (user_id, project_name) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET project_name = excluded.project_name`, id, name);
  q.run('DELETE FROM user_projects WHERE user_id = ?', id);
  q.run('DELETE FROM user_subprojects WHERE user_id = ?', id);
}

/** SQL predicate for assignments aliased `a`. Apply before counts, pagination,
 *  aggregation and export. Callers can narrow this predicate, never replace it. */
function assignmentScope(user, flag = null) {
  if (user.isAdmin) return { sql: '1', args: [] };
  if (user.gigaAccess) {
    const name = user.gigaAccess.name;
    const cap = { can_edit: 'employee.edit', can_crm: 'crm.use', can_export: 'export.data' }[flag];
    if (!name || (cap && !user.capabilities[cap])) return { sql: '0', args: [] };
    return { sql: 'a.id IN (SELECT assignment_id FROM giga_assignments WHERE project_name = ?)', args: [name] };
  }
  const ids = user.projects.filter((p) => !flag || p[flag]).map((p) => p.id);
  return { sql: `a.project_id IN (${ids.map(() => '?').join(',') || 'NULL'})`, args: ids };
}

// Suppliers are shared reference data. For Giga accounts expose only suppliers
// already serving their assignments, including the options in field metadata.
function suppliersFor(user, activeOnly = false) {
  const where = [activeOnly ? 'active = 1' : '1'];
  const args = [];
  if (user?.gigaAccess) {
    const acl = assignmentScope(user);
    where.push(`id IN (SELECT a.supplier_id FROM assignments a WHERE ${acl.sql})`);
    args.push(...acl.args);
  }
  return q.all(`SELECT * FROM suppliers WHERE ${where.join(' AND ')} ORDER BY name`, ...args);
}

function assertAssignment(user, id, flag) {
  if (user.isAdmin) return;
  const acl = assignmentScope(user, flag);
  if (!q.get(`SELECT 1 FROM assignments a WHERE a.id = ? AND ${acl.sql}`, id, ...acl.args)) throw denied();
}

// Placement names/layouts are only navigable when that branch has a visible row.
function assertGigaPlacement(user, { projectId, subprojectId, categoryId }) {
  if (!user.gigaAccess || user.isAdmin) return;
  const where = ['project_name = ?'];
  const args = [user.gigaAccess.name];
  for (const [key, id] of [['project_id', projectId], ['subproject_id', subprojectId], ['category_id', categoryId]]) {
    if (id != null) { where.push(`${key} = ?`); args.push(id); }
  }
  if (where.length > 1 && !q.get(`SELECT 1 FROM giga_assignments WHERE ${where.join(' AND ')} LIMIT 1`, ...args)) {
    throw denied('This placement is outside your Giga project.');
  }
}

module.exports = { GIGA_CAPABILITIES, gigaNames, gigaGrant, setGigaGrant, assignmentScope, suppliersFor, assertAssignment, assertGigaPlacement, denied, invalid };
