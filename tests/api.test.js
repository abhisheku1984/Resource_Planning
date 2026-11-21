'use strict';
/**
 * Integration tests covering the required scenarios (spec section 24).
 *
 * Each test drives the real HTTP API against an isolated temporary database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_FILE = path.join(TMP, 'test.db');
process.env.NODE_ENV = 'test';

const { app } = require('../server/index');
const { q } = require('../server/db');
const seed = require('../server/seed');

let server;
let base;

test.before(async () => {
  // create the schema + demo dataset in the temp database
  seed.run({ reset: false, quiet: true });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */
async function login(email, password = 'Super@12345') {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  const body = await res.json();
  return body.token;
}

function client(token) {
  return async (method, url, body) => {
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, data, headers: res.headers };
  };
}

/* ================================================================== tests */
test('authentication: rejects bad credentials and protects the API', async () => {
  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@resourceplanning.io', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);

  const anon = await fetch(`${base}/api/employees`);
  assert.equal(anon.status, 401);
});

test('scenario 1: one project shared by six supervisors', async () => {
  // Grant six supervisors access to the same project and verify isolation works.
  const admin = await login('admin@resourceplanning.io', 'Admin@12345');
  const adm = client(admin);
  const nexus = q.get('SELECT * FROM projects WHERE code = ?', 'NEXUS');

  const SUPERVISOR_EMAILS = [
    'priya.nair@resourceplanning.io', 'rohit.verma@resourceplanning.io', 'meera.iyer@resourceplanning.io',
    'sameer.khan@resourceplanning.io', 'kavita.rao@resourceplanning.io', 'arun.pillai@resourceplanning.io',
  ];
  const supervisors = SUPERVISOR_EMAILS.map((e) => q.get('SELECT * FROM users WHERE email = ?', e));
  for (const s of supervisors) {
    q.run('INSERT OR IGNORE INTO user_projects (user_id, project_id, can_edit, can_export, can_crm) VALUES (?, ?, 1, 1, 1)', s.id, nexus.id);
  }

  const seen = [];
  for (const s of supervisors) {
    const token = await login(s.email);
    const api = client(token);
    const res = await api('GET', '/employees?projectId=' + nexus.id + '&pageSize=5');
    assert.equal(res.status, 200);
    assert.equal(res.data.total, Number(q.get('SELECT COUNT(*) c FROM assignments WHERE project_id = ? AND active = 1', nexus.id).c));
    seen.push(res.data.total);
  }
  assert.equal(new Set(seen).size, 1, 'all six supervisors must see the same record count for the shared project');
  assert.ok(seen[0] > 0);

  // revoke Nexus from the Vertex-only supervisor and verify the backend refuses
  const outsider = q.get('SELECT * FROM users WHERE email = ?', 'arun.pillai@resourceplanning.io');
  q.run('DELETE FROM user_projects WHERE user_id = ? AND project_id = ?', outsider.id, nexus.id);
  const outApi = client(await login('arun.pillai@resourceplanning.io'));
  const denied = await outApi('GET', '/employees?projectId=' + nexus.id);
  assert.equal(denied.status, 403, 'unauthorized project access must be refused by the backend');
  void adm;
});

test('scenario 2: one supervisor assigned to multiple projects', async () => {
  const token = await login('sameer.khan@resourceplanning.io');
  const api = client(token);
  const boot = await api('GET', '/bootstrap');
  assert.ok(boot.data.tree.length >= 3, 'multi-project supervisor should see 3+ projects');
  const ids = boot.data.tree.map((p) => p.id);
  for (const id of ids) {
    const res = await api('GET', `/employees?projectId=${id}&pageSize=1`);
    assert.equal(res.status, 200, `project ${id} should be accessible`);
  }
  // and the unfiltered view spans all of their projects
  const all = await api('GET', '/employees?pageSize=1');
  const expected = Number(q.get(
    `SELECT COUNT(*) c FROM assignments WHERE active = 1 AND project_id IN (${ids.map(() => '?').join(',')})`,
    ...ids
  ).c);
  assert.equal(all.data.total, expected);
});

test('scenario 3 + 4: different categories expose different dynamic columns', async () => {
  const token = await login('priya.nair@resourceplanning.io');
  const api = client(token);

  const training = q.get("SELECT * FROM categories WHERE name = 'Training Cohort' LIMIT 1");
  const billing = q.get("SELECT * FROM categories WHERE name = 'Billing & Allocation' LIMIT 1");
  const delivery = q.get("SELECT * FROM categories WHERE name = 'Delivery Status' LIMIT 1");

  const tCols = (await api('GET', `/employees?categoryId=${training.id}`)).data.columns.map((c) => c.key);
  const bCols = (await api('GET', `/employees?categoryId=${billing.id}`)).data.columns.map((c) => c.key);
  const dCols = (await api('GET', `/employees?categoryId=${delivery.id}`)).data.columns.map((c) => c.key);

  assert.ok(tCols.includes('training_status') && tCols.includes('completion_status') && tCols.includes('joining_date'));
  assert.ok(!tCols.includes('billing_status'));
  assert.ok(bCols.includes('billing_status') && bCols.includes('allocation_status') && bCols.includes('effective_date'));
  assert.ok(!bCols.includes('training_status'));
  assert.notDeepEqual(tCols, bCols);
  assert.ok(dCols.includes('status'));

  // editability is per category
  const tDetail = await api('GET', `/categories/${training.id}/columns`);
  const empCode = tDetail.data.fields.find((f) => f.key === 'emp_code');
  assert.equal(empCode.editable, false, 'employee code is read-only in the training layout');
});

test('scenario 5: two supervisors editing the same employee (conflict detection)', async () => {
  const tokenA = await login('priya.nair@resourceplanning.io');
  const tokenB = await login('sameer.khan@resourceplanning.io');
  const a = client(tokenA);
  const b = client(tokenB);

  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const row = (await a('GET', `/employees?projectId=${nexus.id}&pageSize=1`)).data.rows[0];

  // A saves with the current revision
  const first = await a('PATCH', `/employees/${row.assignmentId}`, { changes: { remarks: 'Edited by Priya' }, rev: row.rev });
  assert.equal(first.status, 200);
  assert.equal(first.data.record.values.remarks, 'Edited by Priya');

  // B is still holding the stale revision
  const stale = await b('PATCH', `/employees/${row.assignmentId}`, { changes: { remarks: 'Edited by Sameer' }, rev: row.rev });
  assert.equal(stale.status, 409, 'stale writes must be rejected, not silently applied');
  assert.equal(stale.data.code, 'STALE');
  assert.equal(stale.data.current.values.remarks, 'Edited by Priya');

  // B retries against the fresh revision and succeeds
  const retry = await b('PATCH', `/employees/${row.assignmentId}`, {
    changes: { remarks: 'Edited by Sameer' },
    rev: stale.data.current.updatedAt,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.record.values.remarks, 'Edited by Sameer');

  // both edits are preserved in the audit history
  const history = await a('GET', `/employees/${row.assignmentId}/history`);
  const changes = history.data.history.filter((h) => h.field_key === 'remarks');
  assert.ok(changes.length >= 2, 'audit history must keep every previous value');
  assert.ok(changes.some((c) => c.new_value === 'Edited by Priya'));
  assert.ok(changes.some((c) => c.new_value === 'Edited by Sameer'));
});

test('scenario 6 + 9: CRM autosave persists and surfaces in the employee table', async () => {
  const token = await login('priya.nair@resourceplanning.io');
  const api = client(token);
  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const category = q.get("SELECT c.* FROM categories c JOIN subprojects s ON s.id = c.subproject_id WHERE s.project_id = ? AND c.name = 'Training Cohort' LIMIT 1", nexus.id);
  const row = (await api('GET', `/employees?categoryId=${category.id}&pageSize=1`)).data.rows[0];

  // simulated CRM autosave: several fields in one transaction
  const saved = await api('PATCH', `/employees/${row.assignmentId}`, {
    changes: { phone: '+91 90000 12345', training_status: 'Completed', remarks: 'CRM autosave check' },
    rev: row.rev,
    reason: 'CRM autosave',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.record.values.training_status, 'Completed');

  // the employee table immediately reflects the new values
  const table = await api('GET', `/employees?categoryId=${category.id}&search=CRM autosave check`);
  assert.equal(table.data.total, 1);
  assert.equal(table.data.rows[0].values.training_status, 'Completed');
  assert.equal(table.data.rows[0].updatedBy, 'Priya Nair');

  // the contact change is stored on the person record
  const person = await api('GET', `/employees/${row.assignmentId}`);
  assert.equal(person.data.record.values.phone, '+91 90000 12345');
});

test('scenario 7: updating an existing employee never creates a duplicate', async () => {
  const token = await login('priya.nair@resourceplanning.io');
  const api = client(token);
  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const sub = q.get('SELECT * FROM subprojects WHERE project_id = ? LIMIT 1', nexus.id);
  const cats = q.all('SELECT * FROM categories WHERE subproject_id = ?', sub.id);
  const existing = q.get('SELECT * FROM employees ORDER BY id LIMIT 1');
  const before = Number(q.get('SELECT COUNT(*) c FROM employees').c);

  // same employee ID, new category -> link, not copy
  const res = await api('POST', '/employees', {
    emp_code: existing.emp_code,
    name: existing.name,
    project_id: nexus.id,
    subproject_id: sub.id,
    category_id: cats[cats.length - 1].id,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.created, false, 'existing employee must be reused');
  assert.equal(Number(q.get('SELECT COUNT(*) c FROM employees').c), before, 'employee count must not change');

  const placements = q.all('SELECT * FROM assignments WHERE employee_id = ? AND active = 1', existing.id);
  assert.ok(placements.length >= 2, 'the person now has two placements');
});

test('scenario 8: adding a new employee with validation', async () => {
  const token = await login('priya.nair@resourceplanning.io');
  const api = client(token);
  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const sub = q.get('SELECT * FROM subprojects WHERE project_id = ? LIMIT 1', nexus.id);
  const cat = q.get('SELECT * FROM categories WHERE subproject_id = ? LIMIT 1', sub.id);

  // upsert of a brand new person
  const created = await api('POST', '/employees', {
    emp_code: 'EMP-99901',
    name: 'Test Person One',
    email: 'test.person.one@example.com',
    phone: '+91 98888 77777',
    project_id: nexus.id,
    subproject_id: sub.id,
    category_id: cat.id,
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.created, true);
  assert.equal(created.data.record.values.emp_code, 'EMP-99901');

  // required fields are enforced
  const invalid = await api('POST', '/employees', { emp_code: '', name: '', project_id: nexus.id });
  assert.equal(invalid.status, 422);

  // invalid field values are rejected with a message
  const badEmail = await api('PATCH', `/employees/${created.data.assignmentId}`, { changes: { email: 'not-an-email' } });
  assert.equal(badEmail.status, 422);
  assert.match(Object.values(badEmail.data.errors)[0], /valid email/i);

  // the row is immediately searchable
  const search = await api('GET', '/employees?search=EMP-99901');
  assert.equal(search.data.total, 1);
});

test('duplicate prevention: uncertain matches go to the review queue instead of being merged', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const sub = q.get('SELECT * FROM subprojects WHERE project_id = ? LIMIT 1', nexus.id);
  const cat = q.get('SELECT * FROM categories WHERE subproject_id = ? LIMIT 1', sub.id);
  const person = q.get('SELECT * FROM employees ORDER BY id DESC LIMIT 1');

  // same email + name but a different employee id -> ambiguous
  const res = await admin('POST', '/employees', {
    emp_code: 'EMP-88801',
    name: person.name,
    email: person.email,
    project_id: nexus.id,
    subproject_id: sub.id,
    category_id: cat.id,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.needsReview, true, 'an ambiguous match must be queued for admin review');

  const queue = await admin('GET', '/duplicates?status=pending');
  assert.ok(queue.data.reviews.some((r) => r.emp_code === 'EMP-88801'));

  const review = queue.data.reviews.find((r) => r.emp_code === 'EMP-88801');
  const resolved = await admin('POST', `/duplicates/${review.id}/resolve`, { action: 'link' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.action, 'link');

  // supervisors cannot see the admin queue
  const sup = client(await login('priya.nair@resourceplanning.io'));
  const denied = await sup('GET', '/duplicates');
  assert.equal(denied.status, 403);
});

test('scenario 10 + 11: exports contain fresh data and imports preserve supervisor edits', async () => {
  const token = await login('priya.nair@resourceplanning.io');
  const api = client(token);
  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const cat = q.get("SELECT c.* FROM categories c JOIN subprojects s ON s.id = c.subproject_id WHERE s.project_id = ? AND c.name = 'Training Cohort' LIMIT 1", nexus.id);
  const row = (await api('GET', `/employees?categoryId=${cat.id}&pageSize=1`)).data.rows[0];

  // supervisor makes a manual edit -> the field becomes protected
  const marker = `supervisor-edit-${Date.now()}`;
  const saved = await api('PATCH', `/employees/${row.assignmentId}`, {
    changes: { remarks: marker, training_status: 'Failed' },
    rev: row.rev,
  });
  assert.equal(saved.status, 200);

  const locked = q.all('SELECT * FROM field_overrides WHERE assignment_id = ? AND locked = 1', row.assignmentId);
  assert.ok(locked.length >= 1, 'manual edits must be recorded as protected fields');

  // ---- export contains the fresh value ----
  const exp = await fetch(`${base}/api/export?projectId=${nexus.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(exp.status, 200);
  const buf = Buffer.from(await exp.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.getWorksheet('Employees');
  assert.ok(sheet.rowCount > 1);
  const headers = [];
  sheet.getRow(1).eachCell((c, i) => headers[i] = String(c.value));
  const remarksCol = headers.indexOf('Remarks');
  const idCol = headers.indexOf('Employee ID');
  assert.ok(remarksCol > 0 && idCol > 0, 'export must contain the identity and remarks columns');
  let found = false;
  sheet.eachRow((r, i) => {
    if (i === 1) return;
    // an employee can hold several assignments; the edited one carries the marker
    if (String(r.getCell(idCol).value) === row.values.emp_code) {
      found = found || String(r.getCell(remarksCol).value) === marker;
    }
  });
  assert.ok(found, 'the consolidated export must include the latest saved value');

  // ---- import the same workbook back with changed training status ----
  const impWb = new ExcelJS.Workbook();
  await impWb.xlsx.load(buf);
  const impSheet = impWb.getWorksheet('Employees');
  const hdrs = [];
  impSheet.getRow(1).eachCell((c, i) => hdrs[i] = String(c.value));
  const trainCol = hdrs.indexOf('Training Status');
  impSheet.eachRow((r, i) => {
    if (i === 1) return;
    if (String(r.getCell(hdrs.indexOf('Employee ID')).value) === row.values.emp_code) {
      r.getCell(trainCol).value = 'Completed';      // would overwrite a protected field
      r.getCell(hdrs.indexOf('Remarks')).value = marker; // unchanged
    }
  });
  const outBuf = await impWb.xlsx.writeBuffer();

  // the import capability belongs to a supervisor role; sameer.khan has it
  const importer = client(await login('sameer.khan@resourceplanning.io'));
  const importResult = await importer('POST', '/import', {
    filename: 'daily.xlsx',
    content: Buffer.from(outBuf).toString('base64'),
  });
  assert.equal(importResult.status, 200);
  assert.ok(importResult.data.result.protected >= 1, 'protected fields must be reported, not overwritten');

  const after = await importer('GET', `/employees/${row.assignmentId}`);
  assert.equal(after.data.record.values.training_status, 'Failed', 'supervisor edit must survive a daily upload');
  assert.equal(after.data.record.values.remarks, marker);

  // no duplicate employees were created by the import
  const dupes = q.all('SELECT emp_code, COUNT(*) c FROM employees GROUP BY emp_code HAVING c > 1');
  assert.equal(dupes.length, 0, 'imports must never duplicate employees');
});

test('scenario 12: unauthorized access to another project\'s employees is blocked', async () => {
  const token = await login('arun.pillai@resourceplanning.io'); // Vertex only
  const api = client(token);
  const nexus = q.get("SELECT * FROM projects WHERE code = 'NEXUS'");
  const nexusSub = q.get('SELECT * FROM subprojects WHERE project_id = ? LIMIT 1', nexus.id);
  const nexusCat = q.get('SELECT * FROM categories WHERE subproject_id = ? LIMIT 1', nexusSub.id);
  const foreignRow = q.get('SELECT * FROM assignments WHERE project_id = ? LIMIT 1', nexus.id);

  assert.equal((await api('GET', `/employees?projectId=${nexus.id}`)).status, 403);
  assert.equal((await api('GET', `/employees?subprojectId=${nexusSub.id}`)).status, 403);
  assert.equal((await api('GET', `/employees?categoryId=${nexusCat.id}`)).status, 403);
  assert.equal((await api('GET', `/employees/${foreignRow.id}`)).status, 403);
  assert.equal((await api('PATCH', `/employees/${foreignRow.id}`, { changes: { remarks: 'hack' } })).status, 403);

  // exports are scoped too
  const exp = await api('GET', `/export?projectId=${nexus.id}`);
  assert.equal(exp.status, 403);

  // and the unfiltered list only ever contains their own project
  const listed = await api('GET', '/employees?pageSize=200');
  const projectIds = new Set(listed.data.rows.map((r) => r.projectId));
  for (const id of projectIds) {
    const vtx = q.get("SELECT id FROM projects WHERE code = 'VERTEX'").id;
    assert.equal(id, vtx, 'a supervisor must never see another project\'s rows');
  }
});

test('read-only supervisors cannot edit or use CRM writes', async () => {
  const token = await login('kavita.rao@resourceplanning.io');
  const api = client(token);
  const boot = await api('GET', '/bootstrap');
  assert.equal(boot.data.user.projects[0].can_edit, 0);

  const row = (await api('GET', '/employees?pageSize=1')).data.rows[0];
  const denied = await api('PATCH', `/employees/${row.assignmentId}`, { changes: { remarks: 'nope' } });
  assert.equal(denied.status, 403);

  const create = await api('POST', '/employees', { emp_code: 'X1', name: 'Nope', project_id: 1, subproject_id: 1, category_id: 1 });
  assert.equal(create.status, 403);
});

test('project-wide import is refused without the import capability', async () => {
  const token = await login('priya.nair@resourceplanning.io');
  const api = client(token);
  const res = await api('POST', '/import', { filename: 'x.xlsx', content: '' });
  assert.equal(res.status, 403);
});

test('admin-only configuration endpoints are protected', async () => {
  const sup = client(await login('sameer.khan@resourceplanning.io'));
  assert.equal((await sup('POST', '/projects', { code: 'X', name: 'X' })).status, 403);
  assert.equal((await sup('POST', '/fields', { key: 'x', label: 'X' })).status, 403);
  assert.equal((await sup('GET', '/users')).status, 403);
  const cat = q.get('SELECT * FROM categories LIMIT 1');
  assert.equal((await sup('PUT', `/categories/${cat.id}/columns`, { fields: [] })).status, 403);
});

test('per-category column configuration round-trips and validates required fields', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const cat = q.get("SELECT * FROM categories WHERE name = 'Delivery Status' LIMIT 1");
  const detail = await admin('GET', `/categories/${cat.id}/columns`);
  assert.equal(detail.status, 200);

  const remark = detail.data.fields.find((f) => f.key === 'remarks');
  const payload = detail.data.fields.map((f) => ({
    field_id: f.id,
    visible: f.key === 'remarks' ? false : f.visible,
    editable: f.editable,
    required: f.required,
  }));
  const put = await admin('PUT', `/categories/${cat.id}/columns`, { fields: payload });
  assert.equal(put.status, 200);

  // the hidden column disappears from the table for supervisors
  const sup = client(await login('priya.nair@resourceplanning.io'));
  const cols = (await sup('GET', `/employees?categoryId=${cat.id}`)).data.columns.map((c) => c.key);
  assert.ok(!cols.includes('remarks'), 'hidden columns must not be returned at all');
  assert.ok(cols.includes(remark.key) === false);
});

test('server-side sort, search, filter and pagination', async () => {
  const api = client(await login('admin@resourceplanning.io', 'Admin@12345'));

  const p1 = await api('GET', '/employees?page=1&pageSize=5&sort=name&dir=asc');
  const p2 = await api('GET', '/employees?page=2&pageSize=5&sort=name&dir=asc');
  assert.equal(p1.data.rows.length, 5);
  assert.equal(new Set([...p1.data.rows, ...p2.data.rows].map((r) => r.assignmentId)).size, 10);
  assert.ok(p1.data.totalPages > 1);

  const desc = await api('GET', '/employees?pageSize=5&sort=name&dir=desc');
  assert.notEqual(desc.data.rows[0].values.name, p1.data.rows[0].values.name);

  // assignment status is a mapped column, filtered with the f_ prefix
  const st = p1.data.rows[0].values.status;
  const filtered = await api('GET', `/employees?pageSize=100&f_status=${encodeURIComponent(st)}`);
  assert.ok(filtered.data.total >= 1);
  assert.ok(filtered.data.rows.every((r) => r.values.status === st));

  const searched = await api('GET', `/employees?search=${encodeURIComponent('EMP-01001')}&pageSize=100`);
  assert.ok(searched.data.total >= 1);
});

test('concurrent updates never corrupt the database (transactional writes)', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const rows = (await admin('GET', '/employees?pageSize=40')).data.rows;

  const results = await Promise.all(rows.map((r, i) =>
    admin('PATCH', `/employees/${r.assignmentId}`, {
      changes: { remarks: `parallel-${i}` },
      rev: r.rev,
    })));

  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, rows.length, 'parallel writes to distinct rows must all succeed');

  const verify = await admin('GET', '/employees?pageSize=40');
  for (const r of verify.data.rows) {
    if (String(r.values.remarks || '').startsWith('parallel-')) {
      assert.match(r.values.remarks, /^parallel-\d+$/);
    }
  }
});

/* ------------------------------------------------------------------ 12k scale */
test('bench category facets and facet filtering work on the full column set', async () => {
  const api = client(await login('priya.nair@resourceplanning.io'));
  const first = await api('GET', '/employees?pageSize=1');
  const projectId = first.data.rows[0].projectId;

  const res = await api('GET', `/employees?projectId=${projectId}&pageSize=5`);
  assert.ok(res.data.facets.length >= 5, 'facets are returned with the page');
  const bench = res.data.facets.find((f) => f.key === 'bench_category');
  assert.ok(bench && bench.values.length >= 3);
  assert.ok(bench.values.every((v) => typeof v.count === 'number'));

  const value = bench.values[0].value;
  const scoped = await api('GET', `/employees?projectId=${projectId}&pageSize=200&f_bench_category=${encodeURIComponent(value)}`);
  assert.equal(scoped.data.total, bench.values[0].count);
  assert.ok(scoped.data.rows.every((r) => r.values.bench_category === value));
});

test('every category exposes the full supervisor submit field set', async () => {
  const api = client(await login('priya.nair@resourceplanning.io'));
  const row = (await api('GET', '/employees?pageSize=1')).data.rows[0];
  const rec = await api('GET', `/employees/${row.assignmentId}`);
  const keys = rec.data.record.columns.filter((c) => c.submitField).map((c) => c.key);
  for (const k of ['allocation_plan', 'pid', 'opid', 'project_role', 'eta_available',
    'follow_up_notes', 'critical_flag', 'risk_flag', 'bench_category',
    'allocation_status', 'allocation_percentage', 'allocation_start_date']) {
    assert.ok(keys.includes(k), `submit field ${k} must be configurable`);
  }
});

test('supervisor submit writes every changed field in one transaction', async () => {
  const api = client(await login('priya.nair@resourceplanning.io'));
  const row = (await api('GET', '/employees?pageSize=1')).data.rows[0];
  const before = (await api('GET', `/employees/${row.assignmentId}`)).data.record;

  const res = await api('POST', `/employees/${row.assignmentId}/submit`, {
    changes: { pid: 'PID-4242', opid: 'OPID-77', eta_available: '2026-12-15', risk_flag: 'High' },
    rev: before.rev,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.changed.sort(), ['eta_available', 'opid', 'pid', 'risk_flag']);
  assert.equal(res.data.record.values.pid, 'PID-4242');

  // the saved values are what the table and the export read
  const after = (await api('GET', `/employees/${row.assignmentId}`)).data.record;
  assert.equal(after.values.opid, 'OPID-77');

  // a submit against the old revision is rejected instead of silently clobbering
  const stale = await api('POST', `/employees/${row.assignmentId}/submit`, {
    changes: { pid: 'PID-0000' }, rev: before.rev,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'STALE');
  assert.ok(stale.data.current, 'the latest record is returned for review');
});

test('access control on submit: read-only grants and other projects are refused', async () => {
  const viewer = client(await login('kavita.rao@resourceplanning.io'));
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const row = (await admin('GET', '/employees?pageSize=1')).data.rows[0];

  const readOnly = await viewer('POST', `/employees/${row.assignmentId}/submit`, { changes: { pid: 'X' } });
  assert.equal(readOnly.status, 403);

  const intruder = client(await login('arun.pillai@resourceplanning.io'));
  const foreign = await intruder('GET', `/employees/${row.assignmentId}`);
  assert.equal(foreign.status, 403);
  const foreignSubmit = await intruder('POST', `/employees/${row.assignmentId}/submit`, { changes: { pid: 'X' } });
  assert.equal(foreignSubmit.status, 403);
});

/* ------------------------------------------------- assistant (§25) */
const agent = require('../server/agent');

test('assistant answers counts from the database and scopes them to the user', async () => {
  const priya = { id: 1, name: 'Priya', isAdmin: false, projects: [{ id: q.get("SELECT id FROM projects WHERE code='NEXUS'").id }] };
  const nexus = q.get("SELECT id FROM projects WHERE code='NEXUS'");
  const bench = q.get("SELECT id FROM fields WHERE key='bench_category'");

  const expected = q.get(
    `SELECT COUNT(*) c FROM assignment_values v JOIN assignments a ON a.id = v.assignment_id
      WHERE a.active = 1 AND a.project_id = ? AND v.field_id = ? AND v.value = 'Bench'`,
    nexus.id, bench.id
  ).c;

  const plan = agent.understand(priya, 'how many people are on bench in nexus?');
  assert.equal(plan.kind, 'count');
  assert.equal(plan.data.count, expected, 'the assistant must report the real count, not a guess');
  assert.match(plan.reply, new RegExp(String(expected)));
});

test('assistant refuses to report on a project the user cannot see', () => {
  const priya = { id: 1, name: 'Priya', isAdmin: false, projects: [{ id: q.get("SELECT id FROM projects WHERE code='NEXUS'").id }] };
  const plan = agent.understand(priya, 'how many are on bench in ATLAS');
  assert.equal(plan.kind, 'denied');
  assert.match(plan.reply, /do not have access/i);
  assert.ok(!plan.data, 'no numbers are returned for an unauthorized project');
});

test('assistant never writes: it only raises a proposal an admin must approve', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const sup = client(await login('priya.nair@resourceplanning.io'));
  const row = (await sup('GET', '/employees?pageSize=1')).data.rows[0];
  const field = q.get("SELECT id FROM fields WHERE key='block_status'");
  const before = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', row.assignmentId, field.id);

  const res = await sup('POST', '/agent/ask', { message: `set ${row.values.emp_code} to hard block` });
  assert.equal(res.status, 200);
  assert.ok(res.data.proposal, 'a change request becomes a proposal');
  assert.equal(res.data.proposal.status, 'pending');

  // the record is untouched until approval
  const still = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', row.assignmentId, field.id);
  assert.equal(still?.value ?? null, before?.value ?? null, 'nothing is written before approval');

  // a supervisor cannot approve their own proposal
  const selfApprove = await sup('POST', `/agent/proposals/${res.data.proposal.id}/approve`, {});
  assert.equal(selfApprove.status, 403);

  // the administrator can
  const approved = await admin('POST', `/agent/proposals/${res.data.proposal.id}/approve`, {});
  assert.equal(approved.status, 200);
  const after = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', row.assignmentId, field.id);
  assert.equal(after.value, 'Hard Block');

  // and the approval is attributed in the audit trail
  const auditRow = q.get("SELECT * FROM audit_log WHERE action = 'agent_approve' ORDER BY id DESC LIMIT 1");
  assert.equal(auditRow.actor_name, 'Ananya Deshmukh');
  assert.match(auditRow.meta, /Priya Nair/);
});
