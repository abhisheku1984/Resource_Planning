'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Run each launch in a new process, just as the Windows launcher does. Never
// require the installation's DB module in the parent test process.
function installation(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workforce.db');
  const env = { ...process.env, DB_FILE: file, DATA_DIR: dir, RP_SEED_ROWS: '170', HOST: '127.0.0.1' };
  const run = (args, input = '') => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', input, timeout: 10000 });
  return {
    run,
    // Exercise the same validation/transaction as the host console with a test prompt.
    provide: owner => run(['-e', `require('./server/private-setup').initializePrivateApp(async () =>
      JSON.parse(require('node:fs').readFileSync(0, 'utf8'))).catch(e => { console.error(e.message); process.exitCode = 1; })`], JSON.stringify(owner)),
    inspect(fn) { const db = new DatabaseSync(file); try { return fn(db); } finally { db.close(); } },
  };
}
const secret = () => randomBytes(24).toString('hex');
const hash = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const owner = () => ({ name: 'Owner', email: 'owner@example.test', password: secret() });
const success = p => assert.equal(p.status, 0, p.stderr || String(p.error || ''));

test('new private installation: no network claim or default user; host sets the only login', t => {
  const install = installation(t), details = owner();
  const refused = install.run(['server/index.js']);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /setup:admin/);
  assert.doesNotMatch(refused.stdout, /is running/);
  install.inspect(db => assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 0));
  const bad = install.provide({ ...details, password: 'Admin@12345' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /private password/);
  const setup = install.provide(details); success(setup);
  assert.ok(!(setup.stdout + setup.stderr).includes(details.password));
  // Subsequent noninteractive launches need no setup and don't touch a private credential.
  success(install.run(['server/private-setup.js']));
  install.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) n FROM employees').get().n, 170);
    const users = db.prepare('SELECT email,name,role,password_hash FROM users').all();
    assert.equal(users.length, 1);
    const u = users[0]; assert.deepEqual([u.email, u.name, u.role], [details.email, details.name, 'admin']);
    assert.equal(u.password_hash, hash(details.password, u.password_hash.split(':')[0]));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(details.password));
  });
});

test('upgrade: retire old sessions, retain IDs, private users, grants and roster; no resurrection on restart', t => {
  const install = installation(t), details = owner();
  success(install.run(['server/seed.js']));
  const staffEmail = 'sameer.khan@resourceplanning.io', staffHash = hash(secret());
  const snapshot = db => ({
    employees: db.prepare('SELECT id, emp_code, created_by FROM employees ORDER BY id').all(),
    placements: db.prepare('SELECT id, employee_id, updated_by FROM assignments ORDER BY id').all(),
    grants: db.prepare('SELECT * FROM user_projects ORDER BY user_id, project_id').all(),
  });
  const before = install.inspect(db => {
    const admin = db.prepare("SELECT id,email FROM users WHERE role='admin'").get();
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash('Admin@12345'), admin.id);
    db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(staffHash, staffEmail);
    db.exec(`DELETE FROM users WHERE email='arun.pillai@resourceplanning.io';
      INSERT INTO sessions(token,user_id,expires_at) SELECT 'old-' || id,id,'2099-12-31' FROM users;
      PRAGMA user_version=0;`);
    return { admin, data: snapshot(db), users: db.prepare('SELECT count(*) n FROM users').get().n };
  });
  const collision = install.provide({ ...details, email: staffEmail });
  assert.equal(collision.status, 1); assert.match(collision.stderr, /already assigned/);
  success(install.provide(details));
  install.inspect(db => {
    assert.deepEqual(snapshot(db), before.data);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, before.users);
    assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(details.email).id, before.admin.id);
    assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(before.admin.email), undefined);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE email=?').get(staffEmail).password_hash, staffHash);
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES ('after-upgrade',?,'2099-12-31')").run(before.admin.id);
    db.exec('DELETE FROM employees'); // a deliberately empty roster must also stay empty
  });
  success(install.run(['server/private-setup.js']));
  install.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) n FROM employees').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, before.users);
    assert.ok(db.prepare("SELECT 1 FROM sessions WHERE token='after-upgrade'").get());
    assert.ok(!db.prepare("SELECT 1 FROM users WHERE email='arun.pillai@resourceplanning.io'").get());
  });
});

test('a private administrator on an older install is never replaced by setup', t => {
  const install = installation(t), details = owner(), savedHash = hash(details.password);
  success(install.run(['server/seed.js']));
  install.inspect(db => {
    db.prepare("UPDATE users SET password_hash=? WHERE role='admin'").run(hash('Admin@12345'));
    db.prepare("INSERT INTO users(email, name, role, password_hash) VALUES (?, ?, 'admin', ?)").run(details.email, details.name, savedHash);
    db.exec('PRAGMA user_version=0;');
  });
  success(install.run(['server/private-setup.js'])); // no TTY: must not prompt
  success(install.provide({ ...owner(), email: 'unwanted@example.test' }));
  install.inspect(db => {
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE email=?').get(details.email).password_hash, savedHash);
    assert.equal(db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n, 2);
    assert.ok(!db.prepare("SELECT 1 FROM users WHERE email='unwanted@example.test'").get());
  });
});
