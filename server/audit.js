'use strict';
const { q, tx } = require('./db');

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

function historyFor(entity, entityId, limit = 100) {
  return q.all(
    `SELECT id, entity, entity_id, ref, action, field_key, old_value, new_value, actor_name, at
       FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?`,
    entity,
    entityId,
    limit
  );
}

/** Recent activity feed, restricted to the projects a supervisor can see. */
function recentActivity({ projectIds = null, limit = 25 } = {}) {
  const rows = q.all(
    `SELECT a.id, a.entity, a.entity_id, a.ref, a.action, a.field_key, a.old_value, a.new_value,
            a.actor_name, a.at, asg.project_id
       FROM audit_log a
       LEFT JOIN assignments asg
         ON (a.entity = 'assignment' AND asg.id = a.entity_id)
         OR (a.entity = 'employee' AND asg.employee_id = a.entity_id)
      GROUP BY a.id
      ORDER BY a.id DESC LIMIT ?`,
    limit * 6
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (projectIds && r.project_id && !projectIds.includes(r.project_id)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { record, historyFor, recentActivity, tx };
