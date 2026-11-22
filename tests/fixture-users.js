'use strict';
const { randomBytes } = require('node:crypto');

// Called only after the test has selected its own temporary database. Sample
// rows have no usable password; give each test identity a per-run credential.
function seedTestUsers() {
  const { q } = require('../server/db');
  const { hashPassword } = require('../server/auth');
  require('../server/seed').run({ quiet: true });
  const passwords = new Map();
  for (const { id, email } of q.all('SELECT id, email FROM users')) {
    const password = randomBytes(24).toString('hex');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    passwords.set(email, password);
  }
  return passwords;
}
module.exports = { seedTestUsers };
