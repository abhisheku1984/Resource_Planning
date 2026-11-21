'use strict';
// A full-roster change is deliberately separate from an ordinary merge. A
// short-lived receipt binds an admin's full export to the state they exported
// and, after preview, to the exact workbook bytes and placement they reviewed.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { db, q, DB_FILE, DATA_DIR } = require('./db');
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

// Excel archives the visible data. Keep a private, bounded SQLite restore point
// too (including locks, grants and history). Never publish it as a download.
function saveRestorePoint() {
  const dir = path.join(DB_FILE === ':memory:' ? DATA_DIR : path.dirname(DB_FILE), 'roster-backups');
  const name = `${DB_FILE === ':memory:' ? 'memory' : path.basename(DB_FILE)}.before-last-replace.db`;
  const target = path.join(dir, name);
  let tmp;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tmp = fs.mkdtempSync(path.join(dir, '.preparing-'));
    const file = path.join(tmp, name);
    db.prepare('VACUUM INTO ?').run(file); // committed pages, including the WAL
    fs.chmodSync(file, 0o600);
    const snapshot = new DatabaseSync(file, { readOnly: true });
    try {
      if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('Invalid restore point');
    } finally { snapshot.close(); }
    if (['-wal', '-shm', '-journal'].some(s => fs.existsSync(target + s))) throw Error('Restore point is in use');
    fs.renameSync(file, target); // keep the last known good backup until the new one is complete
  } catch {
    throw Object.assign(new Error('Cannot save the database restore point. Check server disk space and backup-folder permissions. The roster was not replaced.'), { status: 503 });
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { startExport, authorize, counts, clearRoster, saveRestorePoint };
