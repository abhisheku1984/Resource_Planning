// Browser-only SQLite adapter. A dedicated worker owns one in-memory database;
// it cannot open a server database, IndexedDB or a file on the operator's disk.
const initSqlJs = require('sql.js/dist/sql-wasm-browser.js');
let db;
const statements = new Map();
function withStatement(sql, params, fn) {
  let st = statements.get(sql);
  if (!st) {
    if (statements.size >= 400) { const [k, old] = statements.entries().next().value; old.free(); statements.delete(k); }
    st = db.prepare(sql); statements.set(sql, st);
  }
  try { st.bind(params.map(v => v ?? null)); return fn(st); }
  finally { st.reset(); }
}
const q = {
  get: (sql, ...p) => withStatement(sql, p, st => st.step() ? st.getAsObject() : undefined),
  all: (sql, ...p) => withStatement(sql, p, st => { const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; }),
  run(sql, ...p) {
    withStatement(sql, p, st => st.step());
    return { changes: db.getRowsModified(), lastInsertRowid: q.get('SELECT last_insert_rowid() id').id };
  },
};
function tx(fn) {
  db.run('BEGIN');
  try { const result = fn(); db.run('COMMIT'); return result; }
  catch (err) { db.run('ROLLBACK'); throw err; }
}
// Same per-request catalogue memo as the server; never reuse it across requests.
let memo;
function remember(key, fn) { if (!memo) return fn(); if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); }
async function batch(fn) { memo = new Map(); try { return await fn(); } finally { memo = null; } }

async function openSample() {
  const [SQL, sample] = await Promise.all([
    initSqlJs({ locateFile: () => new URL('sqlite.wasm', self.location.href).href }),
    fetch(new URL('sample.gz', self.location.href)).then(async r => {
      if (!r.ok) throw Error('Sample files are not available.');
      // Static hosts may attach Content-Encoding: gzip to a .gz file. In
      // that case fetch already decoded it; never decompress the same file twice.
      const bytes = new Uint8Array(await r.arrayBuffer());
      const data = new Response(bytes);
      return bytes[0] === 0x1f && bytes[1] === 0x8b
        ? new Response(data.body.pipeThrough(new DecompressionStream('gzip'))).json() : data.json();
    }),
  ]);
  db = new SQL.Database();
  db.exec(sample.schema);
  db.run('PRAGMA foreign_keys=ON');
  const { personas, reference, columns } = sample;
  // Insert a complete column at once using SQLite JSON, not 60,000 round trips.
  tx(() => {
    for (const p of personas) q.run('INSERT INTO users(id,name,role,title,email,password_hash) VALUES (?,?,?,?,?,?)',
      p.id, p.name, p.role, p.title, `sample-${p.id}@example.invalid`, '');
    for (const [table, rows] of Object.entries(reference)) {
      if (!rows.length) continue;
      const keys = Object.keys(rows[0]);
      const insert = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?')})`);
      try { for (const row of rows) insert.run(keys.map(k => row[k])); } finally { insert.free(); }
    }
    const placements = new Map(q.all(`SELECT p.id p,s.id s,c.id c, p.name pn,s.name sn,c.name cn FROM projects p
      JOIN subprojects s ON s.project_id=p.id JOIN categories c ON c.subproject_id=s.id`)
      .map(x => [JSON.stringify([x.pn, x.sn, x.cn]), x]));
    const actor = personas.find(p => p.role === 'admin').id;
    const identity = new Set(['project','subproject','category','emp_code','first_name','last_name','status','remarks']);
    for (let i = 0; i < columns.emp_code.length; i++) {
      const id = i + 1, first = columns.first_name[i], last = columns.last_name[i];
      const {p,s,c} = placements.get(JSON.stringify([columns.project[i],columns.subproject[i],columns.category[i]]));
      q.run('INSERT INTO employees(id,emp_code,first_name,last_name,name,created_by,updated_by) VALUES (?,?,?,?,?,?,?)',
        id, columns.emp_code[i], first, last, `${first} ${last}`, actor, actor);
      q.run('INSERT INTO assignments(id,employee_id,project_id,subproject_id,category_id,status,remarks,updated_by) VALUES (?,?,?,?,?,?,?,?)',
        id,id,p,s,c,columns.status[i],columns.remarks[i],actor);
    }
    for (const [key, values] of Object.entries(columns)) {
      if (identity.has(key)) continue;
      const field = q.get('SELECT id FROM fields WHERE key=?', key);
      if (!field) throw Error('Unknown sample field: ' + key);
      db.run(`INSERT INTO assignment_values(assignment_id,field_id,value,source,updated_by)
        SELECT key+1,?,value,'import',? FROM json_each(?) WHERE value IS NOT NULL AND value != ''`, [field.id, actor, JSON.stringify(values)]);
    }
    q.run("INSERT INTO audit_log(entity,action,ref,new_value,actor_name) VALUES ('dataset','create','Sample workspace','1,000 sample employees','Browser demo')");
  });
}
module.exports = { q, tx, batch, remember, openSample };
