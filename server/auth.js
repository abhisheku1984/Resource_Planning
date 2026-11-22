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
      WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`,
    token
  );
  if (!row) return null;
  return hydrateUser(row);
}

module.exports = { ...permissions, hashPassword, verifyPassword, createSession, destroySession, userFromToken };
