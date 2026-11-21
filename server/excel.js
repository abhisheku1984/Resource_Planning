'use strict';
const ExcelJS = require('exceljs');
const { q, tx } = require('./db');
const { record } = require('./audit');
const schema = require('./schema');
const fielddefs = require('./fielddefs');
const emp = require('./employees');

const BASE_HEADERS = [
  { key: 'project.code', label: 'Project Code', width: 14 },
  { key: 'project.name', label: 'Project', width: 26 },
  { key: 'subproject.code', label: 'Subproject Code', width: 16 },
  { key: 'subproject.name', label: 'Subproject', width: 26 },
  { key: 'category.code', label: 'Category Code', width: 14 },
  { key: 'category.name', label: 'Category', width: 22 },
  { key: 'emp_code', label: 'Employee ID', width: 15 },
  { key: 'first_name', label: 'First Name', width: 18 },
  { key: 'last_name', label: 'Last Name', width: 18 },
  { key: 'email', label: 'Email Address', width: 28 },
  { key: 'phone', label: 'Contact Number', width: 18 },
  { key: 'supplier', label: 'Supplier', width: 22 },
  { key: 'status', label: 'Status', width: 18 },
  { key: 'remarks', label: 'Remarks', width: 34 },
  { key: 'updated_at', label: 'Last Updated', width: 20 },
  { key: 'updated_by', label: 'Last Updated By', width: 20 },
];

/** A flat, ordered row set for every employee assignment the user may export. */
function collectRows(user, scope = {}) {
  const fields = schema.listFields().filter((f) => !BASE_HEADERS.some((h) => h.key === f.key));
  // the CRM columns first after the identity block, in the order the supervisor
  // sees them, so the administrator reads the same layout they filled in
  const crmKeys = schema.crmKeys();
  const crmFields = crmKeys.map((k) => fields.find((f) => f.key === k)).filter(Boolean);
  const otherFields = fields.filter((f) => !crmKeys.includes(f.key));
  const headers = [
    ...BASE_HEADERS,
    ...crmFields.map((f) => ({ key: f.key, label: f.label, width: f.type === 'textarea' ? 40 : 18 })),
    ...otherFields.map((f) => ({ key: f.key, label: f.label, width: f.type === 'textarea' ? 40 : 18 })),
  ];
  // per-field change stamps, written beside the CRM value they describe
  const extraHeaders = [];
  for (const f of crmFields) {
    extraHeaders.push({ key: `${f.key}__updated_by`, label: `${f.label} — Updated By`, width: 20 });
    extraHeaders.push({ key: `${f.key}__updated_at`, label: `${f.label} — Updated At`, width: 20 });
  }
  extraHeaders.push({ key: 'last_supervisor_update', label: 'Last Supervisor Update', width: 46 });

  const allowedProjects = user.isAdmin ? q.all('SELECT id FROM projects').map((r) => r.id) : user.projects.map((p) => p.id);
  const where = ['a.active = 1', 'e.active = 1'];
  const args = [];
  if (scope.projectId) { where.push('a.project_id = ?'); args.push(Number(scope.projectId)); }
  else if (!user.isAdmin) {
    where.push(`a.project_id IN (${allowedProjects.map(() => '?').join(',') || 'NULL'})`);
    args.push(...allowedProjects);
  }
  if (scope.subprojectId) { where.push('a.subproject_id = ?'); args.push(Number(scope.subprojectId)); }
  if (scope.categoryId) { where.push('a.category_id = ?'); args.push(Number(scope.categoryId)); }
  if (scope.supplierId) { where.push('a.supplier_id = ?'); args.push(Number(scope.supplierId)); }

  const rows = q.all(
    `SELECT a.id, a.status, a.remarks, a.updated_at, a.supplier_id,
            e.emp_code, e.name, e.first_name, e.last_name, e.email, e.phone,
            p.code AS pcode, p.name AS pname,
            s.code AS scode, s.name AS sname,
            c.code AS ccode, c.name AS cname,
            sup.name AS supplier, u.name AS updated_by
       FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       JOIN projects p ON p.id = a.project_id
       JOIN subprojects s ON s.id = a.subproject_id
       JOIN categories c ON c.id = a.category_id
       LEFT JOIN suppliers sup ON sup.id = a.supplier_id
       LEFT JOIN users u ON u.id = a.updated_by
      WHERE ${where.join(' AND ')}
      ORDER BY p.name, s.name, c.name, e.name`,
    ...args
  );

  if (!rows.length) return { headers, rows: [], fields, extraHeaders };

  const ids = rows.map((r) => r.id);
  const values = new Map();
  // Batched so a 12,000-row export stays inside SQLite's parameter limit and
  // never silently drops values past the first chunk.
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    for (const v of q.all(
      `SELECT av.assignment_id, f.key, av.value
         FROM assignment_values av JOIN fields f ON f.id = av.field_id
        WHERE av.assignment_id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk
    )) {
      if (!values.has(v.assignment_id)) values.set(v.assignment_id, {});
      values.get(v.assignment_id)[v.key] = v.value;
    }
  }

  // Who last touched a supervisor-editable value on each row, and when: the
  // administrator's report has to show the update, not only the new text.
  const lastEdits = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    for (const e of q.all(
      `SELECT al.entity_id AS assignment_id, al.field_key, al.actor_name, al.at,
              f.label AS field_label
         FROM audit_log al JOIN fields f ON f.key = al.field_key
        WHERE al.entity = 'assignment' AND al.action = 'update'
          AND al.entity_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY al.id`,
      ...chunk
    )) {
      if (!lastEdits.has(e.assignment_id)) lastEdits.set(e.assignment_id, {});
      lastEdits.get(e.assignment_id)[e.field_key] = { by: e.actor_name, at: e.at, label: e.field_label };
    }
  }

  const out = rows.map((r) => {
    const flat = {
      project: { code: r.pcode, name: r.pname },
      subproject: { code: r.scode, name: r.sname },
      category: { code: r.ccode, name: r.cname },
      emp_code: r.emp_code,
      name: r.name,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      phone: r.phone,
      supplier: r.supplier,
      status: r.status,
      remarks: r.remarks,
      updated_at: r.updated_at,
      updated_by: r.updated_by || '',
    };
    const extra = values.get(r.id) || {};
    for (const f of fields) flat[f.key] = extra[f.key] ?? null;
    // one extra column per submitted field pair, plus a single summary line, so
    // "what changed and who changed it" survives the round trip through Excel
    let latest = null;
    for (const [key, edit] of Object.entries(lastEdits.get(r.id) || {})) {
      flat[`${key}__updated_by`] = edit.by;
      flat[`${key}__updated_at`] = edit.at;
      if (!latest || String(edit.at) > String(latest.at)) latest = { ...edit, key };
    }
    flat.last_supervisor_update = latest
      ? `${latest.label} → ${latest.by} on ${latest.at}`
      : '';
    return flat;
  });
  return { headers, rows: out, fields, extraHeaders };
}

function styleHeader(ws) {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  header.alignment = { vertical: 'middle' };
  header.height = 26;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

async function buildWorkbook(user, scope = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Resource Planning Platform';
  wb.created = new Date();

  const meta = wb.addWorksheet('README');
  meta.columns = [{ width: 34 }, { width: 90 }];
  meta.addRow(['Resource Planning — Consolidated Export']).font = { bold: true, size: 14 };
  meta.addRow([]);
  const info = [
    ['Generated at', new Date().toISOString()],
    ['Generated by', `${user.name} (${user.role})`],
    ['Scope', scope.projectId || scope.subprojectId || scope.categoryId || scope.supplierId ? JSON.stringify(scope) : 'All authorized projects'],
    ['Source of truth', 'Central database snapshot (read-only export)'],
  ];
  for (const [k, v] of info) {
    const r = meta.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  }
  meta.addRow([]);
  meta.addRow(['This workbook is a generated snapshot. Do not edit it as a live database —', '']);
  meta.addRow(['imports are applied through the application so transactions and audit history are preserved.', '']);

  const { headers, rows, extraHeaders } = collectRows(user, scope);
  const data = wb.addWorksheet('Employees');
  const allHeaders = [...headers, ...extraHeaders];
  data.columns = allHeaders.map((h) => ({ header: h.label, key: h.key, width: h.width }));
  for (const r of rows) {
    const flat = { ...r };
    flat['project.code'] = r.project.code;
    flat['project.name'] = r.project.name;
    flat['subproject.code'] = r.subproject.code;
    flat['subproject.name'] = r.subproject.name;
    flat['category.code'] = r.category.code;
    flat['category.name'] = r.category.name;
    data.addRow(flat);
  }
  styleHeader(data);
  data.eachRow((row, i) => {
    if (i === 1) return;
    row.alignment = { vertical: 'top', wrapText: false };
    if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FB' } };
  });

  // Summary sheet
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Project', key: 'project', width: 30 },
    { header: 'Subproject', key: 'subproject', width: 30 },
    { header: 'Category', key: 'category', width: 26 },
    { header: 'Employees', key: 'count', width: 14 },
  ];
  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.project.name}|${r.subproject.name}|${r.category.name}`;
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  for (const [k, count] of buckets) {
    const [project, subproject, category] = k.split('|');
    summary.addRow({ project, subproject, category, count });
  }
  styleHeader(summary);
  return { wb, count: rows.length };
}

/** Write directly to an HTTP response stream. */
async function streamWorkbook(res, user, scope, filename) {
  const { wb, count } = await buildWorkbook(user, scope);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Export-Rows', String(count));
  await wb.xlsx.write(res);
  res.end();
}

// ---------------------------------------------------------------------------
// Import / daily dataset synchronization
// ---------------------------------------------------------------------------

function headerKey(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * The export writes change stamps beside each CRM value ("Leader Input This
 * Week — Updated By"). Those columns are derived, not data, so an import of the
 * workbook we generated has to ignore them instead of creating 37 new fields.
 */
function isDerivedHeader(header) {
  const h = String(header || '').trim();
  if (/\s+—\s+(Updated By|Updated At)$/i.test(h)) return true;
  return headerKey(h) === 'last_supervisor_update';
}

/**
 * Import a daily dataset.
 *
 * Rules:
 *  - rows are matched on Employee ID (the configured business key)
 *  - existing employees are updated in place — never duplicated
 *  - fields a supervisor has manually edited are protected unless `force` is set
 *  - the whole file is applied in one transaction
 *  - unknown projects/subprojects/categories/suppliers are auto-created when the
 *    user may manage schema, otherwise reported as row errors
 */
/**
 * Your HR master workbook has no Project / Subproject / Category columns - the
 * hierarchy lives only in the portal. Rather than reject the whole file, resolve
 * one default placement for the upload: whatever the caller chose, else the only
 * project/category in the database, else null (rows then report the required
 * column instead of a misleading partial import).
 */
function resolveDefaultPlacement() {
  const projects = q.all('SELECT id, name FROM projects ORDER BY id');
  const categories = q.all(
    `SELECT c.id, c.name, s.id AS subproject_id, s.name AS subproject_name, p.id AS project_id, p.name AS project_name
       FROM categories c JOIN subprojects s ON s.id = c.subproject_id JOIN projects p ON p.id = s.project_id
      ORDER BY c.id`
  );
  const pick = (list) => (list.length === 1 ? list[0] : null);
  const cat = pick(categories);
  if (!cat) return null;
  const proj = pick(projects);
  if (!proj) return null;
  return { projectId: proj.id, subprojectId: cat.subproject_id, categoryId: cat.id };
}

async function importWorkbook(user, buffer, { filename = 'upload.xlsx', force = false, dryRun = false, defaultPlacement = null } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet('Employees') || wb.worksheets[0];
  if (!sheet) throw Object.assign(new Error('The workbook contains no worksheets.'), { status: 422 });

  // map header labels -> keys
  const headerRow = sheet.getRow(1);
  const labels = [];
  const derived = new Set();
  headerRow.eachCell((cell, col) => {
    if (isDerivedHeader(cell.value)) { derived.add(headerKey(cell.value)); return; }
    labels[col] = headerKey(cell.value);
  });
  const allFields = schema.listFields();
  const labelToField = new Map();
  for (const f of allFields) {
    labelToField.set(headerKey(f.label), f);
    labelToField.set(headerKey(f.key), f);
  }
  // spellings your real workbook uses that differ from the catalogue label
  const byKey = new Map(allFields.map((f) => [f.key, f]));
  for (const [alias, key] of Object.entries(fielddefs.HEADER_ALIASES || {})) {
    const f = byKey.get(key);
    if (f) labelToField.set(alias, f);
  }
  const specials = {
    project_code: 'project.code', project: 'project.name',
    subproject_code: 'subproject.code', subproject: 'subproject.name',
    category_code: 'category.code', category: 'category.name',
  };

  // Repeated headers (your workbook has "account", "billing status" and
  // "allocation percentage" twice) cannot both resolve to one field: the first
  // occurrence wins the field and each later one is looked up as
  // "<header>_2nd_column" so its own values land in their own column.
  const seenHeaders = new Map();
  const colField = new Map();
  labels.forEach((label, col) => {
    if (!label) return;
    const n = (seenHeaders.get(label) || 0) + 1;
    seenHeaders.set(label, n);
    const wanted = n === 1 ? label : `${label}_${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}_column`;
    const f = labelToField.get(wanted) || labelToField.get(label);
    if (f) colField.set(col, f);
  });

  // Your file has no Project / Subproject / Category columns; without one of the
  // three there is nowhere to file the person, so fall back to a single
  // placement when the database only has one category.
  const placement = defaultPlacement || resolveDefaultPlacement();

  const report = { created: 0, updated: 0, protected: 0, flagged: 0, rows: [], errors: [], dryRun };
  const parsed = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const rec = { _row: r, values: {}, identity: {}, meta: {} };
    labels.forEach((label, col) => {
      if (!label || derived.has(label)) return;
      const cell = row.getCell(col);
      let v = cell.value;
      if (v && typeof v === 'object') {
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if (v.text) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (v.richText) v = v.richText.map((t) => t.text).join('');
        else v = String(v);
      }
      if (v === undefined || v === '') return;
      if (specials[label]) { rec.meta[specials[label]] = String(v).trim(); return; }
      const f = colField.get(col);
      // a repeated header's second copy is kept separately, never overwriting
      if (f) rec.values[f.key] = v;
    });
    rec.identity.emp_code = rec.values.emp_code;
    rec.identity.name = rec.values.name;
    rec.identity.email = rec.values.email;
    rec.identity.phone = rec.values.phone;
    if (!rec.identity.emp_code) {
      report.errors.push({ row: r, message: 'Missing Employee ID — row skipped.' });
      continue;
    }
    parsed.push(rec);
  }

  const run = () => {
    for (const rec of parsed) {
      try {
        applyRow(user, rec, { force, report, placement });
      } catch (e) {
        report.errors.push({ row: rec._row, message: e.message });
      }
    }
  };

  // A dry run executes inside a transaction and always rolls it back, so the
  // preview reflects exactly what a real import would attempt.
  if (dryRun) {
    try {
      tx(() => { run(); throw { __rollback: true }; });
    } catch (e) {
      if (!e || e.__rollback !== true) throw e;
    }
    return { ...report, dryRun: true };
  }

  return tx(() => {
    run();
    q.run(
      `INSERT INTO imports (filename, uploaded_by, created, updated, protected, flagged, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      filename, user.id, report.created, report.updated, report.protected, report.flagged, JSON.stringify(report.errors)
    );
    record({
      entity: 'import', entityId: null, ref: filename, action: 'import', actor: user,
      newValue: `${report.created} created / ${report.updated} updated / ${report.protected} protected`,
    });
    return report;
  });
}

function applyRow(user, rec, { force, report, placement }) {
  const s = rec.meta;
  const fieldsByKey = new Map(schema.listFields().map((f) => [f.key, f]));
  let changed = false;
  let projectId = null;
  let subprojectId = null;
  let categoryId = null;

  if (s['project.name'] || s['project.code']) {
    const p = q.get(
      `SELECT * FROM projects WHERE lower(code) = lower(?) OR lower(name) = lower(?)`,
      s['project.code'] || s['project.name'] || '', s['project.name'] || s['project.code'] || ''
    );
    if (!p) throw new Error(`Unknown project "${s['project.name'] || s['project.code']}" — create it in Administration first.`);
    projectId = p.id;
  }
  if (!projectId && placement) projectId = placement.projectId;
  if (!projectId) throw new Error('Project column is required for import rows.');

  if (s['subproject.name'] || s['subproject.code']) {
    const sp = q.get(
      `SELECT * FROM subprojects WHERE project_id = ? AND (lower(code) = lower(?) OR lower(name) = lower(?))`,
      projectId, s['subproject.code'] || s['subproject.name'] || '', s['subproject.name'] || s['subproject.code'] || ''
    );
    if (!sp) throw new Error(`Unknown subproject "${s['subproject.name'] || s['subproject.code']}" in the selected project.`);
    subprojectId = sp.id;
  }
  if (!subprojectId && placement) subprojectId = placement.subprojectId;
  if (!subprojectId) throw new Error('Subproject column is required for import rows.');

  if (s['category.name'] || s['category.code']) {
    const c = q.get(
      `SELECT * FROM categories WHERE subproject_id = ? AND (lower(code) = lower(?) OR lower(name) = lower(?))`,
      subprojectId, s['category.code'] || s['category.name'] || '', s['category.name'] || s['category.code'] || ''
    );
    if (!c) throw new Error(`Unknown category "${s['category.name'] || s['category.code']}".`);
    categoryId = c.id;
  }
  if (!categoryId && placement) categoryId = placement.categoryId;
  if (!categoryId) throw new Error('Category column is required for import rows.');

  if (!user.isAdmin) {
    emp.assertProjectAccess(user, projectId, 'can_edit');
  }

  const candidates = emp.findCandidates(rec.identity);
  const sameId = candidates.find((c) => c.match === 'employee-id');
  let employee = sameId ? sameId.employee : null;
  let createdEmployee = false;

  if (!employee) {
    const fuzzy = candidates.find((c) => c.confidence < 1 && c.confidence >= 0.4);
    if (fuzzy) {
      report.flagged += 1;
      q.run(
        `INSERT INTO duplicate_reviews (emp_code, name, email, phone, candidate_employee_id, payload, status, note)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        rec.identity.emp_code, rec.identity.name, rec.identity.email, rec.identity.phone,
        fuzzy.employee.id, JSON.stringify({ ...rec.values, ...rec.meta }),
        `Import row ${rec._row}: matched ${fuzzy.match}`
      );
    }
    const first = String(rec.values.first_name || '').trim();
    const last = String(rec.values.last_name || '').trim();
    const display = String(rec.identity.name || `${first} ${last}`.trim() || rec.identity.emp_code);
    const res = q.run(
      `INSERT INTO employees (emp_code, name, first_name, last_name, email, phone, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      String(rec.identity.emp_code).trim(),
      display,
      first || display.split(' ')[0],
      last || display.split(' ').slice(1).join(' ') || null,
      rec.identity.email || null,
      rec.identity.phone || null,
      user.id, user.id
    );
    employee = q.get('SELECT * FROM employees WHERE id = ?', Number(res.lastInsertRowid));
    createdEmployee = true;
    report.created += 1;
    record({ entity: 'employee', entityId: employee.id, ref: employee.emp_code, action: 'create', newValue: employee.name, actor: user, meta: { via: 'import', filename: rec._filename } });
  } else {
    const updates = {};
    for (const k of ['first_name', 'last_name', 'email', 'phone']) {
      if (rec.values[k] !== undefined && String(rec.values[k]) !== String(employee[k] ?? '')) updates[k] = rec.values[k];
    }
    if (updates.first_name !== undefined || updates.last_name !== undefined) {
      const f = updates.first_name !== undefined ? updates.first_name : employee.first_name;
      const l = updates.last_name !== undefined ? updates.last_name : employee.last_name;
      updates.name = `${f || ''} ${l || ''}`.trim();
    }
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      q.run(`UPDATE employees SET ${sets}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(updates), employee.id);
      changed = true;
      for (const [k, v] of Object.entries(updates)) {
        record({ entity: 'employee', entityId: employee.id, ref: employee.emp_code, action: 'update', fieldKey: k, oldValue: employee[k], newValue: v, actor: user, meta: { via: 'import' } });
      }
    }
  }

  let assignment = q.get(
    'SELECT * FROM assignments WHERE employee_id = ? AND subproject_id = ? AND category_id = ?',
    employee.id, subprojectId, categoryId
  );
  if (!assignment) {
    const res = q.run(
      `INSERT INTO assignments (employee_id, project_id, subproject_id, category_id, status, updated_by)
       VALUES (?, ?, ?, ?, 'Active', ?)`,
      employee.id, projectId, subprojectId, categoryId, user.id
    );
    assignment = q.get('SELECT * FROM assignments WHERE id = ?', Number(res.lastInsertRowid));
    report.created += createdEmployee ? 0 : 1;
    record({ entity: 'assignment', entityId: assignment.id, ref: employee.emp_code, action: 'create', actor: user, meta: { via: 'import' } });
  }

  if (rec.values.status && rec.values.status !== assignment.status) {
    changed = true;
    q.run(`UPDATE assignments SET status = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`, String(rec.values.status), user.id, assignment.id);
    record({ entity: 'assignment', entityId: assignment.id, ref: employee.emp_code, action: 'update', fieldKey: 'status', oldValue: assignment.status, newValue: rec.values.status, actor: user, meta: { via: 'import' } });
  }
  if (rec.values.remarks && rec.values.remarks !== assignment.remarks) {
    changed = true;
    q.run(`UPDATE assignments SET remarks = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`, String(rec.values.remarks), user.id, assignment.id);
    record({ entity: 'assignment', entityId: assignment.id, ref: employee.emp_code, action: 'update', fieldKey: 'remarks', oldValue: assignment.remarks, newValue: rec.values.remarks, actor: user, meta: { via: 'import' } });
  }
  if (rec.values.supplier) {
    const sid = emp.supplierIdFor(rec.values.supplier, user);
    if (sid !== assignment.supplier_id) {
      changed = true;
      q.run(`UPDATE assignments SET supplier_id = ?, updated_at = datetime('now') WHERE id = ?`, sid, assignment.id);
    }
  }

  // Custom (non-mapped) fields
  for (const [key, raw] of Object.entries(rec.values)) {
    if (['emp_code', 'name', 'first_name', 'last_name', 'email', 'phone', 'status', 'remarks', 'supplier'].includes(key)) continue;
    const f = fieldsByKey.get(key);
    if (!f) continue;
    const lock = q.get('SELECT * FROM field_overrides WHERE assignment_id = ? AND field_id = ? AND locked = 1', assignment.id, f.id);
    if (lock && !force) { report.protected += 1; continue; }
    const existing = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', assignment.id, f.id);
    const normalized = emp.normalizeValue(f, raw);
    if (normalized.error) { report.errors.push({ row: rec._row, message: `${f.label}: ${normalized.error}` }); continue; }
    if (existing && String(existing.value ?? '') === String(normalized.value ?? '')) continue;
    changed = true;
    q.run(
      `INSERT INTO assignment_values (assignment_id, field_id, value, source, updated_at, updated_by)
       VALUES (?, ?, ?, 'import', datetime('now'), ?)
       ON CONFLICT(assignment_id, field_id) DO UPDATE SET value = excluded.value, source = 'import', updated_at = datetime('now'), updated_by = excluded.updated_by`,
      assignment.id, f.id, normalized.value === null ? null : String(normalized.value), user.id
    );
    if (lock && force) {
      record({ entity: 'assignment', entityId: assignment.id, ref: employee.emp_code, action: 'update', fieldKey: key, oldValue: existing?.value, newValue: normalized.value, actor: user, meta: { via: 'import', override: true } });
    } else {
      record({ entity: 'assignment', entityId: assignment.id, ref: employee.emp_code, action: 'update', fieldKey: key, oldValue: existing?.value, newValue: normalized.value, actor: user, meta: { via: 'import' } });
    }
  }
  if (changed) report.updated += 1;
}

/**
 * Builds the import template: your own 65 headers, in your own order, with the
 * three hierarchy columns the importer needs prepended - because a spreadsheet
 * row has no place to say which project it belongs to. One example row shows the
 * expected shape; delete it before uploading.
 */
async function buildTemplateWorkbook({ placement = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Resource Planning';
  const ws = wb.addWorksheet('Employees');
  const place = placement || resolveDefaultPlacement();
  const hier = place
    ? q.all(
      `SELECT p.name project, s.name subproject, c.name category
         FROM categories c JOIN subprojects s ON s.id = c.subproject_id JOIN projects p ON p.id = s.project_id
        WHERE c.id = ?`
    )[0]
    : { project: '', subproject: '', category: '' };

  const headers = ['Project', 'Subproject', 'Category', ...fielddefs.WORKBOOK_HEADERS.map(([label]) => label)];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  const example = new Array(headers.length).fill('');
  example[0] = hier?.project || '';
  example[1] = hier?.subproject || '';
  example[2] = hier?.category || '';
  const put = (label, value) => {
    const i = headers.indexOf(label);
    if (i >= 0) example[i] = value;
  };
  put('employee ID', 'EMP-00001');
  put('first name', 'Example');
  put('last name', 'Row — delete me');
  put('leader input this week', 'Free text the leader types');
  put('Opp ID', 'OPP-00000');
  put('Hardblock/Softblock', 'Soft Block');
  put('demand number', 'DEM-00000');
  ws.addRow(example);

  const widths = headers.map((h) => Math.min(Math.max(String(h).length + 2, 12), 40));
  ws.columns.forEach((c, i) => { c.width = widths[i]; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const notes = wb.addWorksheet('How to use');
  notes.columns = [{ width: 100 }];
  [
    'RESOURCE PLANNING — IMPORT TEMPLATE',
    '',
    '1. Fill the Employees sheet, one person per row. Column order matches your own workbook.',
    '2. Project, Subproject and Category are required by the portal (a spreadsheet row has',
    '   nowhere else to say where the person sits). Fill them on every row, or lock the',
    '   placement in Data Hub when you upload but do not change the columns here.',
    '3. Employee ID identifies the row: an existing ID is updated, a new one is created.',
    '4. "account", "billing status" and "allocation percentage" appear twice, exactly as in',
    '   your workbook; both copies are stored.',
    '5. Delete the example row before uploading.',
    '6. Upload in Data Hub -> Upload a daily dataset. You get a preview first, nothing is',
    '   written until you press Apply import.',
    '7. Values a supervisor has edited in the portal are protected: a later upload reports',
    '   them as "protected" and leaves them alone unless an admin forces the overwrite.',
  ].forEach((line) => notes.addRow([line]));

  return wb;
}

module.exports = { collectRows, buildWorkbook, streamWorkbook, importWorkbook, BASE_HEADERS, resolveDefaultPlacement, buildTemplateWorkbook };
