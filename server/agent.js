'use strict';
/**
 * The in-app assistant - a rules-based intent parser, entirely offline.
 *
 * Deliberate constraints:
 *  - No language model, no network call, no API key. The app never talks to the
 *    internet at runtime, which is what the security note promises.
 *  - It never writes. Every change it works out becomes a PROPOSAL that a human
 *    approves, so a mis-parse can never corrupt the master data.
 *  - Every number it reports comes from a real SQL query scoped to projects the
 *    asking user is allowed to see. It cannot invent a count.
 */

const { q } = require('./db');
const schema = require('./schema');
const { assignmentScope } = require('./access');
const fielddefs = require('./fielddefs');

const BENCH = fielddefs.BENCH_CATEGORIES;
const BLOCK = fielddefs.BLOCK_STATUS;

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\u2019']/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100,
};

function parseNumber(text) {
  const m = text.match(/(\d[\d,]*)\s*(k|thousand)?/);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    return m[2] ? n * 1000 : n;
  }
  for (const [word, value] of Object.entries(NUM_WORDS)) {
    if (new RegExp('\\b' + word + '\\b').test(text)) return value;
  }
  return null;
}

function visibleProjects(user) {
  if (user.isAdmin) return q.all('SELECT id, code, name FROM projects ORDER BY name');
  const ids = (user.projects || []).map((p) => p.id);
  if (!ids.length) return [];
  return q.all(
    'SELECT id, code, name FROM projects WHERE id IN (' + ids.map(() => '?').join(',') + ') ORDER BY name',
    ...ids
  );
}

/** A token that looks like a project code but is not one the user may see. */
function unknownProjectNamed(user, text) {
  const visible = new Set(visibleProjects(user).map((p) => norm(p.code)));
  const tokens = String(text).match(/\b[A-Z][A-Z0-9]{3,11}\b/g) || [];
  for (const token of tokens) {
    const t = norm(token);
    if (visible.has(t)) continue;
    if (/^(pid|opid|emp)$/.test(t)) continue;
    if (q.get('SELECT 1 x FROM projects WHERE lower(code) = ?', t)) return token;
  }
  return null;
}

function findProject(user, text) {
  const projects = visibleProjects(user);
  const t = norm(text);
  let best = null;
  for (const p of projects) {
    const code = norm(p.code);
    const name = norm(p.name);
    if (t.includes(code)) return p;
    const words = name.split(' ').filter((w) => w.length > 3 && ['project', 'programme', 'platform'].indexOf(w) === -1);
    if (words.some((w) => t.includes(w))) {
      if (!best || words.length < best.words) best = Object.assign({}, p, { words: words.length });
    }
  }
  return best;
}

function findValue(text, options) {
  const t = norm(text);
  const sorted = options.slice().sort((a, b) => b.length - a.length);
  for (const opt of sorted) {
    if (t.includes(norm(opt))) return opt;
  }
  return null;
}

function findPeople(user, text) {
  const t = norm(text);
  const acl = assignmentScope(user);

  const codeMatch = text.match(/\b([A-Z]{2,5}-\d{3,6})\b/i);
  if (codeMatch) {
    return q.all(
      'SELECT a.id AS assignmentId, e.emp_code, e.name, a.project_id, p.name AS projectName' +
      ' FROM assignments a JOIN employees e ON e.id = a.employee_id' +
      ' JOIN projects p ON p.id = a.project_id' +
      ` WHERE a.active = 1 AND upper(e.emp_code) = upper(?) AND ${acl.sql}`,
      codeMatch[1], ...acl.args
    );
  }

  const words = t.replace(/[^a-z\s]/g, ' ').split(' ').filter((w) => w.length > 2);
  for (let take = Math.min(3, words.length); take >= 2; take--) {
    for (let i = 0; i + take <= words.length; i++) {
      const phrase = words.slice(i, i + take).join(' ');
      const rows = q.all(
        'SELECT a.id AS assignmentId, e.emp_code, e.name, a.project_id, p.name AS projectName' +
        ' FROM assignments a JOIN employees e ON e.id = a.employee_id' +
        ' JOIN projects p ON p.id = a.project_id' +
        ` WHERE a.active = 1 AND lower(e.name) LIKE ? AND ${acl.sql} LIMIT 25`,
        '%' + phrase + '%', ...acl.args
      );
      const unique = Array.from(new Map(rows.map((r) => [r.assignmentId, r])).values());
      if (unique.length) return unique;
    }
  }
  return [];
}

function label(key) {
  const f = schema.listFields().find((x) => x.key === key);
  return f ? f.label : key;
}

function projectScope(user, project) {
  const acl = assignmentScope(user);
  return project ? { sql: `${acl.sql} AND a.project_id = ?`, args: [...acl.args, project.id] } : acl;
}

function breakdown(user, project, fieldKey) {
  const field = schema.listFields().find((f) => f.key === fieldKey);
  if (!field) return [];
  const acl = projectScope(user, project);
  return q.all(
    'SELECT v.value AS a, COUNT(*) AS b FROM assignment_values v' +
    ' JOIN assignments a ON a.id = v.assignment_id' +
    ` WHERE a.active = 1 AND v.field_id = ? AND ${acl.sql}` +
    " AND v.value IS NOT NULL AND v.value <> ''" +
    ' GROUP BY v.value ORDER BY b DESC LIMIT 12',
    field.id, ...acl.args
  ).map((r) => [r.a, Number(r.b).toLocaleString('en-IN')]);
}

function followUps(user, project) {
  const where = project ? project.code : 'my projects';
  return [
    'How many are on bench in ' + where + '?',
    'Break down bench category in ' + where,
    'How many are hard block in ' + where + '?',
  ];
}

function answerCount(user, text) {
  const hidden = unknownProjectNamed(user, text);
  if (hidden) {
    return {
      understood: true, kind: 'denied',
      reply: 'You do not have access to ' + hidden + ', so I cannot report on it. Your projects: ' +
        (visibleProjects(user).map((p) => p.code).join(', ') || 'none assigned') + '.',
      suggestions: followUps(user, null),
    };
  }
  const t = norm(text);
  const project = findProject(user, text);
  const benchValue = findValue(t, BENCH);
  const blockValue = findValue(t, BLOCK);
  const fieldKey = blockValue ? 'block_status' : (benchValue ? 'bench_category' : null);

  const acl = projectScope(user, project);
  const where = ['a.active = 1', 'e.active = 1', acl.sql];
  const args = acl.args;

  if (fieldKey) {
    const field = schema.listFields().find((f) => f.key === fieldKey);
    where.push('EXISTS (SELECT 1 FROM assignment_values v WHERE v.assignment_id = a.id' +
      ' AND v.field_id = ? AND v.value = ?)');
    args.push(field.id, blockValue || benchValue);
  }

  const row = q.get(
    'SELECT COUNT(*) c FROM assignments a JOIN employees e ON e.id = a.employee_id WHERE ' + where.join(' AND '),
    ...args
  );

  const whereText = project ? 'in ' + project.name : 'across your projects';
  const what = blockValue ? 'with block status "' + blockValue + '"'
    : benchValue ? 'in bench category "' + benchValue + '"'
      : 'on the bench board';

  const splitField = fieldKey || 'bench_category';
  const split = breakdown(user, project, splitField);

  return {
    understood: true,
    kind: 'count',
    reply: Number(row.c).toLocaleString('en-IN') + ' people ' + what + ' ' + whereText + '.',
    data: { count: row.c, project: project ? project.code : 'ALL', field: fieldKey, value: blockValue || benchValue },
    table: split.length ? { title: 'Breakdown by ' + label(splitField), columns: [label(splitField), 'People'], rows: split } : null,
    suggestions: followUps(user, project),
  };
}

function answerList(user, text) {
  const project = findProject(user, text);
  const benchValue = findValue(text, BENCH) || 'Bench';
  const field = schema.listFields().find((f) => f.key === 'bench_category');
  const acl = projectScope(user, project);

  const rows = q.all(
    'SELECT e.emp_code, e.name, p.code AS project, v.value AS bench_category' +
    ' FROM assignment_values v JOIN assignments a ON a.id = v.assignment_id' +
    ' JOIN employees e ON e.id = a.employee_id JOIN projects p ON p.id = a.project_id' +
    ' WHERE a.active = 1 AND v.field_id = ? AND v.value = ?' +
    ` AND ${acl.sql}` +
    ' ORDER BY e.name LIMIT 25',
    field.id, benchValue, ...acl.args
  );

  return {
    understood: true,
    kind: 'list',
    reply: rows.length
      ? 'Showing the first ' + rows.length + ' people in "' + benchValue + '"' + (project ? ' in ' + project.name : '') + '.'
      : 'Nobody is in "' + benchValue + '"' + (project ? ' in ' + project.name : '') + '.',
    table: rows.length ? {
      title: benchValue + (project ? ' - ' + project.name : ''),
      columns: ['Employee ID', 'Name', 'Project', 'Bench Category'],
      rows: rows.map((r) => [r.emp_code, r.name, r.project, r.bench_category]),
    } : null,
    suggestions: followUps(user, project),
  };
}

function valueOf(assignmentId, fieldId) {
  const row = q.get('SELECT value FROM assignment_values WHERE assignment_id = ? AND field_id = ?', assignmentId, fieldId);
  return row ? row.value : null;
}

function proposeChange(user, text) {
  const hidden = unknownProjectNamed(user, text);
  if (hidden) {
    return {
      understood: true, kind: 'denied',
      reply: 'You do not have access to ' + hidden + ', so I cannot propose a change there.',
    };
  }
  const blockValue = findValue(text, BLOCK);
  const benchValue = findValue(text, BENCH);
  if (!blockValue && !benchValue) return null;

  const people = findPeople(user, text);
  if (!people.length) {
    return {
      understood: true,
      kind: 'change',
      reply: 'I could not match that to an employee in your projects. Include the employee ID (for example EMP-01042) or the full name.',
      suggestions: ['Set EMP-01042 to hard block', 'How many are on bench in NEXUS?'],
    };
  }
  if (people.length > 1) {
    return {
      understood: true,
      kind: 'change',
      reply: 'That could be any of ' + people.length + ' people. Add the employee ID so I propose the right one.',
      table: {
        title: 'Possible matches',
        columns: ['Employee ID', 'Name', 'Project'],
        rows: people.slice(0, 10).map((p) => [p.emp_code, p.name, p.projectName]),
      },
    };
  }

  const person = people[0];
  const fields = schema.listFields();
  const changes = {};
  if (blockValue) {
    const f = fields.find((x) => x.key === 'block_status');
    changes[f.key] = { label: f.label, from: valueOf(person.assignmentId, f.id), to: blockValue };
  }
  if (benchValue) {
    const f = fields.find((x) => x.key === 'bench_category');
    changes[f.key] = { label: f.label, from: valueOf(person.assignmentId, f.id), to: benchValue };
  }

  const noop = Object.keys(changes).every((k) =>
    String(changes[k].from === null || changes[k].from === undefined ? '' : changes[k].from) === String(changes[k].to));
  if (noop) {
    return {
      understood: true,
      kind: 'change',
      reply: person.name + ' (' + person.emp_code + ') is already ' +
        Object.keys(changes).map((k) => changes[k].label.toLowerCase() + ' "' + changes[k].to + '"').join(' and ') +
        '. Nothing to approve.',
      suggestions: ['How many are hard block in that project?'],
    };
  }

  const summary = Object.keys(changes)
    .map((k) => changes[k].label + ': ' + (changes[k].from === null ? '(empty)' : changes[k].from) + ' \u2192 ' + changes[k].to)
    .join(', ');

  return {
    understood: true,
    kind: 'change',
    reply: 'Proposed change for ' + person.name + ' (' + person.emp_code + ') in ' + person.projectName +
      '. Nothing is saved until an administrator approves it.',
    proposal: {
      kind: 'update_assignment',
      assignmentId: person.assignmentId,
      ref: person.emp_code,
      name: person.name,
      projectName: person.projectName,
      summary,
      changes,
    },
    suggestions: ['How many are hard block in that project?'],
  };
}

const GREETINGS = /^(hi|hello|hey|good morning|good evening|help|what can you do)\b/;

function understand(user, message) {
  const text = String(message || '').trim();
  if (!text) return { understood: false, reply: 'Ask me something, for example "how many are on bench in NEXUS?"' };
  const t = norm(text);

  if (GREETINGS.test(t) && text.length < 40) {
    return {
      understood: true,
      kind: 'help',
      reply: 'I can count and change people in the projects you are allowed to see. I never invent numbers and I never save anything without approval.',
      suggestions: ['How many are on bench in NEXUS?', 'Set EMP-01042 to hard block'],
    };
  }

  const wantsChange = /\b(set|mark|change|update|make|move|put|assign)\b/.test(t);
  const wantsCount = /\b(how many|count|number of|total|headcount)\b/.test(t);
  const wantsList = /\b(who|list|show me|which people|names)\b/.test(t);

  if (wantsChange) {
    const proposal = proposeChange(user, text);
    if (proposal) return proposal;
  }
  if (wantsCount) return answerCount(user, text);
  if (wantsList) return answerList(user, text);

  const hasFacet = findValue(t, BLOCK) || findValue(t, BENCH);
  if (hasFacet) return answerCount(user, text);

  return {
    understood: false,
    reply: 'I did not understand that yet. I can answer counts ("how many on bench in NEXUS?") and propose changes ("set EMP-01042 to hard block").',
    suggestions: ['How many are on bench in NEXUS?', 'Set EMP-01042 to hard block'],
  };
}

module.exports = { understand, visibleProjects, findProject, findPeople, breakdown, answerCount, parseNumber };
