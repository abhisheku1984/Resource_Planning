'use strict';
const { q, tx } = require('./db');
const { record } = require('./audit');

/**
 * Field catalogue + dynamic column engine.
 *
 * A "field" is any configurable attribute. Core fields are stored on the
 * employees table and mapped through; everything else lives in
 * assignment_values so administrators can invent new columns at runtime.
 */
const CORE_FIELDS = [
  { key: 'emp_code', label: 'Employee ID', type: 'text', core: 1, system: 1, help: 'Unique business key. Used to detect duplicates.' },
  { key: 'name', label: 'Employee Name', type: 'text', core: 1, system: 1 },
  { key: 'designation', label: 'Designation', type: 'text', core: 1 },
  { key: 'email', label: 'Email Address', type: 'email', core: 1 },
  { key: 'phone', label: 'Contact Number', type: 'tel', core: 1 },
];

const DEFAULT_FIELDS = [
  { key: 'status', label: 'Current Status', type: 'select', options: ['Active', 'On Leave', 'Training', 'Billing Hold', 'Released', 'Completed'] },
  { key: 'supplier', label: 'Supplier', type: 'select', options: 'SUPPLIERS' },
  { key: 'training_status', label: 'Training Status', type: 'select', options: ['Not Started', 'In Progress', 'Completed', 'Failed', 'Waived'] },
  { key: 'joining_date', label: 'Joining Date', type: 'date' },
  { key: 'completion_status', label: 'Completion Status', type: 'select', options: ['Pending', 'Partial', 'Completed', 'Dropped'] },
  { key: 'billing_status', label: 'Billing Status', type: 'select', options: ['Billable', 'Non-Billable', 'Shadow', 'T&M', 'Fixed Price'] },
  { key: 'allocation_status', label: 'Allocation Status', type: 'select', options: ['Allocated', 'Partially Allocated', 'Bench', 'Rolling Off'] },
  { key: 'effective_date', label: 'Effective Date', type: 'date' },
  { key: 'skill_track', label: 'Skill Track', type: 'select', options: ['Java', 'Data Engineering', 'Cloud', 'QA', 'Business Analysis', 'DevOps'] },
  { key: 'remarks', label: 'Remarks', type: 'textarea' },
];

function seedFields() {
  const existing = q.all('SELECT key FROM fields').map((r) => r.key);
  let order = 0;
  for (const f of [...CORE_FIELDS, ...DEFAULT_FIELDS]) {
    order += 10;
    if (existing.includes(f.key)) continue;
    q.run(
      `INSERT INTO fields (key, label, type, options, help, core, system) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      f.key,
      f.label,
      f.type,
      f.options ? JSON.stringify(f.options) : null,
      f.help || null,
      f.core || 0,
      f.system || 0
    );
  }
}

function supplierOptions() {
  return q.all('SELECT name FROM suppliers WHERE active = 1 ORDER BY name').map((r) => r.name);
}

function parseOptions(field) {
  if (!field.options) return null;
  if (field.options === 'SUPPLIERS') return supplierOptions();
  try {
    const parsed = JSON.parse(field.options);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fieldDef(row) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: parseOptions(row),
    help: row.help,
    core: !!row.core,
    system: !!row.system,
  };
}

function listFields() {
  return q.all('SELECT * FROM fields ORDER BY id').map(fieldDef);
}

/**
 * Effective column configuration for a category.
 * Falls back to a sensible default set when a category has never been configured,
 * so new categories are instantly usable.
 */
function columnsForCategory(categoryId) {
  const fields = q.all('SELECT * FROM fields ORDER BY id').map(fieldDef);
  const config = new Map(
    q.all('SELECT * FROM category_fields WHERE category_id = ?', categoryId).map((r) => [r.field_id, r])
  );
  const configured = config.size > 0;
  const out = [];
  for (const f of fields) {
    const c = config.get(f.id);
    const visible = c ? !!c.visible : (!configured || f.core || f.key === 'status' || f.key === 'remarks');
    if (!visible) continue;
    out.push({
      ...f,
      visible: true,
      editable: c ? !!c.editable : true,
      required: c ? !!c.required : false,
      sort: c ? c.sort_order : f.id,
      section: c ? c.section : null,
    });
  }
  return out.sort((a, b) => a.sort - b.sort || a.id - b.id);
}

function setCategoryFields(categoryId, rows, actor) {
  return tx(() => {
    q.run('DELETE FROM category_fields WHERE category_id = ?', categoryId);
    let order = 10;
    for (const r of rows) {
      q.run(
        `INSERT INTO category_fields (category_id, field_id, visible, editable, required, sort_order, section)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        categoryId,
        r.field_id,
        r.visible === false ? 0 : 1,
        r.editable === false ? 0 : 1,
        r.required ? 1 : 0,
        r.sort_order ?? order,
        r.section || null
      );
      order += 10;
    }
    record({ entity: 'category', entityId: categoryId, action: 'update', fieldKey: 'columns', newValue: `${rows.length} columns`, actor });
    return columnsForCategory(categoryId);
  });
}

/** Full project -> subproject -> category tree the user is allowed to see. */
function hierarchy(user) {
  const allowed = user.isAdmin
    ? q.all('SELECT id FROM projects').map((r) => r.id)
    : user.projects.map((p) => p.id);
  if (!allowed.length) return [];
  const ph = allowed.map(() => '?').join(',');
  const projects = q.all(`SELECT * FROM projects WHERE id IN (${ph}) ORDER BY name`, ...allowed);
  const subs = q.all(
    `SELECT * FROM subprojects WHERE project_id IN (${ph}) ORDER BY sort_order, name`,
    ...allowed
  );
  const cats = subs.length
    ? q.all(
        `SELECT * FROM categories WHERE subproject_id IN (${subs.map(() => '?').join(',')}) ORDER BY sort_order, name`,
        ...subs.map((s) => s.id)
      )
    : [];
  const counts = new Map(
    q.all(
      `SELECT subproject_id, COUNT(*) c FROM assignments WHERE active = 1 AND subproject_id IN (${subs
        .map(() => '?')
        .join(',')}) GROUP BY subproject_id`,
      ...(subs.length ? subs.map((s) => s.id) : [0])
    ).map((r) => [r.subproject_id, r.c])
  );
  return projects.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    client: p.client,
    status: p.status,
    description: p.description,
    start_date: p.start_date,
    grant: user.isAdmin ? { can_edit: 1, can_export: 1, can_crm: 1 } : user.projects.find((x) => x.id === p.id),
    subprojects: subs
      .filter((s) => s.project_id === p.id)
      .map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        description: s.description,
        employeeCount: counts.get(s.id) || 0,
        categories: cats.filter((c) => c.subproject_id === s.id).map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          description: c.description,
        })),
      })),
  }));
}

function scopeLabels({ projectId, subprojectId, categoryId }) {
  const project = projectId ? q.get('SELECT * FROM projects WHERE id = ?', projectId) : null;
  const sub = subprojectId ? q.get('SELECT * FROM subprojects WHERE id = ?', subprojectId) : null;
  const cat = categoryId ? q.get('SELECT * FROM categories WHERE id = ?', categoryId) : null;
  return { project, subproject: sub, category: cat };
}

module.exports = {
  CORE_FIELDS,
  DEFAULT_FIELDS,
  seedFields,
  listFields,
  fieldDef,
  parseOptions,
  supplierOptions,
  columnsForCategory,
  setCategoryFields,
  hierarchy,
  scopeLabels,
};
