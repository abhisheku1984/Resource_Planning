'use strict';
// Exercise the shipped workbook, not a miniature generated stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { prepareWorkbookPreview } = require('../scripts/prepare-workbook-preview');
const root = path.join(__dirname, '..');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-workbook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('preparation refuses a missing or uninitialised source without activating a new preview', t => {
  const dir = temp(t);
  assert.throws(() => prepareWorkbookPreview(dir), /must exist first/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const source = new DatabaseSync(path.join(dir, 'guided-preview.db'));
  source.close();
  assert.throws(() => prepareWorkbookPreview(dir));
  assert.deepEqual(fs.readdirSync(dir), ['guided-preview.db']);
});

test('the 1,000-row workbook replaces the preview roster without changing the original database', async t => {
  const dir = temp(t), original = path.join(dir, 'guided-preview.db');
  // Seed in another process: the application under test will open ONLY the prepared copy.
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/seed.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: dir, DB_FILE: original, RP_SEED_ROWS: '170' },
  });
  const source = new DatabaseSync(original);
  let file;
  try {
    source.exec(`PRAGMA wal_autocheckpoint = 0;
      UPDATE users SET name='Preview admin' WHERE role='admin';
      INSERT INTO settings(key,value) VALUES ('test','copy this');
      INSERT INTO sessions(token,user_id,expires_at) SELECT 'old-session',id,'2099-12-31' FROM users WHERE role='admin';
      INSERT INTO agent_actions(kind,assignment_id,summary,before_json,after_json)
        SELECT 'update_assignment',id,'Old proposal','{}','{}' FROM assignments LIMIT 1;`);
    // The snapshot must include changes committed in the WAL, not just the .db file.
    const result = prepareWorkbookPreview(dir);
    assert.equal(result.created, true);
    file = result.file;
    assert.equal(source.prepare('SELECT count(*) c FROM employees').get().c, 170);
    assert.ok(source.prepare('SELECT 1 FROM field_overrides').get());
    assert.ok(source.prepare('SELECT 1 FROM group_members').get());
    assert.ok(source.prepare('SELECT 1 FROM duplicate_reviews').get());
    assert.ok(source.prepare('SELECT 1 FROM agent_actions').get());
  } finally { source.close(); }

  process.env.DATA_DIR = dir;
  process.env.DB_FILE = file;
  const { db, q } = require('../server/db');
  const { buildTemplateWorkbook, importWorkbook } = require('../server/excel');
  const count = table => q.get(`SELECT count(*) c FROM ${table}`).c;
  try {
    for (const table of ['employees', 'assignments', 'assignment_values', 'field_overrides', 'group_members', 'agent_actions', 'duplicate_reviews', 'sessions']) {
      assert.equal(count(table), 0, table);
    }
    const admin = require('../server/auth').hydrateUser(q.get("SELECT * FROM users WHERE role='admin'"));
    assert.equal(admin.name, 'Preview admin');
    assert.equal(q.get("SELECT value FROM settings WHERE key='test'").value, 'copy this');
    assert.ok(count('user_projects') && count('category_fields') && count('audit_log'));

    const buffer = fs.readFileSync(path.join(root, 'samples', 'workforce-1000.xlsx'));
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
    const sheet = wb.getWorksheet('Employees');
    const template = (await buildTemplateWorkbook()).getWorksheet('Employees');
    assert.equal(sheet.columnCount, 68);
    assert.deepEqual(sheet.getRow(1).values, template.getRow(1).values);
    assert.equal(sheet.actualRowCount, 1001);
    const ids = sheet.getColumn(sheet.getRow(1).values.indexOf('employee ID')).values.slice(2);
    assert.deepEqual(ids, Array.from({ length: 1000 }, (_, i) => `TEST-${String(i + 1).padStart(4, '0')}`));

    async function checkImport(bytes, dryRun, created, updated) {
      const r = await importWorkbook(admin, bytes, { filename: 'workforce-1000.xlsx', dryRun });
      assert.deepEqual(r.errors, []);
      assert.deepEqual([r.created, r.updated, r.protected, r.flagged], [created, updated, 0, 0]);
    }
    await checkImport(buffer, true, 1000, 1000);
    assert.equal(count('employees'), 0);
    assert.equal(count('imports'), 0);
    await checkImport(buffer, false, 1000, 1000);
    assert.equal(count('employees'), 1000);
    assert.equal(count('assignments'), 1000);
    assert.equal(q.get("SELECT count(*) c FROM employees WHERE emp_code NOT LIKE 'TEST-%'").c, 0);
    assert.deepEqual(q.all('SELECT count(*) c FROM assignments GROUP BY project_id').map(r => r.c), [250, 250, 250, 250]);
    await checkImport(buffer, true, 0, 0);
    const note = sheet.getRow(2).getCell(sheet.getRow(1).values.indexOf('detail comments'));
    assert.equal(note.value, 'Sample note 0001');
    note.value = 'Import check passed';
    await checkImport(await wb.xlsx.writeBuffer(), false, 0, 1);
    assert.equal(q.get(`SELECT v.value FROM assignment_values v JOIN fields f ON f.id=v.field_id
      JOIN assignments a ON a.id=v.assignment_id JOIN employees e ON e.id=a.employee_id
      WHERE f.key='detail_comments' AND e.emp_code='TEST-0001'`).value, note.value);
    assert.equal(prepareWorkbookPreview(dir).created, false);
    assert.equal(count('employees'), 1000);
    assert.equal(count('assignments'), 1000);
  } finally { db.close(); }

  // The documented rollback moves the whole stopped preview folder, not individual WAL files.
  fs.renameSync(path.dirname(file), path.join(dir, 'workbook-preview-saved'));
  const restored = new DatabaseSync(original, { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT count(*) c FROM employees').get().c, 170);
    assert.equal(restored.prepare("SELECT count(*) c FROM employees WHERE emp_code LIKE 'TEST-%'").get().c, 0);
    assert.ok(restored.prepare("SELECT 1 FROM sessions WHERE token='old-session'").get());
  } finally { restored.close(); }
  assert.ok(!fs.existsSync(path.join(dir, 'resource_planning.db')));
});
