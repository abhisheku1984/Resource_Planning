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
const { db, q } = require('../server/db');
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

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); // release the SQLite files before removing them on Windows
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
test('offline speech serves only fixed local assets, never an install/upload endpoint or a document-wide eval exception', async () => {
  const status = await fetch(`${base}/speech/status`);
  assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store');
  const packs = await status.json(); assert.deepEqual(Object.keys(packs).sort(), ['en', 'hi']);
  for (const p of Object.values(packs)) for (const url of Object.values(p)) assert.match(url, /^\/speech\/models\/[\w.-]+$/);
  for (const url of ['/speech/install', '/speech/models/not-installed.tar.gz', '/speech/node_modules/anything', '/speech/setup.js', '/speech/studio/install', '/speech/tokens/index.js', '/speech/ort/ort.webgpu.min.mjs', '/speech/models/voice.onnx.part']) assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await fetch(base + '/speech/status', { method: 'POST' })).status, 404);
  for (const [url, directive] of [['/', "script-src 'self'"], ['/js/voice.js', "script-src 'self'"],
    ['/js/speech/studio.js', "script-src 'self'"], ['/speech/ort/ort.wasm.min.mjs', "script-src 'self'"],
    ['/speech/vosk.worker.js', "script-src 'unsafe-eval'"], ['/js/speech/speaker-worker.js', "script-src 'self' 'wasm-unsafe-eval'"]]) {
    const headers = (await fetch(base + url, { method: 'HEAD' })).headers;
    const csp = headers.get('content-security-policy').split('; ');
    assert.ok(csp.includes(directive) && csp.includes("connect-src 'self'"));
    if (url.includes('worker.js')) assert.ok(csp.includes("worker-src 'none'"));
  }
});

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
  assert.equal((await sup('POST', '/users', {})).status, 403);
  assert.equal((await sup('DELETE', '/users/1')).status, 403);
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
    // The form only sends the settings it edits.
    sort_order: f.sort_order,
  });
  const payload = original.map((f) => toPayload(f, f.key === 'remarks' ? false : f.visible));
  const put = await admin('PUT', `/categories/${cat.id}/columns`, { fields: payload });
  assert.equal(put.status, 200);

  try {
    const savedLayout = (await admin('GET', `/categories/${cat.id}/columns`)).data.fields;
    const flags = (fields) => fields.map((f) => [f.id, f.filterable, f.submit_field, f.section, f.sort_order]);
    assert.ok(original.some((f) => f.filterable) && original.some((f) => f.submit_field));
    assert.deepEqual(flags(savedLayout), flags(original), 'a layout save preserves the filter and supervisor field metadata');
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

test('assistant answers for a workbook name across placements, intersected with the caller’s grants', async () => {
  const hierarchy = q.get("SELECT id FROM projects WHERE code='NEXUS'").id;
  const user = { isAdmin: false, projects: [{ id: hierarchy }] };
  const name = 'Giga One';
  for (const actor of [user, { isAdmin: true }]) {
    const expected = q.get(`SELECT COUNT(DISTINCT g.employee_id) c FROM giga_assignments g
      JOIN assignment_values v ON g.assignment_id=v.assignment_id JOIN fields f ON f.id=v.field_id
      WHERE g.project_name=? AND f.key='bench_category' AND v.value='Bench' AND (? OR g.project_id=?)`, name, +!!actor.isAdmin, hierarchy).c;
    const result = agent.understand(actor, 'how many people are on bench in Giga 1?');
    assert.equal(result.kind, 'count'); assert.equal(result.data.project, name);
    assert.equal(result.data.count, expected); assert.match(result.reply, /Giga One/);
    assert.equal(Number(result.table.rows.find(([v]) => v === 'Bench')?.[1] || 0), expected);
    assert.ok(result.suggestions.every((s) => s.includes(name)));
    assert.equal(agent.understand(actor, 'How many employees in Giga One are on bench?').data.count, expected);
    const who = agent.understand(actor, 'Who is on bench?', name);
    assert.equal(who.data.count, expected); assert.ok(who.table.rows.every((row) => row[2] === name));
  }
  const api = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  assert.equal((await api('POST', '/agent/ask', { message: 'How many are on bench?' })).data.kind, 'choose_project');
  assert.ok((await api('GET', '/agent/projects')).data.projectNames.includes(name));
});

test('Hindi Ask resolves full workbook names, scopes metrics like English, and declines unknown names and filters', async () => {
  const api = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const ask = async (message, projectName) => (await api('POST', '/agent/ask', { message, projectName, language: 'hi' })).data;
  const name = 'Giga One';
  assert.equal((await ask('बेंच पर कितने लोग हैं?')).kind, 'choose_project');
  assert.equal((await ask('प्रोजेक्ट गीगा वन चुनें।')).projectName, name);
  for (const [message, en, kind] of [
    ['गीगा एक में बेंच पर कितने कर्मचारी हैं?', 'How many are on bench?', 'count'],
    ['बेंच पर कौन-कौन है?', 'Who is on bench?', 'list'],
    ['बेंच श्रेणी शैडो पर कितने लोग हैं?', 'How many bench category shadow?', 'count'],
    ['बी एल २ पर कितने कर्मचारी हैं?', 'How many on BL-2?', 'count'],
    ['बिलिंग स्थिति का विवरण दिखाएँ।', 'Break down billing status', 'breakdown'],
    ['इस प्रोजेक्ट में हार्ड ब्लॉक पर कितने लोग हैं?', 'How many on hard block?', 'count'],
  ]) {
    const result = await ask(message, name), english = (await api('POST', '/agent/ask', { message: en, projectName: name })).data;
    assert.equal(result.kind, kind); assert.equal(result.projectName, name); assert.match(result.reply, /कर्मचारी/u);
    assert.deepEqual(result.data, english.data); assert.deepEqual(result.table.rows, english.table.rows);
    assert.ok(result.suggestions.every((s) => s.includes(name) && s.includes('में')));
  }
  for (const unknown of ['NEXUS', 'Giga One East', 'गीगा एक ईस्ट']) {
    const result = await ask(`${unknown} में बेंच पर कितने लोग हैं?`, name);
    assert.equal(result.kind, 'denied'); assert.ok(!result.data && !result.table && !result.crm);
  }
  for (const question of ['बेंच पर नहीं हैं कितने लोग?', 'अज्ञात फ़िल्टर पर कितने हैं?']) assert.equal((await ask(question, name)).kind, 'help');
  assert.equal((await ask('कितने कर्मचारी हैं?', 'Old selection')).kind, 'denied');
  assert.equal((await api('POST', '/agent/ask', { message: 'How many?', language: 'xx' })).status, 422);
});

test('assistant does not substitute a hierarchy, unknown name, or stale selection', () => {
  const user = { isAdmin: true };
  for (const q of ['How many are on bench in NEXUS?', 'Who is on bench in Giga One East?', 'Open CRM for EMP-12345 in Not A Project']) {
    const plan = agent.understand(user, q, 'Giga One');
    assert.equal(plan.kind, 'denied'); assert.ok(!plan.data && !plan.table && !plan.crm);
  }
  assert.equal(agent.understand(user, 'How many are hard block?', 'Former Giga Name').kind, 'denied');
  assert.equal(agent.understand(user, 'How many unknown things in Giga One?').data, undefined);
});

test('assistant never writes: it only raises a proposal an admin must approve', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const sup = client(await login('priya.nair@resourceplanning.io'));
  const field = q.get("SELECT id FROM fields WHERE key='block_status'");
  // pick someone who is not already hard blocked, so the request is a real change
  const target = q.get(`SELECT g.assignment_id, g.project_name FROM giga_assignments g JOIN projects p ON p.id=g.project_id
    JOIN assignment_values v ON v.assignment_id=g.assignment_id WHERE p.code='NEXUS' AND v.field_id=? AND v.value <> 'Hard Block' LIMIT 1`, field.id);
  const row = (await sup('GET', `/employees/${target.assignment_id}`)).data.record;
  assert.ok(row, 'the test seed must contain a person who is not hard blocked');
  const before = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', row.assignmentId, field.id);

  const res = await sup('POST', '/agent/ask', { message: `set ${row.values.emp_code} to hard block in ${target.project_name}` });
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

test('deleting a user with work history revokes their session, not their records or export attribution', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const place = q.get('SELECT project_id, subproject_id, category_id FROM assignments LIMIT 1');
  const email = 'importer@resourceplanning.io';
  const created = await admin('POST', '/users', {
    name: 'Importer', email, role: 'supervisor', password: 'Import@12345',
    projects: [{ project_id: place.project_id }], capabilities: { 'employee.create': true, 'employee.edit': true },
  });
  assert.equal(created.status, 200);
  const id = created.data.user.id;
  const sup = client(await login(email, 'Import@12345'));
  const person = await sup('POST', '/employees', { ...place, emp_code: 'TEST-HISTORY', name: 'Retained Employee' });
  assert.equal(person.status, 200);
  const aid = person.data.assignmentId;
  const edit = await sup('POST', `/employees/${aid}/submit`, { changes: { leader_input_this_week: 'Approved for next week' } });
  assert.equal(edit.status, 200);
  const entry = (await admin('GET', `/employees/${aid}/history`)).data.history.find((row) => row.field_key === 'leader_input_this_week');
  assert.equal(entry.actor_name, 'Importer');
  const upload = q.run('INSERT INTO imports (filename, uploaded_by) VALUES (?, ?)', 'daily.xlsx', id).lastInsertRowid;
  const job = q.run('INSERT INTO import_jobs (filename, user_id) VALUES (?, ?)', 'daily.xlsx', id).lastInsertRowid;
  const proposal = q.run(`INSERT INTO agent_actions (kind, summary, before_json, after_json, requested_by, requested_by_name, decided_by, decided_by_name)
    VALUES ('update_assignment', 'Example', '{}', '{}', ?, 'Importer', ?, 'Importer')`, id, id).lastInsertRowid;

  const removed = await admin('DELETE', `/users/${id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await sup('GET', '/auth/me')).status, 401, 'even an already signed-in session is revoked');
  assert.equal((await admin('DELETE', `/users/${id}`)).status, 404);
  assert.equal(q.get('SELECT uploaded_by FROM imports WHERE id = ?', upload).uploaded_by, null);
  assert.equal(q.get('SELECT user_id FROM import_jobs WHERE id = ?', job).user_id, null);
  const action = q.get('SELECT * FROM agent_actions WHERE id = ?', proposal);
  assert.deepEqual([action.requested_by, action.decided_by, action.requested_by_name, action.decided_by_name], [null, null, 'Importer', 'Importer']);
  assert.deepEqual(q.all('PRAGMA foreign_key_check'), []);
  assert.equal((await admin('GET', `/employees/${aid}`)).data.record.values.leader_input_this_week, 'Approved for next week');
  const report = require('../server/excel').collectRows({ isAdmin: true }, { categoryId: place.category_id });
  const exported = report.rows.find((r) => r.emp_code === 'TEST-HISTORY');
  assert.equal(exported.updated_by, 'Importer');
  assert.equal(exported.leader_input_this_week__updated_by, 'Importer');
  assert.equal(exported.leader_input_this_week__updated_at, entry.at);
});

test('a failed project grant leaves no partial account; creation can be retried with the same email', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const account = { name: ' New leader ', email: ' retry@example.test ', password: 'Example123', role: 'supervisor' };
  const grant = { project_id: q.get('SELECT id FROM projects LIMIT 1').id, can_export: 0 };
  const failed = await admin('POST', '/users', { ...account, projects: [grant, { project_id: -1 }] });
  assert.equal(failed.status, 422);
  assert.ok(!q.get('SELECT id FROM users WHERE trim(email) = ?', account.email.trim()));
  const retry = await admin('POST', '/users', { ...account, projects: [grant] });
  assert.equal(retry.status, 200);
  const reader = client(await login('retry@example.test', 'Example123'));
  const me = (await reader('GET', '/auth/me')).data.user;
  assert.equal(me.name, 'New leader');
  assert.equal(me.projects[0].can_export, 0);
});

test('Giga Project Name is an assignment-level grant, not a removable Directory filter', async (t) => {
  const adminToken = await login('admin@resourceplanning.io', 'Admin@12345');
  const admin = client(adminToken);
  const A = "Orion's Giga %_|Alpha", B = `${A} East`;
  const email = 'xyz@example.test', password = 'ExampleGiga123';
  const places = q.all(`SELECT c.id AS category_id, c.subproject_id, s.project_id FROM categories c
                         JOIN subprojects s ON s.id = c.subproject_id ORDER BY c.id`);
  const p = places[0], p2 = places.find((v) => v.project_id !== p.project_id);
  const sibling = places.find((v) => v.project_id === p.project_id && v.category_id !== p.category_id);
  const field = q.get("SELECT id FROM fields WHERE key = 'giga_project_name'").id;
  const tag = (id, name) => q.run(`INSERT INTO assignment_values (assignment_id, field_id, value) VALUES (?, ?, ?)
    ON CONFLICT(assignment_id, field_id) DO UPDATE SET value=excluded.value`, id, field, name);
  const add = async (code, place, giga) => {
    const r = await admin('POST', '/employees', { emp_code: code, name: `Person ${code}`, ...place });
    assert.equal(r.status, 200);
    tag(r.data.assignmentId, giga);
    return r.data;
  };
  const one = await add('GIG-88001', p, A);
  const two = await add('GIG-88002', p2, `\u00a0 ${A}\u2003`); // same workbook name after trimming
  const other = await add('GIG-88003', p, B); // same parent, subproject AND category as one
  const sharedOther = await add('GIG-88001', sibling, B); // CRM must hide this second placement
  const blank = await add('GIG-88004', p, ' \t');
  const expected = [one.assignmentId, two.assignmentId].sort((a, b) => a-b);
  const caps = { 'employee.edit': true, 'employee.create': true, 'crm.use': true, 'export.data': true, 'audit.view': true };

  const list = await admin('GET', '/users');
  assert.equal(list.data.gigaProjectNames.filter((n) => n === A).length, 1);
  assert.ok(list.data.gigaProjectNames.includes(B));
  assert.ok(list.data.gigaProjectNames.every((n) => n && n === n.trim()));
  const account = { name: 'XYZ', email, password, capabilities: caps };
  assert.equal((await admin('POST', '/users', { ...account, gigaProjectName: `${A}x` })).status, 422);
  assert.equal((await admin('POST', '/users', { ...account, role: 'admin', gigaProjectName: A })).status, 422);
  const made = await admin('POST', '/users', { ...account, gigaProjectName: A });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const accessPath = `/users/${made.data.user.id}/access`;
  const token = await login(email, password), xyz = client(token);
  const ids = async (suffix = '') => {
    const r = await xyz('GET', '/employees?includeSummary=1&pageSize=200' + suffix);
    assert.equal(r.status, 200, JSON.stringify(r.data.error));
    assert.equal(r.data.total, r.data.rows.length);
    assert.deepEqual(r.data.summary, {
      placements: r.data.total,
      people: new Set(r.data.rows.map((row) => row.employeeId)).size,
      hierarchyProjects: new Set(r.data.rows.map((row) => row.projectId)).size,
      gigaProjects: r.data.total ? 1 : 0,
      pendingReviews: null, // the duplicate queue is admin-only
    });
    return r.data.rows.map((row) => row.assignmentId).sort((a, b) => a-b);
  };

  await t.test('workspace, Directory, standalone counts and dashboard include only matching placements', async () => {
    const boot = (await xyz('GET', '/bootstrap')).data;
    assert.equal(boot.user.gigaAccess.name, A);
    assert.equal(boot.totals.employees, 2);
    assert.equal(boot.totals.assignments, 2);
    assert.deepEqual(boot.tree.flatMap((project) => project.subprojects.flatMap((s) => s.categories.map((c) => c.id))).sort((x,y) => x-y),
      [p.category_id, p2.category_id].sort((x,y) => x-y));
    assert.deepEqual(await ids(), expected);
    assert.deepEqual(await ids(`&categoryId=${p.category_id}`), [one.assignmentId]);
    assert.deepEqual(await ids('&search=GIG-88003'), []);
    assert.deepEqual(await ids(`&f_giga_project_name[]=${encodeURIComponent(B)}`), []);
    const facets = (await xyz('GET', '/employees/facets')).data.facets;
    const giga = facets.find((f) => f.key === 'giga_project_name');
    assert.ok(giga.values.every((v) => v.value.trim() === A));
    assert.equal(giga.total, 2);
    for (const v of giga.values) assert.equal((await ids(`&f_giga_project_name[]=${encodeURIComponent(v.value)}`)).length, v.count);
    assert.deepEqual(boot.suppliers, []);
    assert.deepEqual(boot.fields.find((f) => f.key === 'supplier').options, []);
    const dash = (await xyz('GET', '/dashboard')).data;
    for (const key of ['byProject','byStatus','bySupplier','byCategory']) assert.equal(dash[key].reduce((n,r) => n+r.c,0), 2, key);
    assert.ok(dash.attention.every((r) => expected.includes(r.assignment_id)));
    assert.equal((await xyz('GET', `/categories/${sibling.category_id}/columns`)).status, 403);
  });

  await t.test('opening, searching, editing, creating and history cannot cross the grant', async () => {
    const search = (await xyz('GET','/people?q=GIG-88')).data.people;
    assert.equal(search.length, 2);
    assert.equal(search.find((r) => r.id === one.employeeId).placements, 1);
    assert.deepEqual((await xyz('GET', `/people/${one.employeeId}`)).data.placements.map((r) => r.assignment_id), [one.assignmentId]);
    assert.equal((await xyz('GET', `/people/${other.employeeId}`)).status, 403);
    for (const row of [other, sharedOther, blank]) {
      const path = `/employees/${row.assignmentId}`;
      assert.equal((await xyz('GET', path)).status, 403);
      assert.equal((await xyz('GET', `${path}/history`)).status, 403);
      for (const [verb, url] of [['PATCH', path], ['POST', `${path}/submit`]]) {
        const denied = await xyz(verb, url, { changes: { leader_input_this_week: 'no' }, rev: -1 });
        assert.equal(denied.status, 403);
        assert.ok(!denied.data.current, 'no out-of-scope conflict snapshot');
      }
    }
    const item = `/employees/${one.assignmentId}`;
    assert.equal((await xyz('PATCH', item, { changes: { giga_project_name: B } })).status, 403);
    const foreignSupplier = q.get('SELECT id, name FROM suppliers LIMIT 1');
    const supplierEdit = await xyz('PATCH', item, { changes: { supplier: foreignSupplier.name } });
    assert.ok([403, 422].includes(supplierEdit.status));
    assert.equal(q.get('SELECT supplier_id FROM assignments WHERE id = ?', one.assignmentId).supplier_id, null);
    assert.equal((await xyz('PATCH', item, { changes: { email: 'shared@example.test' } })).status, 403);
    assert.equal((await xyz('POST', `${item}/submit`, { changes: { leader_input_this_week: 'Ready for review' } })).status, 200);
    assert.equal((await xyz('POST','/employees',{ ...p, emp_code: 'GIG-88003', name: 'Other person' })).status, 403);
    assert.equal((await xyz('POST','/employees',{ ...sibling, emp_code: 'GIG-88001', name: 'Same person' })).status, 403);
    assert.equal((await xyz('POST','/employees',{ ...p, emp_code: 'GIG-88005', name: 'New person', giga_project_name: B })).status, 403);
    // New rows created in an allowed placement inherit the server-side grant.
    const added = await xyz('POST','/employees',{ ...p, emp_code: 'GIG-88005', name: 'New person' });
    assert.equal(added.status, 200, JSON.stringify(added.data.error));
    assert.equal(added.data.record.values.giga_project_name, A);
    expected.push(added.data.assignmentId);
    assert.deepEqual(await ids(), expected);
  });

  await t.test('reports, assistant and export cannot reveal another Giga project', async () => {
    const ask = async (message) => (await xyz('POST','/agent/ask',{ message })).data;
    assert.equal((await ask('How many people in my projects?')).data.count, expected.length);
    assert.ok(!(await ask('Set GIG-88003 to hard block')).proposal);
    assert.deepEqual((await xyz('GET', '/agent/projects')).data.projectNames, [A]);
    for (const question of ['List people', 'How many', 'Open CRM for GIG-88001', 'Set GIG-88001 to hard block']) {
      const denied = await ask(`${question} in ${B}`);
      assert.equal(denied.kind, 'denied'); assert.ok(!denied.data && !denied.table && !denied.proposal && !denied.crm);
    }
    const hiddenProposal = await admin('POST','/agent/ask',{ message: `Set GIG-88003 to hard block in ${B}` });
    assert.ok(hiddenProposal.data.proposal);
    const proposals = (await xyz('GET','/agent/proposals')).data;
    assert.ok(proposals.proposals.every((r) => expected.includes(r.assignmentId)));
    assert.equal(proposals.pending, 0);
    tag(other.assignmentId, A); // no account should inherit the previous Giga's proposal
    assert.equal((await xyz('GET','/agent/proposals')).data.pending, 0);
    assert.equal((await admin('POST',`/agent/proposals/${hiddenProposal.data.proposal.id}/approve`,{})).status, 409);
    tag(other.assignmentId, B);
    for (const entity of ['assignment','employee','user']) {
      const rows = (await xyz('GET','/audit?entity=' + entity)).data.activity;
      assert.ok(rows.every((r) => r.entity === 'assignment' ? expected.includes(r.entity_id) : r.entity === 'employee' && r.entity_id !== other.employeeId));
    }
    assert.deepEqual((await xyz('GET',`/audit/assignment/${other.assignmentId}`)).data.history, []);
    assert.deepEqual((await xyz('GET','/groups')).data.groups, []);
    assert.deepEqual((await xyz('GET','/imports')).data.imports, []);
    assert.equal((await xyz('POST','/import',{})).status, 403);
    assert.equal((await xyz('GET','/users')).status, 403);
    assert.equal((await xyz('PUT',accessPath,{ gigaProjectName: B })).status, 403);
    const res = await fetch(`${base}/api/export`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers.get('X-Export-Rows')), expected.length);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet('Employees'), gi = ws.getRow(1).values.indexOf('Giga Project Name');
    assert.ok(gi > 0);
    ws.eachRow((row, i) => { if (i > 1) assert.equal(String(row.getCell(gi).value).trim(), A); });
    const foreignFilter = await fetch(`${base}/api/export?f_giga_project_name[]=${encodeURIComponent(B)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(foreignFilter.status, 200);
    assert.equal(foreignFilter.headers.get('X-Export-Rows'), '0');
    await foreignFilter.arrayBuffer();
  });

  await t.test('Hindi CRM, placements and change proposals cannot use a hidden sibling as the target', async () => {
    const ask = async (message) => (await xyz('POST', '/agent/ask', { message, projectName: A, language: 'hi' })).data;
    for (const command of ['कितने कर्मचारी हैं?', 'बेंच पर कौन है?', 'GIG-88001 का सीआरएम खोलें', 'GIG-88003 को हार्ड ब्लॉक करें']) {
      const denied = await ask(`${B} में ${command}`);
      assert.equal(denied.kind, 'denied'); assert.ok(!denied.crm && !denied.table && !denied.proposal && !denied.data);
    }
    assert.equal((await ask(`${A} में सी आर एम खोलें।`)).kind, 'crm_lookup');
    const found = await ask(`${A} में GIG डैश आठ आठ शून्य शून्य एक का सीआरएम खोलें`);
    assert.equal(found.kind, 'crm'); assert.equal(found.crm.assignmentId, one.assignmentId); assert.equal(found.crm.projectName, A);
    assert.equal(found.crm.name, q.get('SELECT name FROM employees WHERE id=?', one.employeeId).name, 'review speaks the real employee name, not a missing workbook column');
    assert.match(found.reply, /बदलाव की समीक्षा/); assert.ok(found.crm.fields.some((f) => f.key === 'detail_comments' && f.editable));
    assert.equal((await ask(`प्लेसमेंट ${sharedOther.assignmentId} का CRM खोलें`)).kind, 'crm_lookup');
    assert.equal((await ask(`प्लेसमेंट ${one.assignmentId} का CRM खोलें`)).crm.assignmentId, one.assignmentId);
    assert.equal((await ask('GIG-88003 को हार्ड ब्लॉक करें')).proposal, null);
    const proposed = await ask('GIG-88001 को हार्ड ब्लॉक करें');
    assert.equal(proposed.proposal.assignmentId, one.assignmentId); assert.equal(proposed.proposal.status, 'pending');
    assert.notEqual((await xyz('GET', `/employees/${one.assignmentId}`)).data.record.values.block_status, 'Hard Block');
  });

  await t.test('voice CRM resolves an exact placement and confirmed submit rechecks scope, fields, revision and permissions', async () => {
    const opened = await xyz('POST', '/agent/ask', { message: `Open C R M for G I G dash 88001 in ${A}` });
    assert.equal(opened.status, 200); assert.equal(opened.data.kind, 'crm');
    const form = opened.data.crm;
    assert.equal(form.assignmentId, one.assignmentId, 'not the second placement in the hidden sibling project');
    assert.equal(form.projectName, A); assert.ok(form.fields.some((f) => f.key === 'detail_comments' && f.editable));
    assert.ok(!form.fields.some((f) => ['giga_project_name','emp_code'].includes(f.key)));
    const url = `/employees/${form.assignmentId}/submit`;
    const body = { crmProjectName: A, changes: { detail_comments: 'Dictated confirmed note' }, rev: form.rev };
    assert.equal((await xyz('POST', url, { ...body, rev: null })).status, 422);
    assert.equal((await xyz('POST', url, { ...body, changes: { giga_project_name: B } })).status, 403);
    assert.equal((await xyz('POST', url, { ...body, crmProjectName: B })).status, 403);
    assert.equal((await xyz('POST', `/employees/${sharedOther.assignmentId}/submit`, body)).status, 403);
    const ok = await xyz('POST', url, body);
    assert.equal(ok.status, 200); assert.equal(ok.data.record.values.detail_comments, body.changes.detail_comments);
    assert.equal((await xyz('POST', url, body)).status, 409);
    assert.equal((await admin('PUT', accessPath, { gigaProjectName: A, capabilities: { ...caps, 'crm.use': false } })).status, 200);
    assert.equal((await xyz('POST', '/agent/ask', { message: 'Open CRM for GIG-88001' })).data.kind, 'denied');
    assert.equal((await xyz('POST', '/agent/ask', { language: 'hi', message: 'GIG-88001 का सीआरएम खोलें' })).data.kind, 'denied');
    assert.equal((await xyz('POST', url, { ...body, rev: ok.data.record.rev })).status, 403);
    assert.equal((await admin('PUT', accessPath, { gigaProjectName: A, capabilities: caps })).status, 200);
  });

  await t.test('guided requests clarify the project, employee and exact placement; choices cannot change scope or person', async () => {
    const message = 'Update the interview note';
    assert.equal((await admin('POST', '/agent/ask', { message })).data.kind, 'choose_project');
    const ask = async (message, guideChoice, language = 'en') => (await xyz('POST', '/agent/ask', { message, projectName: A, language, guideChoice })).data;
    assert.equal((await ask(message)).guide.step, 'person');
    const miss = 'Update the interview note for QA-99999';
    assert.equal((await ask(miss)).guide.step, 'person');
    assert.equal((await ask(miss, { person: 'GIG-88001' })).crm.assignmentId, one.assignmentId);
    // Case/spoken aliases may refer to several distinct workbook names. An
    // old picker value must not decide which one, even for an administrator.
    tag(sharedOther.assignmentId, A.toLowerCase());
    try {
      const goal = { message: 'Update the interview note for GIG-88001 in ' + A.toUpperCase(), projectName: A };
      const ambiguous = (await admin('POST', '/agent/ask', goal)).data;
      assert.ok(ambiguous.ambiguousProject); assert.ok(!ambiguous.crm);
      assert.equal((await admin('POST', '/agent/ask', { ...goal, projectPicked: true })).data.crm.assignmentId, one.assignmentId);
      assert.ok(!(await admin('POST', '/agent/ask', { ...goal, projectName: B, projectPicked: true })).data.crm);
    } finally { tag(sharedOther.assignmentId, B); }
    assert.equal((await ask(`Update the note for GIG-88001 in ${B}`)).kind, 'denied');
    assert.equal((await ask(`${B} में GIG-88001 की टिप्पणी अपडेट करें`, null, 'hi')).kind, 'denied');
    assert.ok(!(await ask(message, { person: 'GIG-88003' })).crm);
    assert.equal((await xyz('POST', '/agent/ask', { message, guideChoice: { person: [], placementId: -1 } })).status, 422);
    tag(sharedOther.assignmentId, A);
    try {
      const lookup = await ask(message, { person: 'GIG-88001' });
      assert.equal(lookup.guide.step, 'placement');
      assert.deepEqual(lookup.table.rows.map(([id]) => id).sort((a,b) => a-b), [one.assignmentId, sharedOther.assignmentId].sort((a,b) => a-b));
      const request = `For GIG-88001 in ${A}, set the interview note to Ready for an interview in May and account owner to Mira`;
      const chosen = await ask(request, { person: '', placementId: one.assignmentId });
      assert.equal(chosen.crm.assignmentId, one.assignmentId); assert.equal(chosen.crm.projectName, A);
      assert.deepEqual(chosen.guide, { step: 'form', instruction: 'the interview note to Ready for an interview in May and account owner to Mira' });
      assert.equal(chosen.crm.fields.find(f => f.key === 'block_status').editable, false);
      const hi = await ask(`${A} में GIG-88001 की टिप्पणी में साक्षात्कार के लिए तैयार लिखें`, { person: '', placementId: one.assignmentId }, 'hi');
      assert.equal(hi.crm.assignmentId, one.assignmentId); assert.equal(hi.guide.instruction, 'टिप्पणी में साक्षात्कार के लिए तैयार');
      for (const placementId of [two.assignmentId, other.assignmentId]) assert.ok(!(await ask(request, { person: 'GIG-88002', placementId })).crm);
    } finally { tag(sharedOther.assignmentId, B); }
  });

  await t.test('guided review is read-only; confirmation binds the session, exact values, placement, live grants and revision', async (t) => {
    const id = one.assignmentId, open = () => xyz('POST', '/agent/ask', { message: 'Update the note for GIG-88001', projectName: A });
    const field = 'detail_comments';
    const getBody = async () => {
      const { data: { crm } } = await open();
      return { crmProjectName: A, rev: crm.rev, before: { [field]: String(crm.fields.find(f => f.key === field).value) }, changes: { [field]: 'Reviewed in the guided conversation' } };
    };
    const review = (body) => xyz('POST', `/agent/crm/${id}/review`, body), confirm = (body) => xyz('POST', `/agent/crm/${id}/confirm`, body);
    const audited = () => q.get("SELECT COUNT(*) n FROM audit_log WHERE entity='assignment' AND entity_id=? AND field_key=? AND action='update'", id, field).n;
    const initial = audited(), body = await getBody();
    const date = 'billing_start_date', oldDate = (await open()).data.crm.fields.find(f => f.key === date).value;
    assert.equal((await review({ ...body, changes: { ...body.changes, [date]: '2027-02-30' }, before: { ...body.before, [date]: oldDate } })).status, 422);
    assert.equal((await confirm(body)).status, 409);
    assert.equal((await review({ ...body, crmProjectName: B })).status, 403);
    assert.equal((await review({ ...body, changes: { block_status: 'Hard Block' } })).status, 403);
    assert.equal((await review({ ...body, changes: { giga_project_name: B } })).status, 403);
    assert.equal((await review({ ...body, before: { [field]: 'different baseline' } })).status, 409);
    const receipt = await review(body); assert.equal(receipt.status, 200); assert.ok(Date.parse(receipt.data.expiresAt) > Date.now());
    const { fields, action, module: targetModule } = receipt.data.interpretation;
    assert.equal(action, 'UPDATE'); assert.equal(targetModule, 'employee_crm');
    assert.deepEqual(fields.map(({ key, before, after }) => [key, before, after]), [[field, body.before[field], body.changes[field]]]);
    assert.equal((await admin('POST', `/agent/crm/${id}/confirm`, { ...body, ticket: receipt.data.ticket })).status, 409);
    let ticket = (await review(body)).data.ticket;
    assert.equal((await confirm({ ...body, ticket: receipt.data.ticket })).status, 409, 'superseded review');
    assert.equal((await confirm({ ...body, changes: { [field]: 'not reviewed' }, ticket })).status, 409);
    assert.equal((await confirm({ ...body, ticket })).status, 409, 'receipt already consumed');
    ticket = (await review(body)).data.ticket;
    const future = Date.now() + 6 * 60_000, clock = t.mock.method(Date, 'now', () => future);
    try { assert.equal((await confirm({ ...body, ticket })).data.code, 'REVIEW_AGAIN'); } finally { clock.mock.restore(); }
    ticket = (await review(body)).data.ticket;
    assert.equal((await xyz('POST', `/agent/crm/${two.assignmentId}/confirm`, { ...body, ticket })).status, 409);
    ticket = (await review(body)).data.ticket;
    await admin('PUT', accessPath, { gigaProjectName: A, capabilities: { ...caps, 'crm.use': false } });
    assert.equal((await confirm({ ...body, ticket })).status, 403);
    await admin('PUT', accessPath, { gigaProjectName: A, capabilities: caps });
    ticket = (await review(body)).data.ticket;
    await admin('PATCH', `/employees/${id}`, { rev: body.rev, changes: { account_name: 'Changed while reviewing' } });
    assert.equal((await confirm({ ...body, ticket })).status, 409);
    assert.equal(audited(), initial); // plans and refused confirmations did not edit the field
    const latest = await getBody(); ticket = (await review(latest)).data.ticket;
    const success = await confirm({ ...latest, ticket }); assert.equal(success.status, 200, JSON.stringify(success.data));
    assert.equal(success.data.record.values[field], latest.changes[field]); assert.equal(audited(), initial+1);
    assert.equal((await confirm({ ...latest, ticket })).status, 409);
    const audit = q.get('SELECT actor_name, meta FROM audit_log WHERE entity_id=? AND field_key=? ORDER BY id DESC LIMIT 1', id, field);
    assert.equal(audit.actor_name, account.name); assert.match(audit.meta, /Confirmed guided CRM update/);
  });

  await t.test('Ask how-to uses the user’s real permissions and does not perform an import, proposal or workforce edit', async () => {
    const message = 'How do I import a workbook?';
    const help = (await xyz('POST', '/agent/ask', { message })).data;
    assert.equal(help.kind, 'howto'); assert.equal(help.source, 'Data Hub');
    assert.match(help.reply, /does not permit/); assert.ok(!help.crm && !help.proposal && !help.data);
    assert.match((await admin('POST', '/agent/ask', { message })).data.reply, /Apply import/);
    assert.equal((await xyz('POST', '/agent/ask', { message: 'मंज़ूरी कैसे मिलती है?', language: 'hi' })).data.source, 'Ask');
  });

  await t.test('Edit access replaces the grant immediately; disappearing names and revocation fail closed', async () => {
    for (const invalid of [{ gigaProjectName: 'invented' }, { gigaProjectName: [A,B] }, { projects: [{ project_id: p.project_id }] },
      { gigaProjectName: B, capabilities: { 'import.data': true } }]) {
      assert.equal((await admin('PUT',accessPath,invalid)).status, 422);
      assert.deepEqual(await ids(), expected, 'no partial change after a failed edit');
    }
    assert.equal((await admin('PUT',accessPath,{ gigaProjectName: B, capabilities: { 'employee.edit': false } })).status, 200);
    assert.equal((await xyz('GET','/auth/me')).data.user.gigaAccess.name, B, 'same signed-in session, no re-login');
    assert.deepEqual(await ids(), [other.assignmentId, sharedOther.assignmentId].sort((a,b) => a-b));
    assert.equal((await xyz('GET', `/employees/${one.assignmentId}`)).status, 403);
    assert.equal((await xyz('PATCH', `/employees/${other.assignmentId}`, { changes: { remarks: 'no' } })).status, 403);
    for (const row of [other, sharedOther]) tag(row.assignmentId, 'A different Giga project');
    assert.deepEqual(await ids(), []);
    assert.equal((await xyz('GET','/projects')).data.projects.length, 0);
    tag(blank.assignmentId, B); // subsequent imports/reclassifications change membership without changing the grant
    assert.deepEqual(await ids(), [blank.assignmentId]);
    assert.equal((await admin('PUT',accessPath,{ gigaProjectName: null })).status, 200);
    assert.deepEqual(await ids(), []);
    assert.equal((await xyz('GET','/bootstrap')).data.totals.assignments, 0);
    assert.deepEqual((await xyz('GET','/agent/projects')).data.projectNames, []);
    assert.equal((await xyz('POST','/agent/ask',{ message: 'How many on bench?', projectName: A })).data.kind, 'denied');
    assert.equal((await xyz('GET', `/employees/${blank.assignmentId}`)).status, 403);
    assert.equal((await xyz('GET','/export')).status, 403);
    assert.deepEqual((await admin('GET','/users')).data.users.find((u)=>u.email===email).gigaAccess, { name: null });
  });

  await t.test('converting a hierarchy account replaces its grants, not the account or other users’ access', async () => {
    const legacy = await admin('POST', '/users', {
      name: 'Former uploader', email: 'old-grants@example.test', password,
      projects: [{ project_id: p.project_id }], capabilities: { 'import.data': true, 'employee.edit': true },
    });
    const id = legacy.data.user.id;
    q.run('INSERT INTO user_subprojects (user_id, subproject_id) VALUES (?, ?)', id, p.subproject_id);
    const session = client(await login('old-grants@example.test', password));
    assert.equal((await session('GET', '/auth/me')).data.user.gigaAccess, null);
    assert.equal((await session('GET', `/employees/${blank.assignmentId}`)).status, 200);
    assert.equal((await admin('PUT', `/users/${id}/access`, { gigaProjectName: A })).status, 200);
    assert.equal((await session('GET', `/employees/${blank.assignmentId}`)).status, 403);
    assert.equal((await session('GET', `/employees/${two.assignmentId}`)).status, 200);
    assert.equal((await session('GET', '/auth/me')).data.user.capabilities['import.data'], false);
    assert.equal(q.get('SELECT count(*) c FROM user_projects WHERE user_id = ?', id).c, 0);
    assert.equal(q.get('SELECT count(*) c FROM user_subprojects WHERE user_id = ?', id).c, 0);
    assert.deepEqual(await ids(), [], 'XYZ remains revoked');
    assert.equal((await admin('DELETE', `/users/${id}`)).status, 200);
    assert.equal((await session('GET', '/auth/me')).status, 401);
    assert.equal(q.get('SELECT count(*) c FROM user_giga_access WHERE user_id = ?', id).c, 0);
    assert.equal((await admin('GET', `/employees/${one.assignmentId}`)).status, 200);
  });
});


test('Directory totals follow the full filtered result, not bootstrap or the current page', async () => {
  const admin = client(await login('admin@resourceplanning.io', 'Admin@12345'));
  const places = q.all(`SELECT c.id category_id, c.subproject_id, s.project_id FROM categories c
                        JOIN subprojects s ON s.id = c.subproject_id ORDER BY c.id`);
  const east = places[0], west = places.find((p) => p.project_id !== east.project_id);
  const north = 'Directory North', south = 'Directory South';
  const place = async (n, hierarchy, giga, billing) => {
    const r = await admin('POST', '/employees', { ...hierarchy, emp_code: `DSYNC-${n}`, name: `Directory worker ${n}` });
    assert.equal(r.status, 200);
    for (const [key, value] of [['giga_project_name', giga], ['billing_status', billing]]) {
      if (value) q.run('INSERT INTO assignment_values (assignment_id, field_id, value) SELECT ?, id, ? FROM fields WHERE key = ?',
        r.data.assignmentId, value, key);
    }
    return r.data.employeeId;
  };
  const first = await place(1, east, north, 'Billable');
  for (let i = 2; i <= 5; i++) await place(i, east, north, i === 2 ? 'Billable' : 'Shadow');
  await place(1, west, north, 'Billable'); // same person, second matching placement
  const sixth = await place(6, west, south, 'Billable');
  await place(7, east, null, 'Billable'); // blank Giga still counts as a person/placement
  const review = (candidate, incoming, status = 'pending') => q.run(
    'INSERT INTO duplicate_reviews (candidate_employee_id, emp_code, status) VALUES (?, ?, ?)', candidate, incoming, status);
  review(first, 'DSYNC-2'); // both sides match, still only one ticket
  review(sixth, 'DSYNC-7');
  review(null, 'dsync-3'); // incoming employee only
  review(first, 'DSYNC-2', 'dismissed');

  const query = async (filters = {}) => {
    const params = new URLSearchParams({ includeSummary: '1', pageSize: '5', search: 'DSYNC-', ...filters });
    const r = await admin('GET', `/employees?${params}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.summary.placements, r.data.total, 'Placements and Employee records must agree');
    return r.data;
  };
  const all = await query();
  assert.deepEqual(all.summary, { people: 7, placements: 8, hierarchyProjects: 2, gigaProjects: 2, pendingReviews: 3 });
  const headcount = await admin('POST', '/agent/ask', { message: `How many people in ${north}?` });
  assert.equal(headcount.data.data.count, 5, 'a person with two matching placements is counted once');
  assert.equal((await admin('POST', '/agent/ask', { message: `Open CRM for DSYNC-1 in ${north}` })).data.kind, 'crm_lookup');
  const filtered = await query({ f_giga_project_name: north });
  assert.equal(filtered.rows.length, 5);
  assert.deepEqual(filtered.summary, { people: 5, placements: 6, hierarchyProjects: 2, gigaProjects: 1, pendingReviews: 2 });
  const secondPage = await query({ f_giga_project_name: north, page: '2' });
  assert.equal(secondPage.rows.length, 1);
  assert.deepEqual(secondPage.summary, filtered.summary);
  const stacked = { f_giga_project_name: north, f_billing_status: 'Billable' };
  assert.deepEqual((await query(stacked)).summary, { people: 2, placements: 3, hierarchyProjects: 2, gigaProjects: 1, pendingReviews: 1 });
  assert.deepEqual((await query({ ...stacked, projectId: west.project_id })).summary,
    { people: 1, placements: 1, hierarchyProjects: 1, gigaProjects: 1, pendingReviews: 1 });
  assert.deepEqual((await query({ ...stacked, search: 'DSYNC-6' })).summary,
    { people: 0, placements: 0, hierarchyProjects: 0, gigaProjects: 0, pendingReviews: 0 });
  assert.deepEqual((await query()).summary, all.summary, 'clearing filters restores totals for the remaining search');
});
