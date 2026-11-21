'use strict';
const { q, tx } = require('./db');
const { record } = require('./audit');
const schema = require('./schema');
const { getAssignment } = require('./query');
const { assignmentScope, assertAssignment, assertGigaPlacement, suppliersFor, denied } = require('./access');

/**
 * Employee records live in two places:
 *  - identity (emp_code, first/last name, email, phone) -> employees table
 *  - the rest of the configurable columns                  -> assignment values
 *
 * Every "row" on an employee table is an *assignment*: a person placed in a
 * project / subproject / category, optionally for a supplier. This lets one
 * person appear in several projects without being duplicated.
 */

const MAPPED = {
  emp_code: { table: 'e', column: 'emp_code' },
  name: { table: 'e', column: 'name' },
  first_name: { table: 'e', column: 'first_name' },
  last_name: { table: 'e', column: 'last_name' },
  email: { table: 'e', column: 'email' },
  phone: { table: 'e', column: 'phone' },
  status: { table: 'a', column: 'status' },
  supplier: { table: 'sup', column: 'name' },
  remarks: { table: 'a', column: 'remarks' },
};

function valueColumn(key, fieldId) {
  return `f_${key.replace(/[^a-z0-9_]/gi, '_')}_${fieldId}`;
}

/** Resolve a supplier name to an id, creating it when needed. */
function supplierIdFor(name, actor) {
  if (!name) return null;
  const clean = String(name).trim();
  if (!clean) return null;
  if (actor?.gigaAccess) {
    const supplier = suppliersFor(actor, true).find((s) => s.name === clean);
    if (!supplier) throw denied('Choose a supplier already serving your Giga project.');
    return supplier.id;
  }
  const found = q.get('SELECT id FROM suppliers WHERE lower(name) = lower(?)', clean);
  if (found) return found.id;
  const code = clean.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  const exists = q.get('SELECT id FROM suppliers WHERE code = ?', code);
  const finalCode = exists ? `${code}-${Date.now().toString().slice(-4)}` : code;
  const res = q.run('INSERT INTO suppliers (code, name) VALUES (?, ?)', finalCode, clean);
  record({ entity: 'supplier', entityId: Number(res.lastInsertRowid), ref: clean, action: 'create', newValue: clean, actor });
  return Number(res.lastInsertRowid);
}

/**
 * Build the dynamic SELECT for an employee table.
 * Only columns configured as visible for the selected category are returned.
 */
function buildRowQuery({ projectId, subprojectId, categoryId }, user) {
  const categoryIdForColumns = categoryId
    ? categoryId
    : null;
  // With no category selected we show a compact, cross-category default set
  // instead of every configurable field (which would make the table unusable).
  const DEFAULT_KEYS = ['emp_code', 'first_name', 'last_name', 'supplier', 'status', 'remarks'];
  const columns = categoryIdForColumns
    ? schema.columnsForCategory(categoryIdForColumns, user)
    : schema.listFields(user)
        .filter((f) => DEFAULT_KEYS.includes(f.key))
        .sort((a, b) => DEFAULT_KEYS.indexOf(a.key) - DEFAULT_KEYS.indexOf(b.key));

  const selects = [
    'a.id AS assignment_id',
    'a.project_id',
    'a.subproject_id',
    "a.category_id",
    'a.supplier_id',
    'a.updated_at AS assignment_updated_at',
    'a.rev AS assignment_rev',
    'a.created_at AS assignment_created_at',
    'e.id AS employee_id',
    'e.updated_at AS employee_updated_at',
    'e.emp_code',
    'e.name',
    'e.email',
    'e.phone',
    'e.first_name', 'e.last_name',
    'a.status',
    'a.remarks',
    'a.updated_by',
    'p.name AS project_name',
    'p.code AS project_code',
    's.name AS subproject_name',
    'c.name AS category_name',
    'sup.name AS supplier',
    'COALESCE(u.name, a.archived_updater_name) AS updated_by_name',
  ];
  const joins = [];
  const dynamic = [];
  for (const col of columns) {
    if (MAPPED[col.key]) continue;
    const alias = valueColumn(col.key, col.id);
    joins.push(`LEFT JOIN assignment_values ${alias} ON ${alias}.assignment_id = a.id AND ${alias}.field_id = ${col.id}`);
    selects.push(`${alias}.value AS ${alias}`);
    dynamic.push({ field: col, alias });
  }

  const sql = `
    SELECT ${selects.join(', ')}
      FROM assignments a
      JOIN employees e ON e.id = a.employee_id
      JOIN projects p ON p.id = a.project_id
      JOIN subprojects s ON s.id = a.subproject_id
      JOIN categories c ON c.id = a.category_id
      LEFT JOIN suppliers sup ON sup.id = a.supplier_id
      LEFT JOIN users u ON u.id = a.updated_by
      ${joins.join('\n')}
     WHERE a.active = 1 AND e.active = 1`;
  return { sql, columns, dynamic };
}

/** Columns/filters/sort/search/pagination for the employee data table. */
function listEmployees(user, params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(params.pageSize) || 25));
  const { projectId, subprojectId, categoryId } = params;

  // ---- scope enforcement (backend, never trust the client) ----
  const allowedProjectIds = user.isAdmin
    ? q.all('SELECT id FROM projects').map((r) => r.id)
    : user.projects.map((p) => p.id);
  if (projectId && !allowedProjectIds.includes(Number(projectId))) {
    const err = new Error('You do not have access to this project.');
    err.status = 403;
    throw err;
  }
  if (subprojectId) {
    const sub = q.get('SELECT * FROM subprojects WHERE id = ?', Number(subprojectId));
    if (!sub) throw Object.assign(new Error('Subproject not found.'), { status: 404 });
    if (!allowedProjectIds.includes(sub.project_id)) {
      throw Object.assign(new Error('You do not have access to this subproject.'), { status: 403 });
    }
  }
  if (categoryId) {
    const cat = q.get(
      `SELECT c.*, s.project_id FROM categories c JOIN subprojects s ON s.id = c.subproject_id WHERE c.id = ?`,
      Number(categoryId)
    );
    if (!cat) throw Object.assign(new Error('Category not found.'), { status: 404 });
    if (!allowedProjectIds.includes(cat.project_id)) {
      throw Object.assign(new Error('You do not have access to this category.'), { status: 403 });
    }
  }

  const { sql: baseSql, columns, dynamic } = buildRowQuery({ projectId, subprojectId, categoryId }, user);
  assertGigaPlacement(user, { projectId, subprojectId, categoryId });
  const acl = assignmentScope(user);
  const where = [acl.sql];
  const args = [...acl.args];
  if (projectId) { where.push('a.project_id = ?'); args.push(Number(projectId)); }
  if (subprojectId) { where.push('a.subproject_id = ?'); args.push(Number(subprojectId)); }
  if (categoryId) { where.push('a.category_id = ?'); args.push(Number(categoryId)); }

  if (params.supplierId) { where.push('a.supplier_id = ?'); args.push(Number(params.supplierId)); }
  if (params.status) { where.push('a.status = ?'); args.push(String(params.status)); }

  const search = (params.search || '').trim();
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    const parts = [
      'lower(e.emp_code) LIKE ?',
      'lower(e.name) LIKE ?',
      'ifnull(lower(e.email), \'\') LIKE ?',
      'ifnull(lower(e.phone), \'\') LIKE ?',
      'ifnull(lower(e.first_name || \' \' || e.last_name), \'\') LIKE ?',
      'ifnull(lower(sup.name), \'\') LIKE ?',
      'ifnull(lower(p.name), \'\') LIKE ?',
      'ifnull(lower(s.name), \'\') LIKE ?',
      'ifnull(lower(c.name), \'\') LIKE ?',
      'ifnull(lower(a.remarks), \'\') LIKE ?',
    ];
    for (const d of dynamic) {
      if (['text', 'textarea', 'email', 'tel', 'select'].includes(d.field.type)) {
        parts.push(`ifnull(lower(${d.alias}.value), '') LIKE ?`);
      }
    }
    for (let i = 0; i < parts.length; i++) args.push(like);
    where.push(`(${parts.join(' OR ')})`);
  }

  // Field-level filters: f_<key>=value
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith('f_') || v === '' || v === undefined || v === null) continue;
    const key = k.slice(2);
    const mapped = MAPPED[key];
    if (mapped) {
      const expr = mapped.table === 'e' ? `e.${mapped.column}` : mapped.table === 'sup' ? 'sup.name' : `a.${mapped.column}`;
      where.push(`ifnull(${expr}, '') = ?`);
      args.push(String(v));
      continue;
    }
    const d = dynamic.find((x) => x.field.key === key);
    if (d) { where.push(`${d.alias}.value = ?`); args.push(String(v)); }
  }

  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';

  // Sort whitelist
  const SORTS = {
    emp_code: 'e.emp_code',
    name: 'e.name COLLATE NOCASE',
    supplier: 'sup.name COLLATE NOCASE',
    status: 'a.status',
    project: 'p.name',
    subproject: 's.name',
    category: 'c.name',
    updated_at: 'a.updated_at',
  };
  let sortExpr = SORTS[params.sort] || 'e.name COLLATE NOCASE';
  if (params.sort && params.sort.startsWith('f_')) {
    const d = dynamic.find((x) => x.field.key === params.sort.slice(2));
    if (d) sortExpr = `${d.alias}.value`;
  }
  const dir = String(params.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderSql = `ORDER BY ${sortExpr} ${dir}, e.emp_code ASC`;

  const countSql = `SELECT COUNT(*) AS c FROM (${baseSql} ${whereSql})`;
  const total = Number(q.get(countSql, ...args).c);

  const rows = q.all(`${baseSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);

  const data = rows.map((r) => normalizeRow(r, columns, dynamic));

  return {
    rows: data,
    columns: columns.map(publicColumn),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    scope: schema.scopeLabels({ projectId, subprojectId, categoryId }),
  };
}

function publicColumn(c) {
  return {
    key: c.key,
    label: c.label,
    type: c.type,
    options: c.options,
    editable: c.editable,
    required: c.required,
    core: c.core,
    system: c.system,
    help: c.help,
    section: c.section,
  };
}

function normalizeRow(r, columns, dynamic) {
  const out = {
    assignmentId: r.assignment_id,
    employeeId: r.employee_id,
    projectId: r.project_id,
    subprojectId: r.subproject_id,
    categoryId: r.category_id,
    supplierId: r.supplier_id,
    projectName: r.project_name,
    subprojectName: r.subproject_name,
    categoryName: r.category_name,
    updatedAt: r.assignment_updated_at,
    updatedBy: r.updated_by_name || '—',
    rev: r.assignment_rev ?? null,
    values: {},
  };
  for (const c of columns) {
    const mapped = MAPPED[c.key];
    if (mapped) {
      out.values[c.key] =
        c.key === 'emp_code' ? r.emp_code
        : c.key === 'name' ? r.name
        : c.key === 'email' ? r.email
        : c.key === 'phone' ? r.phone
        : c.key === 'first_name' ? r.first_name
        : c.key === 'last_name' ? r.last_name
        : c.key === 'status' ? r.status
        : c.key === 'supplier' ? r.supplier
        : c.key === 'remarks' ? r.remarks
        : null;
    } else {
      const d = dynamic.find((x) => x.field.key === c.key);
      out.values[c.key] = d ? r[d.alias] : null;
    }
  }
  return out;
}

/**
 * Apply a set of field changes to an assignment.
 *  - validates per field type
 *  - optimistic concurrency via `expectedRev`
 *  - locks overridden fields against future imports
 *  - writes an audit entry per changed field
 */
function updateAssignment(user, assignmentId, changes, { expectedRev = null, source = 'manual', reason = 'CRM edit' } = {}) {
  const assignment = q.get('SELECT * FROM assignments WHERE id = ?', assignmentId);
  if (!assignment) throw Object.assign(new Error('Employee record not found.'), { status: 404 });
  assertAssignment(user, assignmentId, 'can_edit'); // before returning any conflict snapshot
  if (user.gigaAccess) {
    if (Object.hasOwn(changes, 'giga_project_name')) throw denied('A supervisor cannot change the Giga project of a record.');
    // Identity is shared by every placement. An edit here must not change a
    // person in another Giga project through a second, visible placement.
    if (Object.keys(changes).some((k) => MAPPED[k]?.table === 'e')) {
      const acl = assignmentScope(user);
      if (q.get(`SELECT 1 FROM assignments a WHERE a.employee_id = ? AND NOT (${acl.sql}) LIMIT 1`, assignment.employee_id, ...acl.args)) {
        throw denied('This identity is shared with another project. Ask an administrator to update it.');
      }
    }
  }

  const categoryColumns = schema.columnsForCategory(assignment.category_id, user);
  const byKey = new Map(categoryColumns.map((c) => [c.key, c]));
  const employee = q.get('SELECT * FROM employees WHERE id = ?', assignment.employee_id);

  if (expectedRev !== null && expectedRev !== undefined && source === 'manual') {
    const currentRev = assignment.rev;
    // accept both the numeric revision and the legacy timestamp form
    const expected = /^\d+$/.test(String(expectedRev)) ? Number(expectedRev) : null;
    const stale = expected !== null ? currentRev !== expected : assignment.updated_at !== String(expectedRev);
    if (stale) {
      const err = new Error('This record was changed by someone else. Review the latest values and retry.');
      err.status = 409;
      err.code = 'STALE';
      err.current = getAssignment(user, assignmentId);
      throw err;
    }
  }

  return tx(() => {
    const errors = {};
    const applied = [];
    let employeeTouched = false;
    let assignmentTouched = false;

    for (const [key, rawValue] of Object.entries(changes)) {
      const field = byKey.get(key) || schema.listFields(user).find((f) => f.key === key);
      if (!field) { errors[key] = 'Unknown field.'; continue; }
      const configured = byKey.get(key);
      if (!user.isAdmin && configured && !configured.editable) {
        errors[key] = 'This field is read-only for your role.';
        continue;
      }
      const value = normalizeValue(field, rawValue);
      if (value.error) { errors[key] = value.error; continue; }
      if (configured?.required && (value.value === null || value.value === '')) {
        errors[key] = 'This field is required.';
        continue;
      }

      if (MAPPED[key]) {
        const before = key === 'supplier'
          ? (assignment.supplier_id ? q.get('SELECT name FROM suppliers WHERE id = ?', assignment.supplier_id)?.name : null)
          : key === 'status' ? assignment.status : key === 'remarks' ? assignment.remarks : employee[key];
        const after = value.value;
        if (String(before ?? '') === String(after ?? '')) continue;

        if (key === 'supplier') {
          const sid = supplierIdFor(after, user);
          q.run("UPDATE assignments SET supplier_id = ?, updated_at = datetime('now'), updated_by = ?, rev = rev + 1 WHERE id = ?", sid, user.id, assignmentId);
          assignmentTouched = true;
        } else if (key === 'status' || key === 'remarks') {
          q.run(
            `UPDATE assignments SET ${key} = ?, updated_at = datetime('now'), updated_by = ?, rev = rev + 1 WHERE id = ?`,
            after === null ? null : String(after),
            user.id,
            assignmentId
          );
          assignmentTouched = true;
        } else if (key === 'emp_code') {
          errors[key] = 'Employee ID is the identity key and cannot be changed here.';
          continue;
        } else {
          q.run(
            `UPDATE employees SET ${key} = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`,
            after === null ? null : String(after),
            user.id,
            employee.id
          );
          employeeTouched = true;
        }
        record({
          entity: 'assignment',
          entityId: assignmentId,
          ref: employee.emp_code,
          action: 'update',
          fieldKey: key,
          oldValue: before,
          newValue: after,
          actor: user,
          meta: { reason },
        });
      } else {
        const beforeRow = q.get(
          'SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?',
          assignmentId,
          field.id
        );
        const before = beforeRow ? beforeRow.value : null;
        if (String(before ?? '') === String(value.value ?? '')) continue;
        q.run(
          `INSERT INTO assignment_values (assignment_id, field_id, value, source, updated_at, updated_by)
           VALUES (?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(assignment_id, field_id) DO UPDATE SET
             value = excluded.value, source = excluded.source, updated_at = datetime('now'), updated_by = excluded.updated_by`,
          assignmentId,
          field.id,
          value.value === null ? null : String(value.value),
          source,
          user.id
        );
        record({
          entity: 'assignment',
          entityId: assignmentId,
          ref: employee.emp_code,
          action: 'update',
          fieldKey: key,
          oldValue: before,
          newValue: value.value,
          actor: user,
          meta: { reason },
        });
        applied.push(key);
      }

      // Manual edits are protected from being overwritten by scheduled imports.
      if (source === 'manual') {
        q.run(
          `INSERT INTO field_overrides (assignment_id, field_id, locked, reason, updated_at)
           VALUES (?, ?, 1, ?, datetime('now'))
           ON CONFLICT(assignment_id, field_id) DO UPDATE SET locked = 1, reason = excluded.reason, updated_at = datetime('now')`,
          assignmentId,
          field.id,
          reason
        );
      }
    }

    if (!assignmentTouched && !employeeTouched && !applied.length) {
      // still bump nothing; return snapshot so the client can show Saved
    } else {
      if (!assignmentTouched) {
        q.run("UPDATE assignments SET updated_at = datetime('now'), updated_by = ?, rev = rev + 1 WHERE id = ?", user.id, assignmentId);
      }
      if (!employeeTouched && !user.gigaAccess) {
        q.run(`UPDATE employees SET updated_at = datetime('now') WHERE id = ?`, employee.id);
      }
    }

    if (Object.keys(errors).length) {
      const err = new Error('Some values could not be saved.');
      err.status = 422;
      err.errors = errors;
      err.current = getAssignment(user, assignmentId);
      throw err;
    }

    return getAssignment(user, assignmentId);
  });
}

function assertProjectAccess(user, projectId, flag = null) {
  if (user.isAdmin) return;
  const grant = user.projects.find((p) => p.id === Number(projectId));
  if (!grant) throw Object.assign(new Error('You do not have access to this project.'), { status: 403 });
  if (flag && !grant[flag]) {
    throw Object.assign(new Error('Your access to this project is read-only.'), { status: 403 });
  }
}

/** Type-aware validation shared by CRM, table edits and imports. */
function normalizeValue(field, raw) {
  if (raw === undefined) return { value: undefined };
  let v = raw;
  if (v !== null && typeof v === 'string') v = v.trim();
  if (v === '' ) v = null;
  if (v === null) {
    if (field.type === 'number') return { value: null };
    return { value: null };
  }
  switch (field.type) {
    case 'number': {
      const n = Number(String(v).replace(/,/g, ''));
      if (Number.isNaN(n)) return { error: 'Enter a valid number.' };
      return { value: n };
    }
    case 'date': {
      const d = parseDate(v);
      if (!d) return { error: 'Enter a valid date (YYYY-MM-DD).' };
      return { value: d };
    }
    case 'email': {
      const s = String(v);
      if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return { error: 'Enter a valid email address.' };
      return { value: s };
    }
    case 'tel': {
      const s = String(v).trim();
      if (s && !/^[+()\-\s0-9]{6,24}$/.test(s)) return { error: 'Enter a valid contact number.' };
      return { value: s };
    }
    case 'select': {
      const opts = field.options || [];
      if (opts.length && v !== null && !opts.includes(String(v))) {
        return { error: `Choose one of: ${opts.slice(0, 4).join(', ')}${opts.length > 4 ? '…' : ''}` };
      }
      return { value: String(v) };
    }
    case 'textarea':
      return { value: String(v) };
    default:
      return { value: String(v) };
  }
}

function parseDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  // Excel serial dates arrive as numbers
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    const ms = Math.round((serial - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    return `${parsed.getFullYear()}-${mm}-${dd}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identity & duplicate prevention
// ---------------------------------------------------------------------------

/** Find possible duplicates for incoming identity data. */
function findCandidates({ emp_code, name, email, phone }) {
  const out = [];
  if (emp_code) {
    const exact = q.get('SELECT * FROM employees WHERE lower(emp_code) = lower(?)', String(emp_code).trim());
    if (exact) out.push({ match: 'employee-id', confidence: 1, employee: exact });
  }
  if (email) {
    for (const e of q.all('SELECT * FROM employees WHERE lower(ifnull(email, \'\')) = lower(?)', String(email).trim())) {
      if (!out.some((o) => o.employee.id === e.id)) out.push({ match: 'email', confidence: 0.9, employee: e });
    }
  }
  if (phone) {
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    if (digits.length >= 7) {
      for (const e of q.all('SELECT * FROM employees WHERE phone IS NOT NULL')) {
        if (String(e.phone).replace(/\D/g, '').slice(-10) === digits && !out.some((o) => o.employee.id === e.id)) {
          out.push({ match: 'phone', confidence: 0.85, employee: e });
        }
      }
    }
  }
  if (name) {
    for (const e of q.all('SELECT * FROM employees WHERE lower(name) = lower(?)', String(name).trim())) {
      if (!out.some((o) => o.employee.id === e.id)) {
        // Name alone is never treated as a unique identifier — flagged for review only.
        out.push({ match: 'name-only', confidence: 0.4, employee: e });
      }
    }
  }
  return out;
}

/**
 * Create (or reuse) an employee + assignment.
 * Uncertain matches are queued in duplicate_reviews instead of silently creating.
 */
function createPerson(user, payload) {
  const { emp_code, project_id, subproject_id, category_id } = payload;
  // accept either a single display name or the workbook's first/last pair
  const first = payload.first_name ? String(payload.first_name).trim() : '';
  const last = payload.last_name ? String(payload.last_name).trim() : '';
  const name = String(payload.name || `${first} ${last}`.trim()).trim();
  if (!emp_code || !String(emp_code).trim()) throw Object.assign(new Error('Employee ID is required.'), { status: 422 });
  if (!name) throw Object.assign(new Error('First Name and Last Name are required.'), { status: 422 });
  if (user.gigaAccess) {
    assertGigaPlacement(user, { projectId: project_id, subprojectId: subproject_id, categoryId: category_id });
    if (!user.gigaAccess.name || (payload.giga_project_name !== undefined && payload.giga_project_name !== user.gigaAccess.name)) {
      throw denied();
    }
  } else assertProjectAccess(user, project_id, 'can_edit');
  const sub = q.get('SELECT * FROM subprojects WHERE id = ?', Number(subproject_id));
  if (!sub || sub.project_id !== Number(project_id)) throw Object.assign(new Error('Subproject does not belong to the selected project.'), { status: 422 });
  const cat = q.get('SELECT * FROM categories WHERE id = ?', Number(category_id));
  if (!cat || cat.subproject_id !== Number(subproject_id)) throw Object.assign(new Error('Category does not belong to the selected subproject.'), { status: 422 });

  const candidates = findCandidates(payload);
  const hardConflict = candidates.find((c) => c.confidence >= 0.85 && c.employee.emp_code.toLowerCase() !== String(emp_code).trim().toLowerCase());
  const sameId = candidates.find((c) => c.match === 'employee-id');
  if (user.gigaAccess) {
    // Do not claim or reveal a matching identity from another project.
    for (const match of [sameId, hardConflict].filter(Boolean)) {
      if (!q.get('SELECT 1 FROM giga_assignments WHERE employee_id = ? AND project_name = ? LIMIT 1', match.employee.id, user.gigaAccess.name)) {
        throw denied('An administrator must review this employee before it can be linked.');
      }
    }
  }

  return tx(() => {
    let employee = sameId ? sameId.employee : null;
    let created = false;
    if (!employee) {
      const res = q.run(
        `INSERT INTO employees (emp_code, name, first_name, last_name, email, phone, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        String(emp_code).trim(),
        name,
        first || name.split(' ')[0],
        last || name.split(' ').slice(1).join(' ') || null,
        payload.email || null,
        payload.phone || null,
        user.id,
        user.id
      );
      employee = q.get('SELECT * FROM employees WHERE id = ?', Number(res.lastInsertRowid));
      created = true;
      record({
        entity: 'employee', entityId: employee.id, ref: employee.emp_code, action: 'create',
        newValue: employee.name, actor: user, meta: { via: 'crm' },
      });
    }

    const existingAssignment = q.get(
      'SELECT * FROM assignments WHERE employee_id = ? AND subproject_id = ? AND category_id = ?',
      employee.id,
      Number(subproject_id),
      Number(category_id)
    );

    let assignmentId;
    if (existingAssignment) {
      assignmentId = existingAssignment.id;
      if (user.gigaAccess) assertAssignment(user, assignmentId);
    } else {
      const res = q.run(
        `INSERT INTO assignments (employee_id, project_id, subproject_id, category_id, status, updated_by)
         VALUES (?, ?, ?, ?, 'Active', ?)`,
        employee.id,
        Number(project_id),
        Number(subproject_id),
        Number(category_id),
        user.id
      );
      assignmentId = Number(res.lastInsertRowid);
      if (user.gigaAccess) {
        q.run(`INSERT INTO assignment_values (assignment_id, field_id, value, updated_by)
               VALUES (?, (SELECT id FROM fields WHERE key = 'giga_project_name'), ?, ?)`, assignmentId, user.gigaAccess.name, user.id);
      }
      record({
        entity: 'assignment', entityId: assignmentId, ref: employee.emp_code, action: 'create',
        newValue: `${cat.name}`, actor: user, meta: { via: 'crm' },
      });
    }

    if (hardConflict) {
      const review = q.run(
        `INSERT INTO duplicate_reviews (emp_code, name, email, phone, candidate_employee_id, payload, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        String(emp_code).trim(), String(name).trim(), payload.email || null, payload.phone || null,
        hardConflict.employee.id, JSON.stringify(payload)
      );
      return {
        employeeId: employee.id,
        assignmentId,
        created,
        needsReview: true,
        reviewId: Number(review.lastInsertRowid),
        candidate: {
          employeeId: hardConflict.employee.id,
          emp_code: hardConflict.employee.emp_code,
          name: hardConflict.employee.name,
          reason: hardConflict.match,
        },
        record: getAssignment(user, assignmentId),
      };
    }

    // Friendly duplicates (same employee id, new project placement) are linked, not copied.
    return { employeeId: employee.id, assignmentId, created, needsReview: false, record: getAssignment(user, assignmentId) };
  });
}

module.exports = {
  listEmployees,
  getAssignment,
  updateAssignment,
  createPerson,
  findCandidates,
  normalizeValue,
  parseDate,
  supplierIdFor,
  assertProjectAccess,
  buildRowQuery,
  MAPPED,
  valueColumn,
};
