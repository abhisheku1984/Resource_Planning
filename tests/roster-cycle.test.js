'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-daily-'));
process.env.DATA_DIR = dir; process.env.DB_FILE = path.join(dir, 'cycle.db');
const { app } = require('../server/index');
const { db, q } = require('../server/db');
let server, url;
const restorePoint = path.join(dir, 'roster-backups', 'cycle.db.before-last-replace.db');
const counts = conn => conn.prepare('SELECT (SELECT COUNT(*) FROM employees) people, (SELECT COUNT(*) FROM assignments) placements').get();
const roster = conn => Object.values(counts(conn));

async function call(token, route, body) {
  return fetch(url + '/api' + route, { method: body ? 'POST' : 'GET', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: body && JSON.stringify(body) });
}
async function login(email, password) {
  const res = await call(null, '/auth/login', { email, password });
  assert.equal(res.status, 200); return (await res.json()).token;
}
async function fullExport(admin, expected) {
  const res = await call(admin, '/export?forReplacement=1');
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.equal(wb.getWorksheet('Employees').actualRowCount - 1, expected);
  assert.ok(res.headers.get('X-Roster-Receipt')); return res.headers.get('X-Roster-Receipt');
}
async function workbook(ids, options = {}) {
  const wb = new ExcelJS.Workbook(), sh = wb.addWorksheet('Employees');
  const columns = ['Project', 'Subproject', 'Category', 'Employee ID', 'First Name', 'Last Name', options.noteHeader || 'Detail Comments'];
  sh.addRow(columns);
  for (const id of ids) sh.addRow(['Nexus Digital Transformation', 'Core Banking Migration', options.category || 'Delivery Status', id, 'Test', String(id), options.note || 'Daily note']);
  return (await wb.xlsx.writeBuffer()).toString('base64');
}

test.before(async () => {
  require('../server/seed').run({ quiet: true });
  q.run(`INSERT INTO agent_actions(kind,assignment_id,summary,before_json,after_json)
    SELECT 'update_assignment',id,'Old proposal','{}','{}' FROM assignments LIMIT 1`);
  server = app.listen(0, '127.0.0.1'); await new Promise(ok => server.once('listening', ok));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(ok => server.close(ok)); db.close(); fs.rmSync(dir, { recursive:true, force:true }); });

test('export → preview → delete and import is admin-only, all-or-nothing and repeatable on the next day', async () => {
  const admin = await login('admin@resourceplanning.io', 'Admin@12345');
  const uploader = await login('sameer.khan@resourceplanning.io', 'Super@12345');
  const before = roster(db), oldId = q.get('SELECT id FROM assignments ORDER BY id LIMIT 1').id;
  const config = () => ['users','user_projects','user_subprojects','user_capabilities','projects','subprojects','categories','fields','category_fields','suppliers'].map(t => q.get(`SELECT COUNT(*) c FROM ${t}`).c);
  const originalConfig = config();
  const replace = (token, body) => call(token, '/import/replace', body);
  const next = await workbook(['DAY-A','DAY-B','DAY-C']);
  const base = { filename: 'daily.xlsx', content: next };
  assert.equal((await replace(null, base)).status, 401);
  assert.equal((await replace(uploader, base)).status, 403);
  assert.equal((await call(uploader, '/export?forReplacement=1')).status, 403);
  assert.equal((await call(admin, '/export?forReplacement=1&projectId=1')).status, 422);
  assert.equal((await replace(admin, { ...base, dryRun: true })).status, 409);
  const receipt = await fullExport(admin, before[1]);
  const opts = { ...base, receipt };
  const apply = { ...opts, confirmation: 'REPLACE' };
  assert.equal((await replace(admin, apply)).status, 409, 'server requires a clean preview, not just a confirmation string');
  for (const content of [await workbook([]), await workbook(['A', 'A']), await workbook(['OK','']), await workbook(['A'], {category:'unknown'}), await workbook(['A'], {noteHeader:'Mistyped column'})]) {
    const rep = (await (await replace(admin, { ...opts, content, dryRun: true })).json()).result;
    assert.equal(rep.canReplace, false); assert.ok(rep.errors.length);
    assert.equal((await replace(admin, { ...apply, content })).status, 409);
    assert.deepEqual(roster(db), before);
  }
  assert.equal((await replace(admin, { ...opts, content: 'not-a-workbook', dryRun: true })).status, 422);
  assert.equal(fs.existsSync(restorePoint), false, 'no new backup or live changes just for a preview');
  const first = (await (await replace(admin, { ...opts, dryRun: true })).json()).result;
  assert.ok(first.canReplace); assert.equal(first.after.people, 3); assert.equal(first.before.people, before[0]);
  assert.deepEqual(roster(db), before); assert.ok(q.get('SELECT 1 FROM field_overrides'));
  assert.equal((await replace(admin, { ...opts, confirmation: 'yes' })).status, 409);
  assert.equal((await replace(admin, { ...apply, content: await workbook(['DIFFERENT']) })).status, 409);
  assert.equal((await replace(admin, { ...apply, projectId: 1, subprojectId: 1, categoryId: 1 })).status, 409);
  // A concurrent committed edit invalidates the export, even at the same headcount.
  const e = q.get('SELECT id, name FROM employees LIMIT 1');
  q.run("UPDATE employees SET name='Renamed' WHERE id=?", e.id);
  require('../server/audit').record({ entity:'employee',entityId:e.id,action:'update',fieldKey:'name',oldValue:e.name,newValue:'Renamed' });
  assert.equal((await replace(admin, apply)).status, 409); assert.deepEqual(roster(db), before);
  opts.receipt = await fullExport(admin, before[1]);
  assert.equal((await (await replace(admin, { ...opts, dryRun: true })).json()).result.canReplace, true);
  // Simulate backup failure: fail closed before deleting the first record.
  fs.mkdirSync(path.dirname(restorePoint)); fs.mkdirSync(restorePoint);
  assert.equal((await replace(admin, { ...opts, confirmation:'REPLACE' })).status, 503);
  assert.deepEqual(roster(db), before); fs.rmdirSync(restorePoint);
  // A write error AFTER the clean preview must roll back the clear and all good rows too.
  db.exec(`CREATE TRIGGER fail_one BEFORE INSERT ON employees WHEN new.emp_code='DAY-B'
           BEGIN SELECT RAISE(ABORT, 'test row failure'); END;`);
  assert.equal((await replace(admin, { ...opts, confirmation:'REPLACE' })).status, 422);
  assert.deepEqual(roster(db), before); assert.ok(q.get('SELECT 1 FROM field_overrides'));
  assert.equal(q.get('SELECT status FROM agent_actions LIMIT 1').status, 'pending');
  db.exec('DROP TRIGGER fail_one');
  const result = await replace(admin, { ...opts, confirmation:'REPLACE' });
  assert.equal(result.status, 200); assert.deepEqual(roster(db), [3,3]); assert.deepEqual(config(), originalConfig);
  assert.equal(q.get('SELECT 1 FROM assignments WHERE id=?', oldId), undefined);
  assert.equal(q.get('SELECT 1 FROM field_overrides'), undefined);
  assert.equal(q.get('SELECT 1 FROM group_members'), undefined);
  assert.equal(q.get('SELECT status FROM agent_actions LIMIT 1').status, 'stale');
  const review = q.get('SELECT id,status FROM duplicate_reviews LIMIT 1'); assert.equal(review.status, 'dismissed');
  assert.equal((await call(admin, `/duplicates/${review.id}/resolve`, {action:'create'})).status, 409);
  assert.equal((await replace(admin, { ...opts, confirmation:'REPLACE' })).status, 409);
  const checkBackup = expected => { const snap = new DatabaseSync(restorePoint, {readOnly:true});try { assert.deepEqual(roster(snap), expected); } finally {snap.close();} };
  checkBackup(before);
  const daily = { filename:'day-two.xlsx', content:await workbook(['DAY-C','DAY-D'], {note:'New dump'}), receipt:await fullExport(admin, 3) };
  assert.ok((await (await replace(admin, {...daily, dryRun:true})).json()).result.canReplace);
  assert.equal((await replace(admin, { ...daily, confirmation:'REPLACE' })).status, 200);
  assert.deepEqual(roster(db), [2,2]); checkBackup([3,3]);
  assert.deepEqual(q.all('SELECT emp_code FROM employees ORDER BY emp_code').map(e=>e.emp_code), ['DAY-C','DAY-D']);
  assert.equal(q.get("SELECT COUNT(*) c FROM audit_log WHERE action='replace'").c, 2);
  assert.equal(q.get('SELECT COUNT(*) c FROM imports').c, 2);
  assert.equal((await call(admin, '/dashboard?summaryOnly=1')).status, 200, 'admin session survives both cycles');
});
