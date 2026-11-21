'use strict';
/**
 * Proposal storage and the approval path.
 *
 * A proposal freezes the exact field values at the moment it was raised. When an
 * administrator approves, the write only proceeds if the row still holds those
 * same values - otherwise the proposal is marked `stale` instead of silently
 * overwriting a change someone else made in the meantime.
 *
 * Every approval writes to the audit log under the approver's name, and records
 * the requester, so "who changed this, when, and on whose request" survives.
 */
const { q } = require('./db');
const schema = require('./schema');
const emp = require('./employees');
const { record } = require('./audit');

function raiseProposal(user, proposal, message) {
  const fields = schema.listFields();
  const before = {};
  const after = {};
  for (const key of Object.keys(proposal.changes)) {
    const f = fields.find((x) => x.key === key);
    if (!f) continue;
    before[key] = proposal.changes[key].from === undefined ? null : proposal.changes[key].from;
    after[key] = proposal.changes[key].to;
  }

  const r = q.run(
    `INSERT INTO agent_actions
       (kind, assignment_id, summary, before_json, after_json, status, requested_by, requested_by_name)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    proposal.kind, proposal.assignmentId, proposal.summary,
    JSON.stringify(before), JSON.stringify(after), user.id, user.name
  );

  record({
    entity: 'assignment', entityId: proposal.assignmentId, ref: proposal.ref,
    action: 'agent_propose', actor: { id: user.id, name: user.name },
    meta: { actionId: Number(r.lastInsertRowid), summary: proposal.summary, message },
  });

  return loadProposal(Number(r.lastInsertRowid));
}

function loadProposal(id) {
  const row = q.get('SELECT * FROM agent_actions WHERE id = ?', Number(id));
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    assignmentId: row.assignment_id,
    summary: row.summary,
    before: JSON.parse(row.before_json || '{}'),
    after: JSON.parse(row.after_json || '{}'),
    status: row.status,
    requestedBy: row.requested_by_name,
    requestedAt: row.created_at,
    decidedBy: row.decided_by_name,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

function listProposals(status) {
  const rows = status
    ? q.all('SELECT id FROM agent_actions WHERE status = ? ORDER BY id DESC LIMIT 100', status)
    : q.all('SELECT id FROM agent_actions ORDER BY id DESC LIMIT 100');
  return rows.map((r) => loadProposal(r.id));
}

/** Has the underlying record moved since the proposal was raised? */
function currentValues(assignmentId, keys) {
  const fields = schema.listFields();
  const out = {};
  for (const key of keys) {
    const f = fields.find((x) => x.key === key);
    if (!f) continue;
    const row = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', assignmentId, f.id);
    out[key] = row ? row.value : null;
  }
  return out;
}

function approve(actor, id, note) {
  const proposal = loadProposal(id);
  if (!proposal) throw Object.assign(new Error('Proposal not found.'), { status: 404 });
  if (proposal.status !== 'pending') {
    throw Object.assign(new Error(`This proposal is already ${proposal.status}.`), { status: 409, code: 'NOT_PENDING' });
  }

  const keys = Object.keys(proposal.after);
  const now = currentValues(proposal.assignmentId, keys);
  const drift = keys.filter((k) => String(now[k] === undefined ? null : now[k]) !== String(proposal.before[k] === undefined ? null : proposal.before[k]));

  if (drift.length) {
    q.run(
      "UPDATE agent_actions SET status = 'stale', decided_by = ?, decided_by_name = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?",
      actor.id, actor.name, note || 'Record changed before approval', id
    );
    throw Object.assign(
      new Error('The record changed after this was proposed, so it was not applied. Ask again to get a fresh proposal.'),
      { status: 409, code: 'STALE', drifted: drift, current: loadProposal(id) }
    );
  }

  // NB: updateAssignment opens its own transaction; nesting BEGIN IMMEDIATE
  // inside it throws "cannot start a transaction within a transaction".
  const updated = emp.updateAssignment(actor, proposal.assignmentId, proposal.after, {
    expectedRev: null, source: 'manual', reason: 'Assistant proposal approved',
  });
  q.run(
    "UPDATE agent_actions SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = datetime('now'), decision_note = ?, result_json = ? WHERE id = ?",
    actor.id, actor.name, note || null, JSON.stringify({ assignmentId: proposal.assignmentId }), id
  );
  const result = updated;

  record({
    entity: 'assignment', entityId: proposal.assignmentId, ref: proposal.summary,
    action: 'agent_approve', actor: { id: actor.id, name: actor.name },
    meta: { actionId: id, requestedBy: proposal.requestedBy, changes: proposal.after },
  });

  return { proposal: loadProposal(id), record: result };
}

function reject(actor, id, note) {
  const proposal = loadProposal(id);
  if (!proposal) throw Object.assign(new Error('Proposal not found.'), { status: 404 });
  if (proposal.status !== 'pending') {
    throw Object.assign(new Error(`This proposal is already ${proposal.status}.`), { status: 409, code: 'NOT_PENDING' });
  }
  q.run(
    "UPDATE agent_actions SET status = 'rejected', decided_by = ?, decided_by_name = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?",
    actor.id, actor.name, note || null, id
  );
  record({
    entity: 'assignment', entityId: proposal.assignmentId, action: 'agent_reject',
    actor: { id: actor.id, name: actor.name }, meta: { actionId: id, note: note || null },
  });
  return loadProposal(id);
}

function pendingCount() {
  return Number(q.get("SELECT COUNT(*) c FROM agent_actions WHERE status = 'pending'").c);
}

module.exports = { raiseProposal, loadProposal, listProposals, approve, reject, pendingCount };
