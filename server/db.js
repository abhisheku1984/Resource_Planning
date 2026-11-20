'use strict';
/**
 * Central data layer.
 *
 * The SQLite database is the single source of truth. Excel workbooks are
 * generated *from* the database and imported *into* it — never used as a live
 * shared store. Every multi-row write runs inside a transaction.
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'resource_planning.db');

if (DB_FILE !== ':memory:' && fs.existsSync(DB_FILE) === false) {
  // file will be created by SQLite
}

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'supervisor',   -- admin | supervisor
  title         TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  client      TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  start_date  TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subprojects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  description TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subproject_id INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (subproject_id, code)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  contact_name TEXT,
  email        TEXT,
  phone        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id    INTEGER NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, employee_id)
);

-- Field catalogue: every configurable column that can appear on an employee table.
CREATE TABLE IF NOT EXISTS fields (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',   -- text | textarea | number | date | select | email | tel
  options     TEXT,                            -- JSON array for select fields
  help        TEXT,
  core        INTEGER NOT NULL DEFAULT 0,      -- core fields cannot be deleted
  system      INTEGER NOT NULL DEFAULT 0,      -- system fields cannot be hidden
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-category presentation + permission of each field (the dynamic column engine).
CREATE TABLE IF NOT EXISTS category_fields (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  field_id    INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  visible     INTEGER NOT NULL DEFAULT 1,
  editable    INTEGER NOT NULL DEFAULT 1,
  required    INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  section     TEXT,
  PRIMARY KEY (category_id, field_id)
);

CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code    TEXT NOT NULL UNIQUE,        -- configured business key
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  designation TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER REFERENCES users(id),
  updated_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees(name);

CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subproject_id INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  supplier_id  INTEGER REFERENCES suppliers(id),
  status       TEXT NOT NULL DEFAULT 'Active',
  remarks      TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by   INTEGER REFERENCES users(id),
  UNIQUE (employee_id, subproject_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_scope ON assignments(project_id, subproject_id, category_id);
CREATE INDEX IF NOT EXISTS idx_assign_employee ON assignments(employee_id);

CREATE TABLE IF NOT EXISTS assignment_values (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  field_id      INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  value         TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',   -- manual | import | seed
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    INTEGER REFERENCES users(id),
  PRIMARY KEY (assignment_id, field_id)
);

-- Fields a supervisor has edited by hand. A daily Excel refresh will not
-- silently overwrite them; the value is protected until an admin unlocks it.
CREATE TABLE IF NOT EXISTS field_overrides (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  field_id      INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  locked        INTEGER NOT NULL DEFAULT 1,
  reason        TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assignment_id, field_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,        -- employee | assignment | project | subproject | category | supplier | field | user | import
  entity_id  INTEGER,
  ref        TEXT,                 -- human readable reference (employee code etc.)
  action     TEXT NOT NULL,        -- create | update | delete | import | resolve
  field_key  TEXT,
  old_value  TEXT,
  new_value  TEXT,
  actor_id   INTEGER,
  actor_name TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- Project level delegation. A supervisor sees only rows they are granted.
CREATE TABLE IF NOT EXISTS user_projects (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  can_edit   INTEGER NOT NULL DEFAULT 1,
  can_export INTEGER NOT NULL DEFAULT 1,
  can_crm    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS user_subprojects (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subproject_id INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, subproject_id)
);

CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  allowed    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, capability)
);

CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code    TEXT,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  candidate_employee_id INTEGER,
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | linked | created | dismissed
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by INTEGER,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  protected   INTEGER NOT NULL DEFAULT 0,
  flagged     INTEGER NOT NULL DEFAULT 0,
  errors      TEXT
);
`;

db.exec(SCHEMA);

/** Run fn inside a real SQL transaction; rolls back on any error. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

const q = {
  all: (sql, ...params) => db.prepare(sql).all(...params),
  get: (sql, ...params) => db.prepare(sql).get(...params),
  run: (sql, ...params) => db.prepare(sql).run(...params),
};

module.exports = { db, q, tx, DB_FILE, DATA_DIR, SCHEMA };
