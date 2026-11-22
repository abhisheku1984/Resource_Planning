'use strict';
const crypto = require('node:crypto');
const { q } = require('./db');
const permissions = require('./permissions');
const { hydrateUser } = permissions;

/** scrypt password hashing — no external deps. */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Historical credentials are public test fixtures, not private credentials.
// Keep this policy in the Node auth module; it is not shipped in browser JS.
const demoPasswords = ['Admin@12345', 'Super@12345', 'Hr@1234567'];
const hasDemoHash = hash => demoPasswords.some(password => verifyPassword(password, hash));
// A missing/inactive account should not skip the expensive comparison and
// advertise whether that email exists. No fallback hash can grant a session.
const missingHash = `${'00'.repeat(16)}:${'00'.repeat(64)}`;
function acceptsLogin(password, stored) {
  if (typeof password !== 'string' || demoPasswords.includes(password)) return false;
  return verifyPassword(password, stored || missingHash) && !!stored;
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || demoPasswords.includes(password)) {
    throw Object.assign(new Error('Choose a private password of at least 8 characters, not a published demo password.'), { status: 422 });
  }
}

const SESSION_DAYS = 7;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  q.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return token;
}

function destroySession(token) {
  q.run('DELETE FROM sessions WHERE token = ?', token);
}

function userFromToken(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND julianday(s.expires_at) > julianday('now') AND u.active = 1`,
    token
  );
  if (!row) return null;
  return hydrateUser(row);
}

module.exports = { ...permissions, hashPassword, verifyPassword, acceptsLogin, hasDemoHash, checkNewPassword, createSession, destroySession, userFromToken };
