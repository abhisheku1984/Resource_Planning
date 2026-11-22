'use strict';
// Host-console setup only. There is deliberately no HTTP setup or recovery route.
const { q, tx, DB_FILE, newDatabase } = require('./db');
const auth = require('./auth');
const { record } = require('./audit');

function activeAdmins() {
  return q.all("SELECT id, password_hash FROM users WHERE active = 1 AND role = 'admin' ORDER BY id");
}
function hasPrivateAdmin(admins) {
  // The empty hash denotes a fictional, non-signable fixture account.
  return admins.some(u => u.password_hash && !auth.hasDemoHash(u.password_hash));
}

function configureAdmin({ name, email, password }) {
  name = name.trim(); email = auth.loginEmail(email);
  if (!name || name.length > 160) throw Error('Enter a display name of 1–160 characters.');
  auth.checkNewPassword(password);

  tx(() => {
    // Check again under the write lock. A second terminal cannot overwrite a
    // just-configured account, and this is not a reset for private passwords.
    const admins = activeAdmins();
    if (hasPrivateAdmin(admins)) throw Error('A private administrator already exists. Use Users & access to manage accounts.');
    const existing = q.get('SELECT id FROM users WHERE lower(email) = lower(?)', email);
    if (existing && !admins.some(u => u.id === existing.id)) throw Error('That email is already assigned. Choose another email.');
    const target = existing || admins[0];
    const hash = auth.hashPassword(password);
    let id;
    if (target) {
      // Upgrade the stranded admin in place: retain ID, authorship and grants.
      id = target.id;
      q.run('UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?', name, email, hash, id);
      q.run('DELETE FROM sessions WHERE user_id = ?', id);
    } else {
      id = Number(q.run("INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'admin', ?)", name, email, hash).lastInsertRowid);
    }
    record({ entity: 'user', entityId: id, action: target ? 'update' : 'create', actor: { id, name }, newValue: 'Administrator configured on host' });
  });
}

async function promptForAdmin() {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) throw Error('Private administrator setup required. Run the launcher or npm run setup:admin in a terminal on the host, using the same database, then restart.');
  const { Writable } = require('node:stream');
  const { createInterface } = require('node:readline/promises');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (hidden) done(); else stdout.write(chunk, encoding, done); } });
  const rl = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  const abort = new AbortController();
  rl.once('SIGINT', () => rl.close());
  rl.once('close', () => abort.abort());
  async function ask(label, secret = false) {
    if (secret) stdout.write(label);
    hidden = secret;
    try { return await rl.question(secret ? '' : label, { signal: abort.signal }); }
    finally { hidden = false; if (secret) stdout.write('\n'); }
  }
  try {
    console.log(`Set up your private administrator for ${DB_FILE}. This is only asked on the host.\nUse an email and password that you have not shared. Passwords will not be displayed.`);
    const name = await ask('Your display name: ');
    const email = await ask('Your sign-in email: ');
    const password = await ask('New password (at least 8 characters): ', true);
    if (await ask('Confirm password: ', true) !== password) throw Error('Passwords did not match. Run the launcher again; no credentials were changed.');
    return { name, email, password };
  } catch (err) {
    if (abort.signal.aborted) throw Error('Setup cancelled. No credentials were changed.');
    throw err;
  } finally { rl.close(); }
}

async function initializePrivateApp(prompt = promptForAdmin) {
  // Only create starter data for a brand-new file. An existing (even empty)
  // roster is never a reason to reseed, reset accounts or restore deleted users.
  if (newDatabase && !q.get('SELECT 1 FROM projects LIMIT 1') && !q.get('SELECT 1 FROM users LIMIT 1')) {
    require('./seed').run({ quiet: true, sampleAccounts: false });
  } else {
    require('./schema').seedFields();
  }
  if (!hasPrivateAdmin(activeAdmins())) configureAdmin(await prompt());
}

if (require.main === module) initializePrivateApp().then(() => console.log('Private sign-in is ready.')).catch(err => {
  console.error('[setup]', err.message); process.exitCode = 1;
});
module.exports = { initializePrivateApp };
