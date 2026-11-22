'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { db, DB_FILE, DATA_DIR } = require('./db');

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
module.exports = { saveRestorePoint };
