'use strict';
// A full-roster change is deliberately separate from an ordinary merge. A
// short-lived receipt binds an admin's full export to the state they exported
// and, after preview, to the exact workbook bytes and placement they reviewed.
const { randomUUID, createHash } = require('node:crypto');
const { q } = require('./db');
const { saveRestorePoint } = require('./restore-point');
const { denied } = require('./access');

const receipts = new Map(); // at most one per exporting administrator; no workbook contents or passwords
const conflict = message => Object.assign(new Error(message), { status: 409 });
function revision() {
  // Exports and other users signing in do not change the roster. Include
  // config/grant changes as well as workforce edits; prefer a fresh export.
  return q.get("SELECT IFNULL(MAX(id),0) v FROM audit_log WHERE entity != 'export' AND action != 'login'").v;
}
function startExport(user) {
  if (!user.isAdmin || user.gigaAccess) throw denied('Only an administrator can replace the whole roster.');
  const now = Date.now();
  for (const [id, r] of receipts) if (r.expires <= now) receipts.delete(id);
  const ticket = { token: randomUUID(), revision: revision(), expires: now + 30 * 60_000, preview: null };
  receipts.set(user.id, ticket);
  return ticket.token;
}
function authorize(user, { receipt, confirmation }, bytes, placement, dryRun) {
  if (!user.isAdmin || user.gigaAccess) throw denied('Only an administrator can replace the whole roster.');
  const ticket = receipts.get(user.id);
  const digest = createHash('sha256').update(bytes).update(JSON.stringify(placement)).digest('hex');
  function check() {
    if (!ticket || receipts.get(user.id) !== ticket || ticket.token !== receipt || ticket.expires <= Date.now() || ticket.revision !== revision()) {
      throw conflict('A fresh full export is required. Close this dialog and start Replace entire roster again.');
    }
    if (!dryRun && (confirmation !== 'REPLACE' || ticket.preview !== digest)) {
      throw conflict('Preview this exact workbook and placement without errors, then type REPLACE to confirm.');
    }
  }
  check();
  if (dryRun) ticket.preview = null;
  return {
    check,
    reviewed(clean) { check(); ticket.preview = clean ? digest : null; },
    consume() { receipts.delete(user.id); },
  };
}

function counts() {
  return q.get(`SELECT (SELECT count(*) FROM employees) people, (SELECT count(*) FROM assignments) placements,
                       (SELECT count(*) FROM field_overrides WHERE locked=1) locks`);
}
function clearRoster(actor) {
  // Called only inside the replace transaction. Preserve history and key
  // sequences; an old CRM form must never point at a newly imported placement.
  q.run(`UPDATE agent_actions SET status='stale', decided_by=?, decided_by_name=?, decided_at=datetime('now'),
         decision_note='Roster replaced' WHERE status='pending'`, actor.id, actor.name);
  q.run(`UPDATE duplicate_reviews SET status='dismissed', resolved_by=?, resolved_at=datetime('now')
         WHERE status='pending'`, actor.id);
  q.run('DELETE FROM employees'); // FK cascades: placements, values, locks and group membership, NOT accounts or grants
}

module.exports = { startExport, authorize, counts, clearRoster, saveRestorePoint };
