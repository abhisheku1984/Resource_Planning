'use strict';
// A short-lived receipt for the latest guided review in a signed-in session.
// Store only hashes + expiry in RAM, never the note, audio or raw session key.
const crypto = require('node:crypto');
const { invalid } = require('./access');
const { normalizeValue } = require('./employees');
const { checkCrmSubmit } = require('./assistant-crm');

const receipts = new Map();
const TTL = 5 * 60_000;
const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');
const conflict = (code, message) => Object.assign(new Error(message), { status: 409, code });
const stale = () => conflict('STALE', 'The record changed. Reopen it before reviewing this update.');

function interpret(user, id, body) {
  const form = checkCrmSubmit(user, id, body, true);
  if (form.rev !== body.rev) throw stale();
  const before = body.before;
  if (!before || typeof before !== 'object' || Array.isArray(before)) throw invalid('Review the original field values first.');
  const changes = [];
  for (const key of Object.keys(body.changes).sort()) {
    const f = form.fields.find((f) => f.key === key);
    if (!Object.hasOwn(before, key) || String(f.value) !== before[key]) throw stale();
    const value = body.changes[key];
    if (typeof value !== 'string' || value.length > 4000) throw invalid(`Invalid value for ${f.label} (maximum 4,000 characters).`);
    const normalized = normalizeValue(f, value);
    if (normalized.error || (f.required && normalized.value == null)) throw invalid(normalized.error || `${f.label} is required.`);
    if (typeof normalized.value === 'number' && !Number.isFinite(normalized.value)) throw invalid(`Invalid number for ${f.label}.`);
    const after = String(normalized.value ?? '');
    if (f.type === 'date' && after) {
      const d = new Date(value + 'T00:00:00Z');
      if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) throw invalid(`Use a valid YYYY-MM-DD date for ${f.label}.`);
    }
    if (after !== before[key]) changes.push({ key, label: f.label, before: before[key], after });
  }
  if (!changes.length) throw invalid('There are no changed values to save.');
  return { action: 'UPDATE', module: 'employee_crm', assignmentId: id, projectName: form.projectName, rev: form.rev,
    empCode: form.empCode, name: form.name, placementLabel: form.placementLabel, fields: changes };
}
function issue(user, session, id, body) {
  const key = digest(session);
  receipts.delete(key); // supersede even if the replacement review is invalid
  const interpretation = interpret(user, id, body), hash = digest(JSON.stringify(interpretation));
  const expires = Date.now() + TTL, ticket = crypto.randomBytes(24).toString('hex');
  for (const [k, v] of receipts) if (v.expires <= Date.now()) receipts.delete(k);
  if (receipts.size >= 1024) receipts.delete(receipts.keys().next().value);
  receipts.set(key, { ticket: digest(ticket), hash, expires });
  return { interpretation, ticket, expiresAt: new Date(expires).toISOString() };
}
function consume(user, session, id, body) {
  const key = digest(session), saved = receipts.get(key);
  const again = () => conflict('REVIEW_AGAIN', 'Review these changes again before confirming.');
  if (!saved || typeof body.ticket !== 'string' || body.ticket.length !== 48 || saved.ticket !== digest(body.ticket)) throw again();
  receipts.delete(key); // single-use, also on validation or authorization failure
  if (saved.expires <= Date.now()) throw again();
  const plan = interpret(user, id, body);
  if (digest(JSON.stringify(plan)) !== saved.hash) throw again();
  return Object.fromEntries(plan.fields.map(({ key, after }) => [key, after]));
}
module.exports = { issue, consume };
