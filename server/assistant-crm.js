'use strict';
// The assistant opens a real CRM form. Typing only drafts values. Its explicit
// Save uses the normal supervisor submit transaction, revision and audit trail.
const { q } = require('./db');
const { assertAssignment, denied, invalid } = require('./access');
const { can } = require('./auth');
const { getAssignment, MAPPED } = require('./query');
const schema = require('./schema');

function crmForm(user, id, projectName, guided = false) {
  if (!can(user, 'crm.use')) throw denied('You do not have CRM permission.');
  assertAssignment(user, id, 'can_crm');
  const placement = typeof projectName === 'string' && q.get(`SELECT e.name, e.emp_code FROM giga_assignments g
    JOIN employees e ON e.id = g.employee_id WHERE g.assignment_id = ? AND g.project_name = ?`, id, projectName);
  if (!placement) {
    throw denied('This placement is not in the selected Giga project. Reopen the CRM record.');
  }
  const row = getAssignment(user, id);
  const canEdit = can(user, 'employee.edit') && (user.isAdmin || user.projects.some((p) => p.id === row.projectId && p.can_edit));
  const layout = new Map(schema.categoryLayout(row.categoryId, user).map((c) => [c.key, c]));
  const fields = schema.crmKeys().filter((key) => !['emp_code', 'giga_project_name', 'remarks'].includes(key)).map((key) => {
    const { label, type, options, editable, required } = layout.get(key);
    // The conversational guide updates placement fields, never a cross-placement
    // identity or a status reserved for the proposal/approval conversation.
    const guideEditable = !!(canEdit && editable && MAPPED[key]?.source !== 'e' && !['block_status', 'bench_category'].includes(key));
    return { key, label, type, options, required, guideEditable,
      editable: guided ? guideEditable : !!(canEdit && (user.isAdmin || editable)), value: row.values[key] ?? '' };
  });
  return { assignmentId: id, projectName, placementLabel: [row.projectName, row.subprojectName, row.categoryName].join(' / '), name: placement.name, empCode: placement.emp_code, rev: row.rev, fields };
}

function checkCrmSubmit(user, id, body, guided = false) {
  const form = crmForm(user, id, body.crmProjectName, guided);
  if (!Number.isSafeInteger(body.rev) || body.rev < 1) throw invalid('Reopen the CRM record before saving.');
  const editable = new Set(form.fields.filter((f) => f.editable).map((f) => f.key));
  if (!body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes) || !Object.keys(body.changes).length || Object.keys(body.changes).some((k) => !editable.has(k))) {
    throw denied('Only editable fields on this CRM form can be saved here.');
  }
  return form;
}
module.exports = { crmForm, checkCrmSubmit };
