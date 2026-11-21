'use strict';
// Offline, deterministic workbook questions. The same named-assignment relation
// drives the project picker, counts, breakdowns, lists, CRM and proposals.
// An explicit but unknown project must NEVER fall back to a broader scope.
const { q } = require('./db');
const { assignmentScope } = require('./access');
const { can } = require('./auth');
const schema = require('./schema');
const { crmForm } = require('./assistant-crm');
const hindi = require('./agent-hi');
const copy = require('./agent-copy');
const { parseGuide, howTo } = require('./agent-guide');

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
function resolve(user, message, selected, lang, requested = null, projectPicked = false) {
  const names = visibleProjectNames(user), hi = lang === copy.hi;
  const choose = (choices) => ({ understood: false, kind: 'choose_project', reply: lang.choose(choices.slice(0, 8)), suggestions: choices.slice(0, 8) });
  const unavailable = () => ({ understood: false, kind: 'denied', reply: lang.unavailable });
  if (!names.length) return { error: { kind: 'denied', reply: lang.noProjects } };
  const sound = (s) => spoken(hi ? hindi.spokenProject(norm(s)) : s);
  const matches = (raw) => {
    const name = raw.trim();
    if (names.includes(name)) return [name];
    const same = names.filter((s) => norm(s) === norm(name));
    if (same.length) return same;
    const alias = sound(name);
    return names.filter((s) => sound(s) === alias);
  };
  // Compare whole names first, even if a workbook name contains a preposition.
  const text = message.trim().replace(/[.?!।]+$/u, '').trim();
  let ask = text, explicit = null;
  const select = text.match(/^(?:select|switch to|use)\s+(?:project\s+)?(.+)$/i);
  const prefix = text.match(/^(?:in|for|within)\s+(.+?)[,:]?\s+((?:how many|who|what|list|show|count|break ?down|open|set|mark)\b.*)$/i);
  const clauseHi = hi && hindi.projectClause(text, matches);
  if (requested !== null) explicit = requested;
  else if (matches(text).length) { explicit = text; ask = ''; }
  else if (clauseHi) ({ explicit, ask } = clauseHi);
  else if (select) { explicit = select[1]; ask = ''; }
  else if (prefix) { explicit = prefix[1]; ask = prefix[2]; }
  else {
    const clauses = [...text.matchAll(/\s+(?:in|within|under|from|for|across)\s+/gi)].filter((m) =>
      m[0].trim().toLowerCase() !== 'for' || !/^(?:open|show)\s+(?:the\s+)?c\.?\s*r\.?\s*m\.?$/i.test(text.slice(0, m.index)));
    // Only skip the employee delimiter in "Open CRM for <person>".
    if (clauses.length) {
      const tail = (m) => text.slice(m.index + m[0].length);
      const clause = clauses.find((m) => matches(tail(m)).length) || clauses.at(-1);
      explicit = tail(clause); ask = text.slice(0, clause.index);
      // Also accept “how many people in <exact name> are on bench?” without
      // treating a longer unseen project name as a shorter, visible sibling.
      const predicate = explicit.match(/^(.+?)\s+(?:are|is)\s+(.+)$/i);
      if (!matches(explicit).length && predicate && matches(predicate[1]).length) {
        explicit = predicate[1]; ask += ' ' + predicate[2];
      }
      if (/^(?:(?:my|this|that|the selected) (?:giga )?projects?)$/i.test(explicit)) explicit = null;
    }
  }
  if (hi && explicit && !matches(explicit).length && /^(?:इस|चुने हुए) (?:प्रोजेक्ट|परियोजना)$/u.test(explicit)) explicit = null;
  if (explicit !== null) {
    let hits = matches(explicit);
    if (!hits.length) hits = matches(explicit.replace(/^(?:(?:the )?(?:giga )?project(?: name)?|प्रोजेक्ट|परियोजना)\s+/iu, ''));
    // An old selection is not a tie-breaker. Only an explicit follow-up pick
    // can narrow ambiguous aliases, and only to an exact, live candidate.
    if (hits.length > 1 && projectPicked && hits.includes(selected)) hits = [selected];
    if (hits.length !== 1) return { error: hits.length ? { ...choose(hits), ambiguousProject: true } : unavailable() };
    return { name: hits[0], ask };
  }
  if (selected != null && selected !== '') return names.includes(selected) ? { name: selected, ask } : { error: unavailable() };
  return names.length === 1 ? { name: names[0], ask } : { error: choose(names) };
}

const fmt = (n) => n.toLocaleString('en-IN');
const metricText = (s) => norm(s).replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim();
const METRICS = ['bench_category', 'block_status', 'billing_status', 'offsite_onsite', 'bl_status'];
function report(user, name, ask, lang) {
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
  if (matches.length > 1) return { kind: 'clarify', reply: lang.whichField(name, matches.map((m) => m.field.label)) };
  if (!matches.length && metric) return null; // don't answer an unrecognised filter with headcount
  const { field, value } = matches[0] || { field: fields.find((f) => f.key === 'bench_category'), value: null };
  const scope = scopeFor(user, name);
  const vjoin = ' JOIN assignment_values v ON v.assignment_id = a.id AND v.field_id = ?';
  const from = `${FROM}${value ? vjoin : ''} WHERE ${scope.sql}${value ? ' AND v.value = ?' : ''}`;
  const args = value ? [field.id, ...scope.args, value] : scope.args;
  const total = q.get(`SELECT COUNT(DISTINCT e.id) c ${from}`, ...args).c;
  const reply = lang.count(name, total, field, value);
  const data = { count: total, project: name, field: field.key, value };
  if (verb === list) {
    const people = q.all(`SELECT DISTINCT e.emp_code, e.name ${from} ORDER BY e.name, e.emp_code LIMIT 25`, ...args);
    return { kind: 'list', reply: reply + (total > 25 ? lang.first25 : ''), data,
      table: { title: lang.people + ' · ' + name, columns: lang.peopleColumns, rows: people.map((r) => [r.emp_code, r.name, name]) } };
  }
  const buckets = q.all(`SELECT v.value, COUNT(DISTINCT e.id) c ${FROM}${vjoin} WHERE ${scope.sql} AND v.value <> '' GROUP BY v.value ORDER BY c DESC, v.value`, field.id, ...scope.args);
  return { kind: verb === group ? 'breakdown' : 'count', reply, data, table: { title: `${field.label} · ${name}`, columns: [field.label, lang.people], rows: buckets.map((r) => [r.value, fmt(r.c)]) } };
}

function findPlacement(user, name, raw, crm, lang, choiceId = null) {
  const scope = scopeFor(user, name, crm ? 'can_crm' : 'can_edit');
  const who = raw.trim().replace(lang === copy.hi ? /^(?:employee(?: id)?|कर्मचारी(?: (?:आई\s*डी|id))?)\s+/iu : /^employee(?: id)?\s+/i, '');
  const id = lang === copy.hi ? hindi.employeeTerm(who) : who;
  const placement = id.match(/^placement\s+(\d+)$/i);
  // Keep the literal ID/name and also try its spoken code, preserving leading zeros.
  const code = id.replace(/\b(?:dash|hyphen)\b/i, '-').match(/^([a-z](?:\s*[a-z])*)[\s-]+([\d ]+)$/i);
  const rows = q.all(`SELECT a.id, e.name, e.emp_code, p.name AS project, s.name AS subproject, c.name AS category ${FROM}
    JOIN projects p ON p.id = a.project_id JOIN subprojects s ON s.id = a.subproject_id JOIN categories c ON c.id = a.category_id
    WHERE ${scope.sql} AND ` + (placement ? 'a.id = ?' :
    '(e.emp_code = ? COLLATE NOCASE OR e.emp_code = ? COLLATE NOCASE OR e.name = ? COLLATE NOCASE)') + (choiceId == null ? '' : ' AND a.id = ?') + ' ORDER BY a.id LIMIT 11',
    ...scope.args, ...(placement ? [Number(placement[1])] : [who, code ? code[1].replace(/\s/g, '') + '-' + code[2].replace(/\s/g, '') : id, who]), ...(choiceId == null ? [] : [choiceId]));
  if (rows.length === 1) return { person: rows[0] };
  const kind = crm ? 'crm_lookup' : 'clarify';
  if (!rows.length) return { error: { kind, reply: lang.noMatch(name) } };
  return { error: { kind, reply: lang.ambiguous(name),
    table: { title: lang.placements + ' · ' + name, columns: lang.placementColumns, rows: rows.slice(0, 10).map((r) => [r.id, r.emp_code, r.name, `${r.project} / ${r.subproject} / ${r.category}`]) } } };
}

function action(user, name, ask, lang) {
  const crm = ask.match(/^(?:open|show)\s+(?:the\s+)?c\.?\s*r\.?\s*m\.?(?:\s+(?:for\s+)?(.+))?$/i);
  const change = !crm && ask.match(/^(?:set|change|mark|move|put)\s+(.+?)\s+(?:to|as|on)\s+(.+)$/i);
  if (!crm && !change) return null;
  if (!can(user, crm ? 'crm.use' : 'employee.edit')) return { kind: 'denied', reply: lang.noPermission(name, crm) };
  if (crm && !crm[1]) return { kind: 'crm_lookup', reply: lang.askPerson(name) };
  const { person, error } = findPlacement(user, name, (crm || change)[1], !!crm, lang);
  if (error) return error;
  const ref = lang.reference(person, name);
  if (crm) {
    const form = crmForm(user, person.id, name);
    return { kind: 'crm', crm: form, reply: lang.openCrm(ref, form.fields.some((f) => f.editable)) };
  }
  for (const field of schema.listFields(user).filter((f) => ['bench_category', 'block_status'].includes(f.key))) {
    const to = (field.options || []).find((v) => norm(v) === norm(change[2]));
    if (!to) continue;
    const from = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', person.id, field.id)?.value ?? null;
    if (to === from) return { kind: 'change', reply: lang.unchanged(ref, to) };
    return { kind: 'change', reply: lang.proposed(ref, field, to),
      proposal: { kind: 'update_assignment', assignmentId: person.id, projectName: name, ref: person.emp_code, summary: `${ref} · ${field.label}: ${from ?? '(empty)'} → ${to}`,
        changes: { [field.key]: { label: field.label, from, to } } } };
  }
  return null;
}
// A guide choice is a scoped lookup, not a write token.
function guided(user, name, request, choice, lang) {
  if (!can(user, 'crm.use') || !can(user, 'employee.edit')) {
    return { kind: 'denied', reply: lang.noPermission(name, !can(user, 'crm.use')) };
  }
  let who = request.person || choice?.person;
  // A user can correct a misheard name ONLY if the original exact target has
  // no match in this scope. A choice must never replace a valid named person.
  if (request.person && choice?.person && choice.person !== request.person) {
    const first = findPlacement(user, name, request.person, true, lang);
    if (first.error && !first.error.table) who = choice.person;
  }
  const prompt = (step, reply, extra = {}) => ({ kind: 'crm_lookup', reply, guide: { step, person: who || '' }, suggestions: [], ...extra });
  if (!who) return prompt('person', lang.askPerson(name));
  const { person, error } = findPlacement(user, name, who, true, lang, choice?.placementId);
  if (error?.table) return prompt('placement', error.reply, { table: error.table,
    suggestions: error.table.rows.map(([id]) => (lang === copy.hi ? 'प्लेसमेंट ' : 'Placement ') + id) });
  if (error) return choice?.placementId != null
    ? { kind: 'clarify', reply: lang.retryGuide(name), suggestions: [] }
    : prompt('person', error.reply);
  const crm = crmForm(user, person.id, name, true);
  if (!crm.fields.some((f) => f.editable)) return { kind: 'denied', reply: lang.noPermission(name, false) };
  return { kind: 'crm', crm, guide: { step: 'form', instruction: request.instruction },
    reply: lang.draftFor(lang.reference(person, name)), suggestions: [] };
}

function understand(user, message, selected = null, language = 'en', choice = null, projectPicked = false) {
  const lang = language === 'hi' ? copy.hi : copy.en;
  const text = String(message || '');
  const help = !choice && howTo(text, language, user);
  if (help) return help;
  const guide = parseGuide(text, language, (term) => schema.listFields(user).some((f) =>
    [f.key.replaceAll('_', ' '), f.label].some((v) => norm(v) === norm(term))));
  const { name, ask: question, error } = resolve(user, guide ? '' : text, selected, lang, guide?.project, projectPicked);
  if (error) return error;
  const ask = lang === copy.hi ? hindi.intent(question) : question;
  const answer = guide ? guided(user, name, guide, choice, lang)
    : choice ? { kind: 'clarify', reply: lang.retryGuide(name) }
    : !ask ? { kind: 'project', reply: lang.selected(name) }
    : action(user, name, ask, lang) || report(user, name, ask, lang) || { kind: 'help', understood: false, reply: lang.help(name) };
  return { understood: true, projectName: name, suggestions: lang.examples(name), ...answer };
}
module.exports = { understand, visibleProjectNames };
