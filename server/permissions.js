'use strict';
const { q } = require('./db');
const { gigaGrant, GIGA_CAPABILITIES } = require('./access');

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

/** Effective capabilities in the session and in the admin access editor. */
function capabilitiesFor(user, grant) {
  const saved = new Map(q.all('SELECT capability, allowed FROM user_capabilities WHERE user_id = ?', user.id)
    .map((r) => [r.capability, !!r.allowed]));
  return Object.fromEntries(ALL_CAPABILITIES.map((key) => {
    const allowed = grant ? !!grant.name && GIGA_CAPABILITIES.includes(key) && (key === 'project.view' || !!saved.get(key)) : !!saved.get(key);
    return [key, user.role === 'admin' || allowed];
  }));
}

/** Attach role, capabilities and project grants to a raw users row. */
function hydrateUser(row) {
  const gigaAccess = row.role === 'admin' ? null : gigaGrant(row.id);
  const capabilities = capabilitiesFor(row, gigaAccess);
  const projects = gigaAccess ? q.all(
    `SELECT id, code, name, ? AS can_edit, ? AS can_export, ? AS can_crm FROM projects
      WHERE id IN (SELECT project_id FROM giga_assignments WHERE project_name = ?) ORDER BY name`,
    Number(capabilities['employee.edit']), Number(capabilities['export.data']), Number(capabilities['crm.use']), gigaAccess.name
  ) : q.all(
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
    gigaAccess,
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

module.exports = { ALL_CAPABILITIES, hydrateUser, capabilitiesFor, projectGrant, can, visibleProjectIds };
