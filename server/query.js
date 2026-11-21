'use strict';
/**
 * Employee record queries.
 *
 * Performance contract: the supervisor table must stay responsive with ~12,000
 * rows and 70-80 configured columns.
 *
 * Joining one `assignment_values` table per column would need one JOIN per
 * column, and SQLite refuses any query with more than 64 tables in a join. So
 * every read is two-phase:
 *
 *   1. candidate page   — resolve the matching assignment ids (filters pushed
 *                         down as indexed EXISTS sub-queries) + a COUNT
 *   2. value hydration  — one bulk SELECT for just those ids
 *
 * Measured on 12k rows x 75 columns: ~2 ms for an unfiltered page and ~7 ms
 * with two column filters, versus a hard failure using the join-per-column plan.
 */
const { q } = require('./db');
const schema = require('./schema');

/**
 * Fields stored directly on the employees table.
 * Everything else lives in assignment_values.
 */
const MAPPED = {
  emp_code: { source: 'e', column: 'emp_code', sql: 'e.emp_code' },
  name: { source: 'e', column: 'name', sql: 'e.name' },
  first_name: { source: 'e', column: 'first_name', sql: 'e.first_name' },
  last_name: { source: 'e', column: 'last_name', sql: 'e.last_name' },
  email: { source: 'e', column: 'email', sql: 'e.email' },
  phone: { source: 'e', column: 'phone', sql: 'e.phone' },
  status: { source: 'a', column: 'status', sql: 'a.status', alias: 'employee_status', valuesKey: 'employment_status' },
  supplier: { source: 'sup', column: 'name', sql: 'sup.name' },
  remarks: { source: 'a', column: 'remarks', sql: 'a.remarks' },
};

/** Columns shown when no category is selected. Keep this short and useful. */
const DEFAULT_KEYS = ['emp_code', 'first_name', 'last_name', 'status', 'bench_category',
  'allocation_percentage', 'account', 'account_name'];

const BASE_SELECT = `
  SELECT a.id AS assignment_id, a.project_id, a.subproject_id, a.category_id, a.supplier_id,
         a.status AS employee_status, a.remarks, a.updated_at AS assignment_updated_at, a.rev AS assignment_rev,
         e.id AS employee_id, e.emp_code, e.name, e.first_name, e.last_name, e.email, e.phone,
         e.updated_at AS employee_updated_at,
         p.name AS project_name, p.code AS project_code,
         s.name AS subproject_name, c.name AS category_name,
         sup.name AS supplier, u.name AS updated_by_name
    FROM assignments a
    JOIN employees e ON e.id = a.employee_id
    JOIN projects p ON p.id = a.project_id
    JOIN subprojects s ON s.id = a.subproject_id
    JOIN categories c ON c.id = a.category_id
    LEFT JOIN suppliers sup ON sup.id = a.supplier_id
    LEFT JOIN users u ON u.id = a.updated_by`;

function assertProjectAccess(user, projectId, flag = null) {
  if (user.isAdmin) return;
  const grant = user.projects.find((p) => p.id === Number(projectId));
  if (!grant) {
    throw Object.assign(new Error('You do not have access to this project.'), { status: 403 });
  }
  if (flag && !grant[flag]) {
    throw Object.assign(new Error('Your access to this project is read-only.'), { status: 403 });
  }
}

function visibleProjectIds(user) {
  return user.isAdmin
    ? q.all('SELECT id FROM projects').map((r) => r.id)
    : user.projects.map((p) => p.id);
}

/** Resolve the scope, enforcing project access on each level. */
function resolveScope(user, params) {
  const scoped = { projectId: null, subprojectId: null, categoryId: null };
  const allowed = visibleProjectIds(user);

  if (params.projectId) {
    const id = Number(params.projectId);
    if (!allowed.includes(id)) {
      throw Object.assign(new Error('You do not have access to this project.'), { status: 403 });
    }
    scoped.projectId = id;
  }
  if (params.subprojectId) {
    const sub = q.get('SELECT * FROM subprojects WHERE id = ?', Number(params.subprojectId));
    if (!sub) throw Object.assign(new Error('Subproject not found.'), { status: 404 });
    if (!allowed.includes(sub.project_id)) {
      throw Object.assign(new Error('You do not have access to this subproject.'), { status: 403 });
    }
    scoped.subprojectId = sub.id;
    scoped.projectId = scoped.projectId || sub.project_id;
  }
  if (params.categoryId) {
    const cat = q.get(
      'SELECT c.*, s.project_id FROM categories c JOIN subprojects s ON s.id = c.subproject_id WHERE c.id = ?',
      Number(params.categoryId)
    );
    if (!cat) throw Object.assign(new Error('Category not found.'), { status: 404 });
    if (!allowed.includes(cat.project_id)) {
      throw Object.assign(new Error('You do not have access to this category.'), { status: 403 });
    }
    scoped.categoryId = cat.id;
    scoped.subprojectId = scoped.subprojectId || cat.subproject_id;
    scoped.projectId = scoped.projectId || cat.project_id;
  }
  return { scope: scoped, allowed };
}

/**
 * The columns a supervisor sees for this selection.
 *
 * With no category chosen we still need the facet columns (bench category,
 * allocation %, location…) even though they are not all displayed in the table,
 * so this merges the compact display set with the project's filterable set.
 */
function columnsFor(scope) {
  if (scope.categoryId) return schema.columnsForCategory(scope.categoryId);

  const fields = schema.listFields();
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const seen = new Set();
  const out = [];
  const push = (f, extra = {}) => {
    if (!f || seen.has(f.id)) return;
    seen.add(f.id);
    out.push({ ...f, visible: true, editable: true, required: false, ...extra });
  };

  // Bench category is the primary facet in the brief, so it is displayed *and*
  // filterable from the start. push() keeps the first-seen object, so the flag
  // has to be set as the column is added.
  for (const k of DEFAULT_KEYS) {
    push(byKey.get(k), k === 'bench_category' ? { filterable: true } : {});
  }
  const skill = byKey.get('primary_skill');
  if (skill) push({ ...skill, filterable: true });

  // union of the filterable flags across the categories in scope
  let cats;
  if (scope.subprojectId) cats = q.all('SELECT id FROM categories WHERE subproject_id = ?', scope.subprojectId);
  else if (scope.projectId) {
    cats = q.all('SELECT c.id FROM categories c JOIN subprojects s ON s.id = c.subproject_id WHERE s.project_id = ?', scope.projectId);
  } else cats = q.all('SELECT id FROM categories LIMIT 1');

  const facetIds = new Set();
  for (const c of cats) {
    for (const r of q.all('SELECT field_id FROM category_fields WHERE category_id = ? AND filterable = 1', c.id)) {
      facetIds.add(r.field_id);
    }
  }
  for (const f of fields) {
    if (facetIds.has(f.id)) push(f, { filterable: true });
  }
  return out;
}

function publicColumn(c) {
  return {
    key: c.key,
    label: c.label,
    type: c.type,
    options: c.options,
    editable: c.editable,
    required: c.required,
    filterable: !!c.filterable,
    submitField: !!c.submitField,
    group: c.group_name || null,
    core: c.core,
    system: c.system,
    help: c.help,
    section: c.section,
    imported: !!c.imported,
  };
}

/** Split incoming params into mapped-column filters and value-table filters. */
function collectFilters(params, columns) {
  const known = new Map(columns.map((c) => [c.key, c]));
  const mapped = [];
  const valued = [];
  for (const [key, raw] of Object.entries(params)) {
    if (!key.startsWith('f_')) continue;
    const fieldKey = key.slice(2);
    const values = String(raw).split('|').filter((v) => v !== '');
    if (!values.length) continue;
    if (MAPPED[fieldKey]) {
      mapped.push({ key: fieldKey, values });
      continue;
    }
    const col = known.get(fieldKey) || schema.listFields().find((f) => f.key === fieldKey);
    if (!col) continue;
    valued.push({ field: col, values });
  }
  return { mapped, valued };
}

/**
 * Build the WHERE clause + args for the id/count phase.
 * Filters on configuration columns are pushed down as EXISTS so SQLite can use
 * idx_av_field_value instead of materialising every value.
 */
function buildWhere({ scope, allowed, filters, search, columns, params = {} }) {
  const where = ['a.active = 1', 'e.active = 1'];
  const args = [];

  if (scope.subprojectId) { where.push('a.subproject_id = ?'); args.push(scope.subprojectId); }
  else if (scope.projectId) { where.push('a.project_id = ?'); args.push(scope.projectId); }
  else {
    where.push(`a.project_id IN (${allowed.map(() => '?').join(',') || 'NULL'})`);
    args.push(...allowed);
  }
  if (scope.categoryId) { where.push('a.category_id = ?'); args.push(scope.categoryId); }
  // legacy ?status= (assignment status) — distinct from the mapped `status` column
  if (params.status) { where.push('a.status = ?'); args.push(String(params.status)); }

  for (const f of filters.mapped) {
    const m = MAPPED[f.key];
    const ph = f.values.map(() => '?').join(',');
    where.push(`ifnull(${m.sql}, '') IN (${ph})`);
    args.push(...f.values);
  }
  for (const f of filters.valued) {
    const ph = f.values.map(() => '?').join(',');
    where.push(`EXISTS (SELECT 1 FROM assignment_values avf
                          WHERE avf.assignment_id = a.id AND avf.field_id = ? AND avf.value IN (${ph}))`);
    args.push(f.field.id, ...f.values);
  }

  const term = (search || '').trim();
  if (term) {
    const like = `%${term.toLowerCase()}%`;
    const mappedSearch = ['e.emp_code', 'e.name', 'ifnull(e.email, \'\')', 'ifnull(e.phone, \'\')',
      'ifnull(sup.name, \'\')', 'ifnull(a.remarks, \'\')'];
    // only search text-ish value columns that are actually in view
    const textFields = columns
      .filter((c) => !MAPPED[c.key] && ['text', 'email', 'tel', 'select'].includes(c.type))
      .slice(0, 12);
    const clauses = mappedSearch.map((expr) => `lower(${expr}) LIKE ?`);
    const searchArgs = mappedSearch.map(() => like);
    if (textFields.length) {
      clauses.push(`EXISTS (SELECT 1 FROM assignment_values avs WHERE avs.assignment_id = a.id
                            AND avs.field_id IN (${textFields.map(() => '?').join(',')})
                            AND lower(avs.value) LIKE ?)`);
      searchArgs.push(...textFields.map((f) => f.id), like);
    }
    where.push(`(${clauses.join(' OR ')})`);
    args.push(...searchArgs);
  }
  return { where: where.join(' AND '), args };
}

const SORTS = {
  emp_code: 'e.emp_code',
  name: 'e.name COLLATE NOCASE',
  first_name: 'e.first_name COLLATE NOCASE',
  last_name: 'e.last_name COLLATE NOCASE',
  supplier: 'sup.name COLLATE NOCASE',
  status: 'a.status',
  project: 'p.name',
  subproject: 's.name',
  category: 'c.name',
  updated_at: 'a.updated_at',
};

/**
 * The supervisor table.
 * Returns rows + the column configuration + the filter facets for this scope.
 */
function listEmployees(user, params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(params.pageSize) || 25));

  const { scope, allowed } = resolveScope(user, params);
  const columns = columnsFor(scope);
  const filters = collectFilters(params, columns);
  const { where, args } = buildWhere({ scope, allowed, filters, search: params.search, columns, params });

  const sortExpr = SORTS[params.sort] || 'e.name COLLATE NOCASE';
  const dir = String(params.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  // ---- phase 1: count + page of ids ----
  const total = Number(q.get(
    `SELECT COUNT(*) c FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN suppliers sup ON sup.id = a.supplier_id
      WHERE ${where}`,
    ...args
  ).c);

  const ids = q.all(
    `SELECT a.id FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN subprojects s ON s.id = a.subproject_id
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN suppliers sup ON sup.id = a.supplier_id
      WHERE ${where}
      ORDER BY ${sortExpr} ${dir}, e.emp_code ASC
      LIMIT ? OFFSET ?`,
    ...args, pageSize, (page - 1) * pageSize
  ).map((r) => r.id);

  // ---- phase 2: hydrate ----
  const rows = hydrate(ids, columns, scope);

  return {
    rows,
    columns: columns.map(publicColumn),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    scope: schema.scopeLabels(scope),
    facets: facetsFor(scope, columns),
    canEdit: user.isAdmin || !!user.projects.find((p) => p.id === scope.projectId)?.can_edit,
  };
}

/** Load full rows for a page of assignment ids, in one query. */
function hydrate(ids, columns, scope) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const base = q.all(`${BASE_SELECT} WHERE a.id IN (${ph})`, ...ids);
  const byId = new Map(base.map((r) => [r.id ?? r.assignment_id, r]));

  const valueFields = columns.filter((c) => !MAPPED[c.key]);
  const values = new Map();
  if (valueFields.length) {
    const vph = valueFields.map(() => '?').join(',');
    for (const v of q.all(
      `SELECT assignment_id, field_id, value FROM assignment_values
        WHERE assignment_id IN (${ph}) AND field_id IN (${vph})`,
      ...ids, ...valueFields.map((f) => f.id)
    )) {
      if (!values.has(v.assignment_id)) values.set(v.assignment_id, {});
      values.get(v.assignment_id)[v.field_id] = v.value;
    }
  }

  const declared = new Set(valueFields.map((f) => f.id));
  const locked = new Map();
  for (const l of q.all(
    `SELECT assignment_id, field_id FROM field_overrides WHERE assignment_id IN (${ph}) AND locked = 1`,
    ...ids
  )) {
    if (!locked.has(l.assignment_id)) locked.set(l.assignment_id, new Set());
    locked.get(l.assignment_id).add(l.field_id);
  }

  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return null;
    const vals = values.get(id) || {};
    const out = {};
    for (const c of columns) {
      const m = MAPPED[c.key];
      if (m) {
        out[c.key] = c.key === 'emp_code' ? r.emp_code
          : c.key === 'name' ? r.name
          : c.key === 'first_name' ? r.first_name
          : c.key === 'last_name' ? r.last_name
          : c.key === 'email' ? r.email
          : c.key === 'phone' ? r.phone

          : c.key === 'status' ? r.employee_status
          : c.key === 'supplier' ? r.supplier
          : c.key === 'remarks' ? r.remarks
          : null;
      } else {
        out[c.key] = declared.has(c.id) ? (vals[c.id] ?? null) : undefined;
      }
    }
    return {
      assignmentId: r.assignment_id,
      employeeId: r.employee_id,
      projectId: r.project_id,
      subprojectId: r.subproject_id,
      categoryId: r.category_id,
      supplierId: r.supplier_id,
      projectName: r.project_name,
      projectCode: r.project_code,
      subprojectName: r.subproject_name,
      categoryName: r.category_name,
      updatedAt: r.assignment_updated_at,
      updatedBy: r.updated_by_name || '—',
      rev: r.assignment_rev,
      lockedFields: [...(locked.get(id) || [])].map((fid) => columns.find((c) => c.id === fid)?.key).filter(Boolean),
      values: out,
    };
  }).filter(Boolean);
}

/**
 * Filter facets: for each filterable column in this scope, the distinct values
 * with counts. This is what drives the "space filter" chips.
 */
function facetsFor(scope, columns) {
  if (!scope.projectId) return [];
  const projectFilter = scope.subprojectId ? 'a.subproject_id = ?' : 'a.project_id = ?';
  const scopeArg = scope.subprojectId || scope.projectId;
  const catFilter = scope.categoryId ? ' AND a.category_id = ?' : '';
  const catArg = scope.categoryId ? [scope.categoryId] : [];

  const filterable = columns.filter((c) => c.filterable);
  const mapped = filterable.filter((c) => MAPPED[c.key]);
  const valued = filterable.filter((c) => !MAPPED[c.key]);

  // One round trip per storage location instead of one per column: 12 facet
  // queries became 2, which is the difference between ~250 ms and ~25 ms.
  const grouped = new Map();   // key -> [{value, count}]

  if (mapped.length) {
    const selects = mapped.map((c) => `'${c.key.replace(/'/g, "''")}', ifnull(${MAPPED[c.key].sql}, '')`).join(', ');
    for (const r of q.all(
      `SELECT ${selects}, COUNT(*) c FROM assignments a
         JOIN employees e ON e.id = a.employee_id
         LEFT JOIN suppliers sup ON sup.id = a.supplier_id
        WHERE a.active = 1 AND ${projectFilter}${catFilter}
        GROUP BY ${mapped.map((c) => `ifnull(${MAPPED[c.key].sql}, '')`).join(', ')}`,
      scopeArg, ...catArg
    )) {
      mapped.forEach((c) => {
        const value = r[`'${c.key}'`] ?? r[c.key];
        if (value === '' || value === null || value === undefined) return;
        if (!grouped.has(c.key)) grouped.set(c.key, new Map());
        const bucket = grouped.get(c.key);
        bucket.set(value, (bucket.get(value) || 0) + r.c);
      });
    }
  }

  if (valued.length) {
    const ph = valued.map(() => '?').join(',');
    for (const r of q.all(
      `SELECT av.field_id, av.value v, COUNT(*) c FROM assignment_values av
         JOIN assignments a ON a.id = av.assignment_id
        WHERE a.active = 1 AND av.field_id IN (${ph}) AND ${projectFilter}${catFilter}
          AND av.value IS NOT NULL AND av.value <> ''
        GROUP BY av.field_id, av.value
        ORDER BY c DESC`,
      ...valued.map((f) => f.id), scopeArg, ...catArg
    )) {
      if (!grouped.has(r.field_id)) grouped.set(r.field_id, new Map());
      grouped.get(r.field_id).set(r.v, r.c);
    }
  }

  const out = [];
  for (const col of filterable) {
    const bucket = grouped.get(col.key) || grouped.get(col.id);
    if (!bucket || !bucket.size) continue;
    const values = [...bucket.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
      .slice(0, 40);
    out.push({
      key: col.key,
      label: col.label,
      type: col.type,
      total: [...bucket.values()].reduce((a, n) => a + n, 0),
      values,
    });
  }
  return out;
}

/** One record with every field (used by the CRM panel and the submit form). */
function getAssignment(id) {
  const meta = q.get(
    `SELECT a.*, e.emp_code, e.name, e.first_name, e.last_name, e.email, e.phone, e.id AS employee_id
       FROM assignments a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`,
    Number(id)
  );
  if (!meta) return null;

  const fields = schema.listFields();
  const stored = new Map(
    q.all('SELECT field_id, value FROM assignment_values WHERE assignment_id = ?', meta.id).map((r) => [r.field_id, r.value])
  );
  const values = {};
  for (const f of fields) {
    const m = MAPPED[f.key];
    if (m) {
      values[f.key] = f.key === 'emp_code' ? meta.emp_code
        : f.key === 'name' ? meta.name
        : f.key === 'first_name' ? meta.first_name
        : f.key === 'last_name' ? meta.last_name
        : f.key === 'email' ? meta.email
        : f.key === 'phone' ? meta.phone

        : f.key === 'status' ? meta.status
        : f.key === 'remarks' ? meta.remarks
        : f.key === 'supplier' ? (meta.supplier_id ? q.get('SELECT name FROM suppliers WHERE id = ?', meta.supplier_id)?.name : null)
        : null;
    } else {
      values[f.key] = stored.has(f.id) ? stored.get(f.id) : null;
    }
  }
  const project = q.get('SELECT * FROM projects WHERE id = ?', meta.project_id);
  const sub = q.get('SELECT * FROM subprojects WHERE id = ?', meta.subproject_id);
  const cat = q.get('SELECT * FROM categories WHERE id = ?', meta.category_id);
  const locked = new Set(q.all(
    'SELECT field_id FROM field_overrides WHERE assignment_id = ? AND locked = 1', meta.id
  ).map((r) => r.field_id));

  return {
    assignmentId: meta.id,
    employeeId: meta.employee_id,
    projectId: meta.project_id,
    subprojectId: meta.subproject_id,
    categoryId: meta.category_id,
    supplierId: meta.supplier_id,
    projectName: project?.name,
    subprojectName: sub?.name,
    categoryName: cat?.name,
    updatedAt: meta.updated_at,
    rev: meta.rev,
    values,
    lockedFields: fields.filter((f) => locked.has(f.id)).map((f) => f.key),
    columns: schema.columnsForCategory(meta.category_id).map((c) => ({
      ...publicColumn(c), locked: locked.has(c.id),
    })),
    allFields: fields,
  };
}

module.exports = {
  MAPPED,
  DEFAULT_KEYS,
  listEmployees,
  getAssignment,
  hydrate,
  assertProjectAccess,
  visibleProjectIds,
  resolveScope,
  columnsFor,
  facetsFor,
  collectFilters,
  buildWhere,
  SORTS,
};
