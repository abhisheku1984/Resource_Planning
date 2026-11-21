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
const fielddefs = require('../server/fielddefs');

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

  // the catalogue is now the real HR workbook, so the layouts name its columns
  assert.ok(tCols.includes('service_status') && tCols.includes('doj') && tCols.includes('capability'));
  // submit fields are resolvable in every category by design, so compare on a
  // column that is neither a facet nor a supervisor field
  assert.ok(!tCols.includes('bench_subcategory'));
  assert.ok(bCols.includes('billing_status') && bCols.includes('build_status') && bCols.includes('billing_start_date'));
  // The BC-BS update columns resolve in every category by design (the leader
  // form must always render), so compare on a column that is neither shown, a
  // facet, nor an update field.
  assert.ok(!bCols.includes('bench_subcategory'));
  assert.ok(!bCols.includes('manager_name'));
  assert.notDeepEqual(tCols, bCols);
  assert.ok(dCols.includes('status'));
  assert.ok(dCols.includes('block_status'), 'Delivery Status tracks hard/soft block');

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
    changes: { phone: '+91 90000 12345', service_status: 'Support', remarks: 'CRM autosave check' },
    rev: row.rev,
    reason: 'CRM autosave',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.record.values.service_status, 'Support');

  // the employee table immediately reflects the new values
  const table = await api('GET', `/employees?categoryId=${category.id}&search=CRM autosave check`);
  assert.equal(table.data.total, 1);
  assert.equal(table.data.rows[0].values.service_status, 'Support');
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
    changes: { remarks: marker, service_status: 'Support' },
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
  const trainCol = hdrs.indexOf('Service Status');
  impSheet.eachRow((r, i) => {
    if (i === 1) return;
    if (String(r.getCell(hdrs.indexOf('Employee ID')).value) === row.values.emp_code) {
      r.getCell(trainCol).value = 'Maternity';      // would overwrite a protected field
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
  assert.equal(after.data.record.values.service_status, 'Support', 'supervisor edit must survive a daily upload');
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
  const original = detail.data.fields;
  const toPayload = (f, visible) => ({
    field_id: f.id,
    visible,
    editable: f.editable,
    required: f.required,
    filterable: !!f.filterable,
    submit_field: !!f.submit_field,
    sort_order: f.sort_order,
  });
  const payload = original.map((f) => toPayload(f, f.key === 'remarks' ? false : f.visible));
  const put = await admin('PUT', `/categories/${cat.id}/columns`, { fields: payload });
  assert.equal(put.status, 200);

  try {
    // the hidden column disappears from the table for supervisors
    const sup = client(await login('priya.nair@resourceplanning.io'));
    const cols = (await sup('GET', `/employees?categoryId=${cat.id}`)).data.columns.map((c) => c.key);
    assert.ok(!cols.includes('remarks'), 'hidden columns must not be returned at all');
  } finally {
    // PUT replaces the whole layout, so restore it. Later tests read this
    // category and must not inherit a half-configured column set.
    await admin('PUT', `/categories/${cat.id}/columns`, {
      fields: original.map((f) => toPayload(f, f.visible)),
    });
  }
});

test('server-side sort, search, filter and pagination', async () => {
  const api = client(await login('admin@resourceplanning.io', 'Admin@12345'));

  const p1 = await api('GET', '/employees?page=1&pageSize=5&sort=emp_code&dir=asc');
  const p2 = await api('GET', '/employees?page=2&pageSize=5&sort=emp_code&dir=asc');
  assert.equal(p1.data.rows.length, 5);
  assert.equal(new Set([...p1.data.rows, ...p2.data.rows].map((r) => r.assignmentId)).size, 10);
  assert.ok(p1.data.totalPages > 1);

  const desc = await api('GET', '/employees?pageSize=5&sort=emp_code&dir=desc');
  assert.notEqual(desc.data.rows[0].values.emp_code, p1.data.rows[0].values.emp_code);

  // assignment status is a mapped column, filtered with the f_ prefix
  const st = p1.data.rows[0].values.status;
  const filtered = await api('GET', `/employees?pageSize=100&f_status=${encodeURIComponent(st)}`);
  assert.ok(filtered.data.total >= 1);
  assert.ok(filtered.data.rows.every((r) => r.values.status === st));

  const firstCode = p1.data.rows[0].values.emp_code;
  const searched = await api('GET', `/employees?search=${encodeURIComponent(firstCode)}&pageSize=100`);
  assert.ok(searched.data.total >= 1);
  assert.ok(searched.data.rows.some((r) => r.values.emp_code === firstCode));
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
  for (const k of ['bench_category', 'block_status', 'status', 'allocation_percentage',
    'billing_status', 'billing_start_date', 'pid_awaited_account', 'pid_awaited_blocked_date',
    'opp_id', 'allocation_closure_eta', 'demand_number', 'ard_date',
    'role_of_month', 'role_of_responses', 'detail_comments', 'service_status']) {
    assert.ok(keys.includes(k), `submit field ${k} must be configurable`);
  }
});

test('supervisor submit writes every changed field in one transaction', async () => {
  const api = client(await login('priya.nair@resourceplanning.io'));
  const row = (await api('GET', '/employees?pageSize=1')).data.rows[0];
  const before = (await api('GET', `/employees/${row.assignmentId}`)).data.record;

  const res = await api('POST', `/employees/${row.assignmentId}/submit`, {
    changes: { opp_id: 'OPP-424242', pid_awaited_account: 'Northwind Bank', ard_date: '2026-12-15', block_status: 'Hard Block' },
    rev: before.rev,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.changed.sort(), ['ard_date', 'block_status', 'opp_id', 'pid_awaited_account']);
  assert.equal(res.data.record.values.opp_id, 'OPP-424242');

  // the saved values are what the table and the export read
  const after = (await api('GET', `/employees/${row.assignmentId}`)).data.record;
  assert.equal(after.values.block_status, 'Hard Block');

  // a submit against the old revision is rejected instead of silently clobbering
  const stale = await api('POST', `/employees/${row.assignmentId}/submit`, {
    changes: { opp_id: 'OPP-000000' }, rev: before.rev,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'STALE');
  assert.ok(stale.data.current, 'the latest record is returned for review');
});

test('access control on submit: read-only grants and other projects are refused', async () => {
  const viewer = client(await login('kavita.rao@resourceplanning.io'));
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const row = (await admin('GET', '/employees?pageSize=1')).data.rows[0];

  const readOnly = await viewer('POST', `/employees/${row.assignmentId}/submit`, { changes: { opp_id: 'X' } });
  assert.equal(readOnly.status, 403);

  const intruder = client(await login('arun.pillai@resourceplanning.io'));
  const foreign = await intruder('GET', `/employees/${row.assignmentId}`);
  assert.equal(foreign.status, 403);
  const foreignSubmit = await intruder('POST', `/employees/${row.assignmentId}/submit`, { changes: { opp_id: 'X' } });
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
  const field = q.get("SELECT id FROM fields WHERE key='block_status'");
  // pick someone who is not already hard blocked, so the request is a real change
  const row = (await sup('GET', '/employees?pageSize=200')).data.rows.find((r) => r.values.block_status !== 'Hard Block');
  assert.ok(row, 'the test seed must contain a person who is not hard blocked');
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

/* ------------------------------------- filter dropdowns (contextual counts) */
test('filter dropdowns list real values with counts, and the count follows the selection', async () => {
  const api = client(await login('priya.nair@resourceplanning.io'));
  const base = await api('GET', '/employees?pageSize=1');
  const projectId = base.data.rows[0].projectId;

  const unfiltered = await api('GET', `/employees?projectId=${projectId}&pageSize=1`);
  const want = ['billing_status', 'bench_category', 'bl_status', 'offsite_onsite', 'giga_project_name'];
  for (const key of want) {
    const facet = unfiltered.data.facets.find((f) => f.key === key);
    assert.ok(facet, `${key} must be available as a filter`);
    assert.ok(facet.values.length >= 1, `${key} must list its real values`);
    assert.ok(facet.values.every((v) => v.count > 0), `${key} option counts must be positive`);
  }

  // pick a value in one column: the row total must equal that option's count
  const bench = unfiltered.data.facets.find((f) => f.key === 'bench_category');
  const pickValue = bench.values.find((v) => v.count > 1);
  const filtered = await api('GET', `/employees?projectId=${projectId}&pageSize=1&f_bench_category=${encodeURIComponent(pickValue.value)}`);
  assert.equal(filtered.data.total, pickValue.count, 'the count shown in the dropdown must be the exact row count after selecting it');

  // the selected column keeps listing its siblings instead of collapsing
  const benchAfter = filtered.data.facets.find((f) => f.key === 'bench_category');
  assert.equal(benchAfter.values.length, bench.values.length, 'a filtered column must still offer every value');

  // every other column is re-counted within the new selection
  const billingAfter = filtered.data.facets.find((f) => f.key === 'billing_status');
  const sum = billingAfter.values.reduce((a, v) => a + v.count, 0);
  assert.equal(sum, filtered.data.total, 'other dropdowns must add up to the filtered total');

  // and a second filter narrows both the rows and the numbers
  const billingPick = billingAfter.values[0];
  const two = await api('GET',
    `/employees?projectId=${projectId}&pageSize=1&f_bench_category=${encodeURIComponent(pickValue.value)}&f_billing_status=${encodeURIComponent(billingPick.value)}`);
  assert.equal(two.data.total, billingPick.count, 'stacked filters must agree with the counts shown');
});

test('filter dropdowns work on the Directory page, where there is no project scope', async () => {
  // Regression: facetsFor returned [] whenever scope.projectId was empty, so on
  // the all-projects Directory every dropdown was permanently disabled with (0).
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const all = await admin('GET', '/employees?pageSize=1');
  assert.ok(all.data.total > 1);
  assert.ok(all.data.facets.length >= 5, 'an all-projects view must still offer filter values');

  const want = ['billing_status', 'bench_category', 'bl_status', 'offsite_onsite', 'giga_project_name'];
  for (const key of want) {
    const facet = all.data.facets.find((f) => f.key === key);
    assert.ok(facet, `${key} must be offered with no project selected`);
    assert.ok(facet.values.length >= 1, `${key} must list values with no project selected`);
    assert.ok(facet.total > 0, `${key} must have a non-zero total`);
  }

  // and filtering still works without a project scope
  const bench = all.data.facets.find((f) => f.key === 'bench_category');
  const pick = bench.values[0];
  const filtered = await admin('GET', `/employees?pageSize=1&f_bench_category=${encodeURIComponent(pick.value)}`);
  assert.equal(filtered.data.total, pick.count);
});

test('a supervisor with no project selected only counts rows they may see', async () => {
  const priya = client(await login('priya.nair@resourceplanning.io'));
  const page = await priya('GET', '/employees?pageSize=1');
  const bench = page.data.facets.find((f) => f.key === 'bench_category');
  assert.ok(bench, 'dropdown values are available');
  // blank cells are not offered as an option, so the counts can only fall short
  // of the total -- never exceed it, and never count rows the user cannot see.
  assert.ok(bench.total <= page.data.total);
  const sum = bench.values.reduce((a, v) => a + v.count, 0);
  assert.ok(sum <= page.data.total, `${sum} counted values > ${page.data.total} visible rows`);
  const pick = bench.values[0];
  const filtered = await priya(
    'GET',
    `/employees?pageSize=1&f_bench_category=${encodeURIComponent(pick.value)}`
  );
  assert.equal(filtered.data.total, pick.count);
});

/* ------------------------------------------------ CRM panel column set */
test('the CRM panel offers the workbook supervisor columns and nothing else', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const res = await admin('GET', '/settings/crm-fields');
  assert.equal(res.status, 200);

  // BC-BS of the workbook, and nothing else: Giga Project Name is not in that
  // strip, so it must not appear in the leader's form
  const want = ['leader_input_last_week', 'leader_input_this_week', 'leader_input_pid_account',
    'billing_start_date', 'billing_end_date', 'pid_awaited_account', 'pid_awaited_blocked_date',
    'opp_id', 'account_owner', 'allocation_closure_eta', 'role_of_month', 'role_of_responses',
    'detail_comments', 'block_status', 'account_name', 'interviewed_by', 'demand_number'];
  assert.deepEqual(res.data.keys, want, 'the panel shows exactly the BC-BS columns, in order');
  // identity is not one of them: Employee ID and the names are the header, not editable fields
  for (const k of ['emp_code', 'first_name', 'last_name']) assert.ok(!res.data.keys.includes(k));

  const labels = res.data.fields.map((f) => f.label);
  assert.ok(labels.includes('Leader Input Last Week'));
  assert.ok(labels.includes('Hard Block / Soft Block'));
  assert.ok(labels.includes('Demand Number'));
  assert.ok(!labels.includes('Giga Project Name'), 'Giga Project Name is outside BC-BS');
});

test('an administrator can change the CRM columns without a code change', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const before = (await admin('GET', '/settings/crm-fields')).data.keys;

  const saved = await admin('PUT', '/settings/crm-fields', {
    keys: ['opp_id', 'detail_comments', 'nonsense_key'],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.keys.filter((k) => k === 'opp_id' || k === 'detail_comments'),
    ['opp_id', 'detail_comments']);
  assert.ok(!saved.data.keys.includes('nonsense_key'), 'unknown columns are rejected, not stored');

  // a supervisor may read the setting but not write it
  const priya = client(await login('priya.nair@resourceplanning.io'));
  assert.equal((await priya('GET', '/settings/crm-fields')).status, 200);
  assert.equal((await priya('PUT', '/settings/crm-fields', { keys: ['opp_id'] })).status, 403);

  // restore for the tests that follow
  await admin('PUT', '/settings/crm-fields', { keys: before });
});

test('a supervisor submit reaches the export with the value, the author and the time', async () => {
  const priya = client(await login('priya.nair@resourceplanning.io'));
  const row = (await priya('GET', '/employees?pageSize=1')).data.rows[0];
  const rec = (await priya('GET', `/employees/${row.assignmentId}`)).data.record;

  const res = await priya('POST', `/employees/${row.assignmentId}/submit`, {
    changes: {
      leader_input_this_week: 'Awaiting client sign-off on the PID',
      opp_id: 'OPP-777001',
      demand_number: 'DEM-55012',
    },
    rev: rec.rev,
    reason: 'Supervisor submit',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.record.values.opp_id, 'OPP-777001');

  // the workbook the administrator fetches shows the new values, who set them,
  // and when - the round trip the brief asks for
  const out = path.join(TMP, 'crm-export.xlsx');
  const token = await login('admin@resourceplanning.io', 'Admin@12345');
  const raw = await fetch(`${base}/api/export?projectId=${row.projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(raw.status, 200);
  fs.writeFileSync(out, Buffer.from(await raw.arrayBuffer()));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const ws = wb.getWorksheet('Employees');
  const head = ws.getRow(1).values.slice(1);
  for (const label of ['Employee ID', 'First Name', 'Last Name',
    'Leader Input Last Week', 'Leader Input This Week', 'PID Awaited Account',
    'PID Awaited Blocked Date', 'Opp ID', 'Allocation Closure ETA', 'Role of Month',
    'Role of Responses', 'Detail Comments', 'Hard Block / Soft Block',
    'Account Name', 'Interviewed By', 'Demand Number', 'Giga Project Name']) {
    assert.ok(head.includes(label), `the export must carry the ${label} column`);
  }
  const byCol = head.indexOf('Leader Input This Week — Updated By');
  const atCol = head.indexOf('Leader Input This Week — Updated At');
  const stampCol = head.indexOf('Last Supervisor Update');
  assert.ok(byCol >= 0, 'a per-field author column exists');

  let found = null;
  ws.eachRow((r, i) => {
    if (i === 1) return;
    if (String(r.values[head.indexOf('Opp ID') + 1]) === 'OPP-777001') found = r.values;
  });
  assert.ok(found, 'the submitted row is in the workbook');
  assert.equal(found[byCol + 1], 'Priya Nair');
  assert.ok(found[atCol + 1], 'the change carries a timestamp');
  assert.match(String(found[stampCol + 1]), /Priya Nair/);
});

test('re-importing our own export does not create fields from the change stamps', async () => {
  const adminToken = await login('admin@resourceplanning.io', 'Admin@12345');
  const admin = client(adminToken);
  const before = (await admin('GET', '/bootstrap')).data.fields.length;
  assert.ok(before > 50, 'the field catalogue loaded');

  const raw = await fetch(`${base}/api/export`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(raw.status, 200);
  const buf = Buffer.from(await raw.arrayBuffer());

  const preview = await admin('POST', '/import', {
    filename: 'round-trip.xlsx',
    content: buf.toString('base64'),
    dryRun: true,
  });
  assert.equal(preview.status, 200);
  const report = preview.data.result;
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors[0] || {}));

  const after = (await admin('GET', '/bootstrap')).data.fields.map((f) => f.key);
  assert.ok(Array.isArray(after) && after.length > 50, `field catalogue after import: ${JSON.stringify(after).slice(0, 120)}`);
  assert.equal(after.length, before, `the import did not add fields (before ${before}, after ${after.length})`);
  assert.ok(!after.some((k) => /updated_by$|updated_at$|last_supervisor_update/.test(k)),
    '"— Updated By" / "Last Supervisor Update" are ignored, not turned into fields');
});

test('every one of the BC-BS update columns resolves on every record', async () => {
  // Regression: the panel rendered from `record.columns`, so a column the
  // category never listed silently vanished from the leader's form. On the demo
  // data six of the seventeen were missing in every category.
  const priya = client(await login('priya.nair@resourceplanning.io'));
  const keys = (await priya('GET', '/bootstrap')).data.crmKeys;
  assert.equal(keys.length, 17, 'BC through BS');

  const rows = (await priya('GET', '/employees?pageSize=20')).data.rows;
  assert.ok(rows.length > 3);
  for (const row of rows) {
    const rec = (await priya('GET', `/employees/${row.assignmentId}`)).data.record;
    const have = new Set(rec.columns.map((c) => c.key));
    const missing = keys.filter((k) => !have.has(k));
    assert.deepEqual(missing, [], `${rec.categoryName} is missing ${missing.join(', ')}`);
  }
});

test('a workbook with only your own 65 headers imports once a placement is chosen', async () => {
  // The real HR master file has no Project / Subproject / Category column.
  // Pick the placement once in Data Hub and every row is filed there.
  const token = await login('sameer.khan@resourceplanning.io');
  const c = client(token);
  const boot = (await c('GET', '/bootstrap')).data;
  const proj = boot.tree[0];
  const sub = proj.subprojects[0];
  const cat = sub.categories[0];
  const headers = fielddefs.WORKBOOK_HEADERS.map(([label]) => label);
  assert.equal(headers.length, 65);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  const row = new Array(headers.length).fill('');
  const put = (label, v) => { row[headers.indexOf(label)] = v; };
  put('employee ID', 'EMP-NEW-0001');
  put('first name', 'Real');
  put('last name', 'Import');
  put('leader input this week', 'from my own file');
  put('Opp ID', 'OPP-55555');
  put('billing end date', '2026-12-31');
  put('unite manual', 'Unit Seven');
  put('PID awaited account + blocked date', 'Northwind Bank');
  put('Hardblock/Softblock', 'Soft Block');
  ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();

  // without a placement the rows cannot be filed and say so
  const bare = await c('POST', '/import', { filename: 'mine.xlsx', content: buf.toString('base64'), dryRun: true });
  assert.equal(bare.status, 200);
  assert.match(bare.data.result.errors[0].message, /Project column is required/);

  const preview = await c('POST', '/import', {
    filename: 'mine.xlsx', content: buf.toString('base64'), dryRun: true,
    projectId: proj.id, subprojectId: sub.id, categoryId: cat.id,
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.result.errors, []);
  assert.equal(preview.data.result.created, 1);

  const applied = await c('POST', '/import', {
    filename: 'mine.xlsx', content: buf.toString('base64'),
    projectId: proj.id, subprojectId: sub.id, categoryId: cat.id,
  });
  assert.equal(applied.status, 200);

  // the four headers the old matcher dropped now land on their own columns
  const stored = q.all(
    `SELECT f.key, av.value FROM assignment_values av
       JOIN fields f ON f.id = av.field_id
       JOIN assignments a ON a.id = av.assignment_id
       JOIN employees e ON e.id = a.employee_id
      WHERE e.emp_code = 'EMP-NEW-0001'`
  );
  const map = new Map(stored.map((r) => [r.key, r.value]));
  assert.equal(map.get('leader_input_this_week'), 'from my own file');
  assert.equal(map.get('opp_id'), 'OPP-55555');
  assert.equal(map.get('billing_end_date'), '2026-12-31');
  assert.equal(map.get('unit_manual'), 'Unit Seven');
  assert.equal(map.get('pid_awaited_account'), 'Northwind Bank');
  assert.equal(map.get('block_status'), 'Soft Block');
});

test('the import template downloads with your 65 headers and round-trips', async () => {
  const token = await login('sameer.khan@resourceplanning.io');
  const res = await fetch(`${base}/api/import/template`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /resource-planning-import-template/);

  const buf = Buffer.from(await res.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Employees');
  const headers = ws.getRow(1).values.slice(1).map(String);
  assert.deepEqual(headers.slice(0, 3), ['Project', 'Subproject', 'Category']);
  // BC-BS sit exactly where the workbook puts them, offset by the 3 hierarchy columns
  assert.equal(headers[3 + 37], 'billing status');          // BP
  assert.equal(headers[3 + 45], 'leader input last week');  // BC
  assert.equal(headers[3 + 52], 'Opp ID');                  // BJ
  assert.equal(headers.at(-1), 'ARD date');
  assert.equal(headers.length, 68);
  assert.ok(wb.getWorksheet('How to use'), 'the template explains itself');
});

test('a new user is created with their project access and capabilities in the same step', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const project = q.get('SELECT * FROM projects LIMIT 1');

  const created = await admin('POST', '/users', {
    name: 'Test Leader', email: 'test.leader@resourceplanning.io', role: 'supervisor',
    title: 'Delivery Lead', password: 'Leader@12345',
    projects: [{ project_id: project.id, can_edit: true, can_export: false, can_crm: true }],
    capabilities: { 'employee.edit': true, 'crm.use': true, 'export.data': false },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.user.id;

  const list = await admin('GET', '/users');
  const me = list.data.users.find((u) => u.id === id);
  assert.ok(me, 'the new user is listed');
  assert.equal(me.projects.length, 1);
  assert.equal(me.projects[0].project_id, project.id);
  assert.equal(me.projects[0].can_export, 0);
  assert.equal(me.capabilities['employee.edit'], true);
  assert.equal(me.capabilities['export.data'], false);

  // and they can sign in straight away, with that access
  const token = await login('test.leader@resourceplanning.io', 'Leader@12345');
  const boot = await client(token)('GET', '/bootstrap');
  assert.equal(boot.status, 200);
  assert.ok(boot.data.user.projects.some((p) => p.id === project.id), 'the grant is live at sign-in');

  const gone = await admin('DELETE', `/users/${id}`);
  assert.equal(gone.status, 200);
  const after = await admin('GET', '/users');
  assert.ok(!after.data.users.some((u) => u.id === id), 'the account is gone');
  const relogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test.leader@resourceplanning.io', password: 'Leader@12345' }),
  });
  assert.equal(relogin.status, 401, 'a deleted user cannot sign in');
});

test('an administrator cannot delete their own account, but can delete another admin', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const list = await admin('GET', '/users');
  const self = list.data.users.find((u) => u.email === 'admin@resourceplanning.io');
  assert.ok(self);

  const selfDelete = await admin('DELETE', `/users/${self.id}`);
  assert.equal(selfDelete.status, 422);
  assert.match(selfDelete.data.error, /your own account/);

  // a second admin can be created and deleted by the first
  const second = await admin('POST', '/users', {
    name: 'Second Admin', email: 'second.admin@resourceplanning.io', role: 'admin', password: 'Admin@12345',
  });
  assert.equal(second.status, 200);
  const secondId = second.data.user.id;
  assert.equal((await admin('DELETE', `/users/${secondId}`)).status, 200);

  // the seeded admin is still there and still the only administrator
  const after = await admin('GET', '/users');
  assert.equal(after.data.users.filter((u) => u.role === 'admin').length, 1);
});

test('deleting a user keeps their import history but clears the uploader link', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const created = await admin('POST', '/users', {
    name: 'Importer', email: 'importer@resourceplanning.io', role: 'supervisor', password: 'Import@12345',
  });
  assert.equal(created.status, 200);
  const id = created.data.user.id;
  q.run('INSERT INTO imports (filename, uploaded_by, created, updated) VALUES (?, ?, ?, ?)', 'importer-daily.xlsx', id, 3, 1);

  assert.equal((await admin('DELETE', `/users/${id}`)).status, 200);
  const row = q.get('SELECT * FROM imports WHERE filename = ?', 'importer-daily.xlsx');
  assert.ok(row, 'the import record survives');
  assert.equal(row.uploaded_by, null, 'the uploader link is cleared');
});
