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
  filterable  INTEGER NOT NULL DEFAULT 0,   -- shown as a filter chip on the bench board
  submit_field INTEGER NOT NULL DEFAULT 0,  -- captured by the supervisor submit form
  sort_order  INTEGER NOT NULL DEFAULT 0,
  section     TEXT,
  PRIMARY KEY (category_id, field_id)
);

CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code    TEXT NOT NULL UNIQUE,        -- configured business key
  name        TEXT NOT NULL,              -- display name; kept as "First Last" for search and sorting
  first_name  TEXT,                       -- the workbook keeps these separate
  last_name   TEXT,
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
  rev          INTEGER NOT NULL DEFAULT 1,
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

-- Proposed changes raised by the assistant. Nothing reaches the master data
-- until a human approves: the row records exactly what would change, so the
-- approval is a review of a concrete diff rather than a re-run of the parser.
CREATE TABLE IF NOT EXISTS agent_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,            -- update_assignment
  assignment_id INTEGER,
  summary      TEXT NOT NULL,            -- one line the approver reads
  before_json  TEXT NOT NULL,            -- field key -> value at proposal time
  after_json   TEXT NOT NULL,            -- field key -> proposed value
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | failed | stale
  requested_by INTEGER REFERENCES users(id),
  requested_by_name TEXT,
  decided_by   INTEGER REFERENCES users(id),
  decided_by_name TEXT,
  decided_at   TEXT,
  decision_note TEXT,
  result_json  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent_actions(status, id);
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

CREATE TABLE IF NOT EXISTS import_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
  total_rows  INTEGER NOT NULL DEFAULT 0,
  processed   INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  new_fields  TEXT,
  errors      TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  user_id     INTEGER REFERENCES users(id)
);

-- Small key/value store for platform settings (e.g. which columns the CRM
-- panel shows). Kept in the database so the choice travels with the data
-- rather than living in code.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
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

/** Additive migrations so an existing database keeps working. */
function migrate() {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const add = (table, name, ddl) => {
    if (!cols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add('category_fields', 'filterable', 'filterable INTEGER NOT NULL DEFAULT 0');
  add('category_fields', 'submit_field', 'submit_field INTEGER NOT NULL DEFAULT 0');
  add('fields', 'group_name', 'group_name TEXT');
  add('fields', 'imported', 'imported INTEGER NOT NULL DEFAULT 0');
  // New filterable/submit fields must reach categories that already exist, not
  // just the ones seeded after this release, so the column is added before any
  // category layout is read.
  add('employees', 'name_source', "name_source TEXT DEFAULT 'manual'");
  add('employees', 'first_name', 'first_name TEXT');
  add('employees', 'last_name', 'last_name TEXT');
  // backfill the split columns from the display name for existing rows
  db.exec(`UPDATE employees SET
             first_name = substr(name, 1, instr(name || ' ', ' ') - 1),
             last_name  = ltrim(substr(name, instr(name || ' ', ' ') + 1))
           WHERE first_name IS NULL`);
  // Optimistic-concurrency token. A timestamp is only second-precise, so two
  // saves inside the same second would compare equal and silently clobber.
  add('assignments', 'rev', 'rev INTEGER NOT NULL DEFAULT 1');
  // Only populated when unlinking a deleted account; no table rebuild or data reset.
  add('assignments', 'archived_updater_name', 'archived_updater_name TEXT');
  // value lookups by field are the hot path for filters
  db.exec('CREATE INDEX IF NOT EXISTS idx_av_field_value ON assignment_values(field_id, value)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_assign_proj ON assignments(project_id, category_id, active)');
  // Covers the facet grouping, so SQLite can answer a filter dropdown straight
  // from the index without touching assignment_values rows or joining back.
  db.exec('CREATE INDEX IF NOT EXISTS idx_av_field_value_key ON assignment_values(field_id, value, assignment_id)');
}
migrate();

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

// Prepared statements are cached, so the cache is bounded: the query engine
// builds a handful of statements per request (variable IN-lists, facets) and an
// unbounded cache would grow with every distinct page size.
const stmtCache = new Map();
const STMT_CACHE_MAX = 400;
function prepare(sql) {
  let st = stmtCache.get(sql);
  if (!st) {
    if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.delete(stmtCache.keys().next().value);
    st = db.prepare(sql);
    stmtCache.set(sql, st);
  }
  return st;
}

const q = {
  all: (sql, ...params) => prepare(sql).all(...params),
  get: (sql, ...params) => prepare(sql).get(...params),
  run: (sql, ...params) => prepare(sql).run(...params),
  prepare,
};

/**
 * Per-request memo. Config (project -> subproject -> category trees, column
 * layouts, the field catalogue) is read on nearly every call; without this the
 * same rows are re-queried dozens of times per request.
 */
let memo = null;
function batch(fn) {
  if (memo) return fn();
  memo = new Map();
  try {
    return fn();
  } finally {
    memo = null;
  }
}
function remember(key, fn) {
  if (!memo) return fn();
  if (memo.has(key)) return memo.get(key);
  const value = fn();
  memo.set(key, value);
  return value;
}

module.exports = { db, q, tx, DB_FILE, DATA_DIR, SCHEMA, batch, remember };
