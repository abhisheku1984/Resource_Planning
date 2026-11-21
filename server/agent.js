'use strict';
// Offline, deterministic workbook questions. The same named-assignment relation
// drives the project picker, counts, breakdowns, lists, CRM and proposals.
// An explicit but unknown project must NEVER fall back to a broader scope.
const { q } = require('./db');
const { assignmentScope } = require('./access');
const { can } = require('./auth');
const schema = require('./schema');
const { crmForm } = require('./assistant-crm');

const FROM = `FROM giga_assignments g JOIN assignments a ON a.id = g.assignment_id JOIN employees e ON e.id = g.employee_id`;
function visibleProjectNames(user) {
  const acl = assignmentScope(user);
  return q.all(`SELECT DISTINCT g.project_name ${FROM} WHERE ${acl.sql} ORDER BY g.project_name COLLATE NOCASE, g.project_name`, ...acl.args).map((r) => r.project_name);
}
function scopeFor(user, name, flag) {
  const acl = assignmentScope(user, flag);
  return { sql: `g.project_name = ? AND ${acl.sql}`, args: [name, ...acl.args] };
}
const norm = (s) => s.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();
const numbers = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const spoken = (s) => norm(s).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => String(numbers.indexOf(w)));
const choose = (names) => ({ understood: false, kind: 'choose_project', reply: 'Which Giga Project Name? Say or select one of your workbook projects: ' + names.slice(0, 8).join(', ') + '.', suggestions: names.slice(0, 8) });
const unavailable = () => ({ understood: false, kind: 'denied', reply: 'That Giga Project Name is not available in your access. Choose an exact workbook project name; I have not searched any other project.' });
function nameMatches(raw, names) {
  const name = raw.trim();
  if (names.includes(name)) return [name];
  const same = names.filter((s) => norm(s) === norm(name));
  return same.length ? same : names.filter((s) => spoken(s) === spoken(name));
}
function resolve(user, message, selected) {
  const names = visibleProjectNames(user);
  if (!names.length) return { error: { kind: 'denied', reply: 'There are no named workbook placements in your access. Ask an administrator about your Giga project.' } };
  // A project name can itself contain prepositions or punctuation. Test entire
  // clauses, not any matching word or prefix (e.g. Alpha vs Alpha East).
  const text = message.trim().replace(/[.?!]+$/, '').trim();
  let ask = text, explicit = null;
  const select = text.match(/^(?:select|switch to|use)\s+(?:project\s+)?(.+)$/i);
  const prefix = text.match(/^(?:in|for|within)\s+(.+?)[,:]?\s+((?:how many|who|what|list|show|count|break ?down|open|set|mark)\b.*)$/i);
  if (select || nameMatches(text, names).length) { explicit = select ? select[1] : text; ask = ''; }
  else if (prefix) { explicit = prefix[1]; ask = prefix[2]; }
  else {
    const clauses = [...text.matchAll(/\s+(?:in|within|under|from|for|across)\s+/gi)].filter((m) =>
      m[0].trim().toLowerCase() !== 'for' || !/^(?:open|show)\s+(?:the\s+)?c\.?\s*r\.?\s*m\.?$/i.test(text.slice(0, m.index)));
    // Only skip the employee delimiter in "Open CRM for <person>".
    if (clauses.length) {
      const tail = (m) => text.slice(m.index + m[0].length);
      const clause = clauses.find((m) => nameMatches(tail(m), names).length) || clauses.at(-1);
      explicit = tail(clause); ask = text.slice(0, clause.index);
      // Also accept “how many people in <exact name> are on bench?” without
      // treating a longer unseen project name as a shorter, visible sibling.
      const predicate = explicit.match(/^(.+?)\s+(?:are|is)\s+(.+)$/i);
      if (!nameMatches(explicit, names).length && predicate && nameMatches(predicate[1], names).length) {
        explicit = predicate[1]; ask += ' ' + predicate[2];
      }
      if (/^(?:(?:my|this|that|the selected) (?:giga )?projects?)$/i.test(explicit)) explicit = null;
    }
  }
  if (explicit !== null) {
    let hits = nameMatches(explicit, names);
    if (!hits.length) hits = nameMatches(explicit.replace(/^(?:the )?(?:giga )?project(?: name)?\s+/i, ''), names);
    if (hits.length !== 1) return { error: hits.length ? choose(hits) : unavailable() };
    return { name: hits[0], ask };
  }
  if (selected != null && selected !== '') return names.includes(selected) ? { name: selected, ask } : { error: unavailable() };
  return names.length === 1 ? { name: names[0], ask } : { error: choose(names) };
}

const examples = (name) => [`How many are on bench in ${name}?`, `Break down bench category in ${name}`, `Who is on bench in ${name}?`];
const fmt = (n) => n.toLocaleString('en-IN');
const metricText = (s) => norm(s).replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim();
const METRICS = ['bench_category', 'block_status', 'billing_status', 'offsite_onsite', 'bl_status'];
function report(user, name, ask) {
  const t = norm(ask);
  const group = /^(?:break ?down(?: by| of)?|show (?:the )?breakdown(?: by| of)?|group by)\s+/;
  const list = /^(?:who(?: is| are)?|list|show(?: me)?|which people|names of)\b\s*/;
  const count = /^(?:how many|count(?: of)?|(?:what is (?:the )?)?(?:number of|total(?: number of)?|headcount))\b\s*/;
  const verb = [group, list, count].find((r) => r.test(t));
  if (!verb) return null;
  const metric = metricText(t.replace(verb, '').replace(/\b(?:people|employees|associates|resources|are|is|we|do|have|there|currently|on|with|the|our|by)\b/g, ' '));
  const fields = schema.listFields(user).filter((f) => METRICS.includes(f.key));
  const matches = [];
  for (const f of fields) {
    const labels = [metricText(f.label), metricText(f.key.replace(/_/g, ' '))];
    if (labels.includes(metric)) { matches.push({ field: f, value: null }); continue; }
    const val = (f.options || []).find((v) => [metricText(v), ...labels.map((l) => l + ' ' + metricText(v))].includes(metric));
    if (val) matches.push({ field: f, value: val });
    if (f.key === 'bl_status' && /^bl ?\d+$/.test(metric)) matches.push({ field: f, value: 'BL-' + metric.match(/\d+/)[0] });
  }
  if (matches.length > 1) return { kind: 'clarify', reply: `Which field in ${name}: ${matches.map((m) => m.field.label).join(' or ')}? Include the field name in your question.` };
  if (!matches.length && metric) return null; // don't answer an unrecognised filter with headcount
  const { field, value } = matches[0] || { field: fields.find((f) => f.key === 'bench_category'), value: null };
  const scope = scopeFor(user, name);
  const vjoin = ' JOIN assignment_values v ON v.assignment_id = a.id AND v.field_id = ?';
  const from = `${FROM}${value ? vjoin : ''} WHERE ${scope.sql}${value ? ' AND v.value = ?' : ''}`;
  const args = value ? [field.id, ...scope.args, value] : scope.args;
  const subject = value ? ` (${field.label}: ${value})` : '';
  const total = q.get(`SELECT COUNT(DISTINCT e.id) c ${from}`, ...args).c;
  const reply = `${fmt(total)} ${total === 1 ? 'person' : 'people'}${subject} in ${name}.`;
  const data = { count: total, project: name, field: field.key, value };
  if (verb === list) {
    const people = q.all(`SELECT DISTINCT e.emp_code, e.name ${from} ORDER BY e.name, e.emp_code LIMIT 25`, ...args);
    return { kind: 'list', reply: reply + (total > 25 ? ' Showing the first 25.' : ''), data,
      table: { title: 'People · ' + name, columns: ['Employee ID', 'Name', 'Giga Project Name'], rows: people.map((r) => [r.emp_code, r.name, name]) } };
  }
  const buckets = q.all(`SELECT v.value, COUNT(DISTINCT e.id) c ${FROM}${vjoin} WHERE ${scope.sql} AND v.value <> '' GROUP BY v.value ORDER BY c DESC, v.value`, field.id, ...scope.args);
  return { kind: verb === group ? 'breakdown' : 'count', reply, data, table: { title: `${field.label} · ${name}`, columns: [field.label, 'People'], rows: buckets.map((r) => [r.value, fmt(r.c)]) } };
}

function findPlacement(user, name, raw, crm) {
  const scope = scopeFor(user, name, crm ? 'can_crm' : 'can_edit');
  const who = raw.trim().replace(/^employee(?: id)?\s+/i, '');
  const placement = who.match(/^placement\s+(\d+)$/i);
  // Spoken "E M P dash 01042" or "EMP 01042" as well as a literal workbook ID or full name.
  const code = who.replace(/\b(?:dash|hyphen)\b/i, '-').match(/^([a-z](?:\s*[a-z])*)[\s-]+([\d ]+)$/i);
  const rows = q.all(`SELECT a.id, e.name, e.emp_code ${FROM} WHERE ${scope.sql} AND ` + (placement ? 'a.id = ?' :
    '(e.emp_code = ? COLLATE NOCASE OR e.emp_code = ? COLLATE NOCASE OR e.name = ? COLLATE NOCASE)') + ' ORDER BY a.id LIMIT 11',
    ...scope.args, ...(placement ? [Number(placement[1])] : [who, code ? code[1].replace(/\s/g, '') + '-' + code[2].replace(/\s/g, '') : who, who]));
  if (rows.length === 1) return { person: rows[0] };
  const kind = crm ? 'crm_lookup' : 'clarify';
  if (!rows.length) return { error: { kind, reply: `No matching accessible placement in ${name}. Give the employee ID or exact full name.` } };
  return { error: { kind, reply: `More than one placement matches in ${name}. Use “placement” and the placement number instead of the name.`,
    table: { title: 'Matching placements · ' + name, columns: ['Placement', 'Employee ID', 'Name'], rows: rows.slice(0, 10).map((r) => [r.id, r.emp_code, r.name]) } } };
}

function action(user, name, ask) {
  const crm = ask.match(/^(?:open|show)\s+(?:the\s+)?c\.?\s*r\.?\s*m\.?(?:\s+(?:for\s+)?(.+))?$/i);
  const change = !crm && ask.match(/^(?:set|change|mark|move|put)\s+(.+?)\s+(?:to|as|on)\s+(.+)$/i);
  if (!crm && !change) return null;
  if (!can(user, crm ? 'crm.use' : 'employee.edit')) return { kind: 'denied', reply: `You do not have ${crm ? 'CRM' : 'edit'} permission in ${name}.` };
  if (crm && !crm[1]) return { kind: 'crm_lookup', reply: `Whose CRM record in ${name}? Say the employee ID or full name.` };
  const { person, error } = findPlacement(user, name, (crm || change)[1], !!crm);
  if (error) return error;
  const ref = `${person.name} (${person.emp_code}) in ${name}`;
  if (crm) {
    const form = crmForm(user, person.id, name);
    return { kind: 'crm', crm: form, reply: `CRM open for ${ref}. ` + (form.fields.some((f) => f.editable)
      ? 'Say “list fields” or “set Detail Comments to” followed by your note. Then say “review changes”.' : 'This CRM record is read-only.') };
  }
  for (const field of schema.listFields(user).filter((f) => ['bench_category', 'block_status'].includes(f.key))) {
    const to = (field.options || []).find((v) => norm(v) === norm(change[2]));
    if (!to) continue;
    const from = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', person.id, field.id)?.value ?? null;
    if (to === from) return { kind: 'change', reply: `${ref} is already ${to}. Nothing to approve.` };
    return { kind: 'change', reply: `Proposed ${field.label}: ${to} for ${ref}. An administrator must approve before anything is saved.`,
      proposal: { kind: 'update_assignment', assignmentId: person.id, projectName: name, ref: person.emp_code, summary: `${ref} · ${field.label}: ${from ?? '(empty)'} → ${to}`,
        changes: { [field.key]: { label: field.label, from, to } } } };
  }
  return null;
}
function understand(user, message, selected = null) {
  const { name, ask, error } = resolve(user, String(message || ''), selected);
  if (error) return error;
  const answer = !ask ? { kind: 'project', reply: `Selected Giga project: ${name}.` }
    : action(user, name, ask) || report(user, name, ask) || { kind: 'help', understood: false, reply: `For ${name}, I can count or list people, break down a status, propose a bench or block change, or open an employee’s CRM. Try one of the examples.` };
  return { understood: true, projectName: name, suggestions: examples(name), ...answer };
}
module.exports = { understand, visibleProjectNames };
