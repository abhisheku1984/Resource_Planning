'use strict';
// The assistant opens a real CRM form. Dictation only drafts values. Its explicit
// Save uses the normal supervisor submit transaction, revision and audit trail.
const { q } = require('./db');
const { assertAssignment, denied, invalid } = require('./access');
const { can } = require('./auth');
const { getAssignment } = require('./query');
const schema = require('./schema');

function crmForm(user, id, projectName) {
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
    return { key, label, type, options, required, editable: !!(canEdit && (user.isAdmin || editable)), value: row.values[key] ?? '' };
  });
  return { assignmentId: id, projectName, name: placement.name, empCode: placement.emp_code, rev: row.rev, fields };
}

function checkCrmSubmit(user, id, body) {
  const form = crmForm(user, id, body.crmProjectName);
  if (!Number.isSafeInteger(body.rev) || body.rev < 1) throw invalid('Reopen the CRM record before saving.');
  const editable = new Set(form.fields.filter((f) => f.editable).map((f) => f.key));
  if (!body.changes || !Object.keys(body.changes).length || Object.keys(body.changes).some((k) => !editable.has(k))) {
    throw denied('Only editable fields on this CRM form can be saved here.');
  }
}
module.exports = { crmForm, checkCrmSubmit };
