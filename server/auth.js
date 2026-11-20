'use strict';
const crypto = require('node:crypto');
const { q } = require('./db');

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

const ALL_CAPABILITIES = [
  'project.view',
  'project.manage',
  'employee.edit',
  'employee.create',
  'crm.use',
  'export.data',
  'import.data',
  'schema.manage',
  'users.manage',
  'audit.view',
];

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

/** Attach role, capabilities and project grants to a raw users row. */
function hydrateUser(row) {
  const capabilities = {};
  for (const cap of ALL_CAPABILITIES) capabilities[cap] = row.role === 'admin';
  for (const r of q.all('SELECT capability, allowed FROM user_capabilities WHERE user_id = ?', row.id)) {
    capabilities[r.capability] = row.role === 'admin' ? true : !!r.allowed;
  }
  const projects = q.all(
    `SELECT p.id, p.code, p.name, up.can_edit, up.can_export, up.can_crm
       FROM user_projects up JOIN projects p ON p.id = up.project_id
      WHERE up.user_id = ?`,
    row.id
  );
  const subprojectIds = q.all('SELECT subproject_id FROM user_subprojects WHERE user_id = ?', row.id)
    .map((r) => r.subproject_id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    title: row.title,
    isAdmin: row.role === 'admin',
    capabilities,
    projects: row.role === 'admin'
      ? q.all('SELECT id, code, name, 1 AS can_edit, 1 AS can_export, 1 AS can_crm FROM projects WHERE active = 1 ORDER BY name')
      : projects,
    subprojectIds,
  };
}

/** Effective permission flags for a user on one project. */
function projectGrant(user, projectId) {
  if (!user) return null;
  if (user.isAdmin) return { can_edit: 1, can_export: 1, can_crm: 1 };
  return user.projects.find((p) => p.id === Number(projectId)) || null;
}

function can(user, capability) {
  if (!user) return false;
  if (user.isAdmin) return true;
  return !!user.capabilities[capability];
}

/** Project ids the user may read (admins: all). */
function visibleProjectIds(user) {
  if (!user) return [];
  if (user.isAdmin) return q.all('SELECT id FROM projects').map((r) => r.id);
  return user.projects.map((p) => p.id);
}

module.exports = {
  ALL_CAPABILITIES,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userFromToken,
  hydrateUser,
  projectGrant,
  can,
  visibleProjectIds,
};
