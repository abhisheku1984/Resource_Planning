'use strict';
const { q, tx } = require('./db');
const { assignmentScope } = require('./access');

/**
 * Append-only audit trail. Every mutation funnels through here so the UI can
 * show "who changed what, when" for employees, CRM edits and configuration.
 */
function record({ entity, entityId = null, ref = null, action, fieldKey = null, oldValue = null, newValue = null, actor = null, meta = null }) {
  q.run(
    `INSERT INTO audit_log (entity, entity_id, ref, action, field_key, old_value, new_value, actor_id, actor_name, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entity,
    entityId,
    ref,
    action,
    fieldKey,
    oldValue === null || oldValue === undefined ? null : String(oldValue),
    newValue === null || newValue === undefined ? null : String(newValue),
    actor ? actor.id : null,
    actor ? actor.name : 'system',
    meta ? JSON.stringify(meta) : null
  );
}

// Configuration, import and account events have no workforce row to authorize.
// Only admins see those; never treat a NULL project or an entity filter as a grant.
function auditScope(user) {
  if (user.isAdmin) return { sql: '1', args: [] };
  const acl = assignmentScope(user);
  return {
    sql: `((l.entity = 'assignment' AND l.entity_id IN (SELECT a.id FROM assignments a WHERE ${acl.sql})) OR
           (l.entity = 'employee' AND l.entity_id IN (SELECT a.employee_id FROM assignments a WHERE ${acl.sql})))`
      + (user.gigaAccess ? " AND l.field_key IS NOT 'giga_project_name'" : ''),
    args: [...acl.args, ...acl.args],
  };
}

function recentActivity(user, { limit = 25, entity, entityId } = {}) {
  const { sql, args } = auditScope(user);
  const where = [sql];
  if (entity != null) { where.push('l.entity = ?'); args.push(entity); }
  if (entityId != null) { where.push('l.entity_id = ?'); args.push(entityId); }
  return q.all(`SELECT id, entity, entity_id, ref, action, field_key, old_value, new_value, actor_name, at
                  FROM audit_log l WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...args, limit);
}

module.exports = { record, auditScope, recentActivity, tx };
