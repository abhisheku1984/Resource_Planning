'use strict';
const { q, tx, remember } = require('./db');
const { record } = require('./audit');
const fielddefs = require('./fielddefs');

/**
 * Field catalogue + dynamic column engine.
 *
 * A "field" is any configurable attribute. Core fields are stored on the
 * employees table and mapped through; everything else lives in
 * assignment_values so administrators can invent new columns at runtime.
 */
const CORE_FIELDS = fielddefs.CORE;
const DEFAULT_FIELDS = [...fielddefs.IMPORTED, ...fielddefs.LEGACY];

/**
 * Idempotent: inserts any catalogue field that is missing and refreshes the
 * presentation metadata (group, filterable) without touching stored values.
 */
function seedFields() {
  const existing = new Set(q.all('SELECT key FROM fields').map((r) => r.key));
  for (const f of [...CORE_FIELDS, ...DEFAULT_FIELDS]) {
    if (existing.has(f.key)) {
      q.run('UPDATE fields SET group_name = ? WHERE key = ? AND (group_name IS NULL OR group_name <> ?)',
        f.group || null, f.key, f.group || null);
      continue;
    }
    q.run(
      `INSERT INTO fields (key, label, type, options, help, core, system, group_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      f.key,
      f.label,
      f.type,
      f.options ? JSON.stringify(f.options) : null,
      f.help || null,
      f.core ? 1 : 0,
      f.system ? 1 : 0,
      f.group || null
    );
  }
  // keep the facet/submit flags on the catalogue definition
  for (const f of [...CORE_FIELDS, ...DEFAULT_FIELDS]) {
    if (!f.filterable && !f.submit) continue;
    const row = q.get('SELECT id FROM fields WHERE key = ?', f.key);
    if (!row) continue;
    for (const cat of q.all('SELECT id FROM categories')) {
      const exists = q.get('SELECT 1 x FROM category_fields WHERE category_id = ? AND field_id = ?', cat.id, row.id);
      if (!exists) {
        q.run(
          `INSERT INTO category_fields (category_id, field_id, visible, editable, required, filterable, submit_field, sort_order)
           VALUES (?, ?, 1, 1, 0, ?, ?, ?)`,
          cat.id, row.id, f.filterable ? 1 : 0, f.submit ? 1 : 0, 900 + row.id
        );
      } else {
        q.run('UPDATE category_fields SET filterable = ?, submit_field = ? WHERE category_id = ? AND field_id = ?',
          f.filterable ? 1 : 0, f.submit ? 1 : 0, cat.id, row.id);
      }
    }
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
    group: row.group_name || null,
    core: !!row.core,
    system: !!row.system,
    imported: !!row.imported,
  };
}

function listFields() {
  return remember('fields:all', () => q.all('SELECT * FROM fields ORDER BY id').map(fieldDef));
}

/** Field catalogue grouped for the "show columns" picker. */
function groupedFields() {
  const groups = new Map();
  for (const f of listFields()) {
    const g = f.group || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  return [...groups.entries()].map(([name, fields]) => ({ name, fields }));
}

/**
 * Effective column configuration for a category.
 * Falls back to a sensible default set when a category has never been configured,
 * so new categories are instantly usable.
 */
function columnsForCategory(categoryId) {
  const key = `cols:${categoryId}`;
  const cached = remember(key, () => null);
  if (cached) return cached;
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
      filterable: c ? !!c.filterable : false,
      submitField: c ? !!c.submit_field : false,
      sort: c ? c.sort_order : f.id,
      section: c ? c.section : null,
    });
  }
  const sorted = out.sort((a, b) => a.sort - b.sort || a.id - b.id);
  // cache inside the current request only
  remember(key, () => sorted);
  return sorted;
}

function setCategoryFields(categoryId, rows, actor) {
  return tx(() => {
    q.run('DELETE FROM category_fields WHERE category_id = ?', categoryId);
    let order = 10;
    for (const r of rows) {
      q.run(
        `INSERT INTO category_fields
           (category_id, field_id, visible, editable, required, filterable, submit_field, sort_order, section)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        categoryId,
        r.field_id,
        r.visible === false ? 0 : 1,
        r.editable === false ? 0 : 1,
        r.required ? 1 : 0,
        r.filterable ? 1 : 0,
        r.submit_field ? 1 : 0,
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
  groupedFields,
  fieldDef,
  parseOptions,
  supplierOptions,
  columnsForCategory,
  setCategoryFields,
  hierarchy,
  scopeLabels,
};
