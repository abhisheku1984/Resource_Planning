'use strict';
// Local Windows preview only. The original database is the rollback copy.
// Never import server/db here: opening it can create or migrate a database.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function prepareWorkbookPreview(dataDir) {
  const filename = 'guided-preview.db';
  const original = path.join(dataDir, filename);
  const destination = path.join(dataDir, 'workbook-preview');
  const file = path.join(destination, filename);
  if (fs.existsSync(destination)) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Incomplete data/workbook-preview folder. Stop the preview and move that folder aside before retrying.');
    }
    return { file, created: false }; // a restart must never clear an uploaded roster
  }
  if (!fs.existsSync(original)) {
    throw new Error('Start START-PREVIEW.cmd once without --workbook, then stop it with Ctrl+C. Its data/guided-preview.db must exist first.');
  }

  // SQLite takes a consistent snapshot, including committed WAL pages. Build it
  // privately so a crash or failed copy cannot activate a half-prepared roster.
  const stage = fs.mkdtempSync(path.join(dataDir, '.preparing-workbook-'));
  const stagedFile = path.join(stage, filename);
  try {
    const source = new DatabaseSync(original, { readOnly: true });
    try { source.prepare('VACUUM INTO ?').run(stagedFile); }
    finally { source.close(); }

    const copy = new DatabaseSync(stagedFile);
    try {
      if (!copy.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get()) {
        throw new Error('The guided preview needs an active administrator for the upload.');
      }
      // FK cascades remove placements, values, overrides and group memberships.
      // Review payloads and proposals belong to the old roster. Keep accounts,
      // grants, layouts, hierarchy, import/audit history and ID sequences intact.
      copy.exec(`PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        DELETE FROM sessions;
        DELETE FROM duplicate_reviews;
        DELETE FROM agent_actions;
        DELETE FROM employees;
        INSERT INTO audit_log (entity, ref, action, new_value, actor_name)
          VALUES ('dataset', 'Workbook preview', 'prepare', 'Empty roster prepared from guided preview', 'Preview setup');
        COMMIT;`);
      if (copy.prepare('SELECT 1 FROM assignments LIMIT 1').get() || copy.prepare('PRAGMA foreign_key_check').get()
          || copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') {
        throw new Error('The prepared preview did not pass its database checks.');
      }
    } finally { copy.close(); } // closing also rolls back an unfinished transaction
    fs.renameSync(stage, destination);
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true }); // only our own unpublished staging directory
    throw err;
  }
  return { file, created: true };
}

if (require.main === module) {
  try {
    // Deliberately no DB_FILE/CLI path override: never target the normal installation.
    const result = prepareWorkbookPreview(path.join(__dirname, '..', 'data'));
    console.log(result.created ? 'Empty workbook preview ready. Original guided preview kept for rollback.'
      : 'Using your saved workbook preview; nothing was reset.');
  } catch (err) {
    console.error('Cannot prepare the workbook preview:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { prepareWorkbookPreview };
