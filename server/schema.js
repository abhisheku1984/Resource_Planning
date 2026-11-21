'use strict';
const { q, tx, remember } = require('./db');
const { record } = require('./audit');
const fielddefs = require('./fielddefs');
const { assignmentScope, suppliersFor } = require('./access');

/**
 * Field catalogue + dynamic column engine.
 *
 * A "field" is any configurable attribute. Core fields are stored on the
 * employees table and mapped through; everything else lives in
 * assignment_values so administrators can invent new columns at runtime.
 */
const CORE_FIELDS = fielddefs.CORE;
const DEFAULT_FIELDS = [...fielddefs.IMPORTED, ...fielddefs.LEGACY];

const CRM_SETTING = 'crm_fields';

/**
 * Which columns the CRM / Update panel shows, in order.
 *
 * Stored as a setting so an administrator can change the panel without a code
 * change; the catalogue default is used for a fresh database. Unknown keys are
 * dropped and the result is always returned in the stored order.
 */
function crmKeys() {
  const row = q.get('SELECT value FROM settings WHERE key = ?', CRM_SETTING);
  const known = new Set(DEFAULT_FIELDS.concat(CORE_FIELDS).map((f) => f.key));
  const fallback = fielddefs.CRM_KEYS.filter((k) => known.has(k));
  if (!row || !row.value) return fallback;
  let parsed;
  try { parsed = JSON.parse(row.value); } catch { return fallback; }
  if (!Array.isArray(parsed)) return fallback;
  const clean = parsed.filter((k) => typeof k === 'string' && known.has(k));
  if (!clean.length) return fallback;
  // anything newly added to the catalogue but not yet configured still appears,
  // at the end, so an upgrade never silently hides a column
  for (const k of fallback) if (!clean.includes(k) && fielddefs.CRM_KEYS.includes(k)) clean.push(k);
  return clean;
}

function setCrmKeys(keys, actor) {
  const known = new Set(DEFAULT_FIELDS.concat(CORE_FIELDS).map((f) => f.key));
  const clean = [...new Set((keys || []).filter((k) => known.has(k)))];
  if (!clean.length) throw Object.assign(new Error('Choose at least one column for the CRM panel.'), { status: 422 });
  q.run(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
    CRM_SETTING, JSON.stringify(clean), actor ? actor.id : null
  );
  record({ entity: 'setting', action: 'update', fieldKey: CRM_SETTING, newValue: `${clean.length} columns`, actor });
  return clean;
}

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
  // keep the facet/submit flags on the catalogue definition. Every CRM column
  // is editable by a supervisor even when it is not one of the "submit" fields,
  // so the panel can be configured to show any of them.
  const crmKeys = fielddefs.CRM_KEYS;
  for (const f of [...CORE_FIELDS, ...DEFAULT_FIELDS]) {
    if (!f.filterable && !f.submit && !crmKeys.includes(f.key)) continue;
    const row = q.get('SELECT id FROM fields WHERE key = ?', f.key);
    if (!row) continue;
    for (const cat of q.all('SELECT id FROM categories')) {
      const exists = q.get('SELECT 1 x FROM category_fields WHERE category_id = ? AND field_id = ?', cat.id, row.id);
      if (!exists) {
        q.run(
          `INSERT INTO category_fields (category_id, field_id, visible, editable, required, filterable, submit_field, sort_order)
           VALUES (?, ?, 1, 1, 0, ?, ?, ?)`,
          cat.id, row.id, f.filterable ? 1 : 0, (f.submit || crmKeys.includes(f.key)) ? 1 : 0, 900 + row.id
        );
      } else {
        q.run('UPDATE category_fields SET filterable = ?, submit_field = ? WHERE category_id = ? AND field_id = ?',
          f.filterable ? 1 : 0, (f.submit || crmKeys.includes(f.key)) ? 1 : 0, cat.id, row.id);
      }
    }
  }
}

function supplierOptions(user) {
  return suppliersFor(user, true).map((r) => r.name);
}

function parseOptions(field, user) {
  if (user?.gigaAccess && field.key === 'supplier') return supplierOptions(user);
  if (!field.options) return null;
  if (field.options === 'SUPPLIERS') return supplierOptions(user);
  try {
    const parsed = JSON.parse(field.options);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fieldDef(row, user) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: parseOptions(row, user),
    help: row.help,
    group: row.group_name || null,
    core: !!row.core,
    system: !!row.system,
    imported: !!row.imported,
  };
}

function listFields(user) {
  return remember(`fields:${user?.gigaAccess ? user.id : 'all'}`, () =>
    q.all('SELECT * FROM fields ORDER BY id').map((row) => fieldDef(row, user)));
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

/** The editor and employee table must agree on visibility and order, including
 *  catalogue fields that do not have a category_fields row yet. */
function categoryLayout(categoryId, user) {
  const config = new Map(q.all('SELECT * FROM category_fields WHERE category_id = ?', categoryId).map((r) => [r.field_id, r]));
  return listFields(user).map((f) => {
    const c = config.get(f.id);
    return {
      ...f,
      visible: c ? !!c.visible : !!(f.core || f.filterable || f.submit || f.key === 'remarks'),
      editable: user?.gigaAccess && f.key === 'giga_project_name' ? false : c ? !!c.editable : true,
      required: !!c?.required,
      filterable: c ? !!c.filterable : !!f.filterable,
      submit_field: c ? !!c.submit_field : !!f.submit,
      sort_order: c?.sort_order ?? f.id,
      section: c?.section ?? null,
      configured: !!c,
      canHide: !f.system,
    };
  }).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

function columnsForCategory(categoryId, user) {
  return remember(`cols:${categoryId}:${user?.gigaAccess ? user.id : 'all'}`, () => categoryLayout(categoryId, user).filter((f) => f.visible)
    .map(({ sort_order, submit_field, configured, canHide, ...f }) => ({ ...f, sort: sort_order, submitField: submit_field })));
}

function setCategoryFields(categoryId, rows, actor) {
  return tx(() => {
    // The layout form edits only visibility, editability, required and order.
    // Replacing its rows must not clear facet/submit flags or section metadata.
    const previous = new Map(q.all('SELECT * FROM category_fields WHERE category_id = ?', categoryId).map((r) => [r.field_id, r]));
    q.run('DELETE FROM category_fields WHERE category_id = ?', categoryId);
    let order = 10;
    for (const r of rows) {
      const prev = previous.get(r.field_id);
      q.run(
        `INSERT INTO category_fields
           (category_id, field_id, visible, editable, required, filterable, submit_field, sort_order, section)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        categoryId,
        r.field_id,
        r.visible === false ? 0 : 1,
        r.editable === false ? 0 : 1,
        r.required ? 1 : 0,
        (r.filterable ?? prev?.filterable) ? 1 : 0,
        (r.submit_field ?? prev?.submit_field) ? 1 : 0,
        r.sort_order ?? prev?.sort_order ?? order,
        r.section === undefined ? prev?.section ?? null : r.section
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
  const acl = assignmentScope(user);
  const counts = new Map();
  const visibleCategories = new Set();
  for (const r of q.all(`SELECT a.subproject_id, a.category_id, COUNT(*) c FROM assignments a
                          WHERE a.active = 1 AND ${acl.sql} GROUP BY a.subproject_id, a.category_id`, ...acl.args)) {
    counts.set(r.subproject_id, (counts.get(r.subproject_id) || 0) + r.c);
    visibleCategories.add(r.category_id);
  }
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
      .filter((s) => s.project_id === p.id && (!user.gigaAccess || counts.has(s.id)))
      .map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        description: s.description,
        employeeCount: counts.get(s.id) || 0,
        categories: cats.filter((c) => c.subproject_id === s.id && (!user.gigaAccess || visibleCategories.has(c.id))).map((c) => ({
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
  categoryLayout,
  columnsForCategory,
  setCategoryFields,
  crmKeys,
  setCrmKeys,
  hierarchy,
  scopeLabels,
};
