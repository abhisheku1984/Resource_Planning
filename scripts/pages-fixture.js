'use strict';
// Build from two known public sources, never the installation: seed.js (reference
// configuration only) and the hash-pinned synthetic workbook (column values).
// No database file, session, password, audit log or workbook is published.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { sha256 } = require('../pages-demo/fixture.json');

async function buildSample() {
  const bytes = fs.readFileSync(path.join(__dirname, '../samples/workforce-1000.xlsx'));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('Not the approved synthetic workbook. Refusing to publish.');
  // This module runs only in the build command's own process. Refuse an
  // already-open connection, even if the caller claims it is disposable.
  if (require.cache[require.resolve('../server/db')]) throw Error('Pages fixture requires an isolated process');
  process.env.DATA_DIR = os.tmpdir();
  process.env.DB_FILE = ':memory:';
  process.env.RP_SEED_ROWS = '170';
  const { q, db } = require('../server/db');
  const schema = q.all("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY rowid").map(x => x.sql).join(';\n');
  require('../server/seed').run({ quiet: true });
  const reference = {};
  for (const [table, columns] of Object.entries({
    projects: 'id,code,name,client,description,status,start_date', subprojects: 'id,project_id,code,name,description,sort_order',
    categories: 'id,subproject_id,code,name,description,sort_order', suppliers: 'id,code,name',
    fields: 'id,key,label,type,options,help,core,system,group_name,imported',
    category_fields: 'category_id,field_id,visible,editable,required,filterable,submit_field,sort_order,section',
    employee_groups: 'id,name,description', user_projects: 'user_id,project_id,can_edit,can_export,can_crm',
    user_capabilities: 'user_id,capability,allowed',
  })) reference[table] = q.all(`SELECT ${columns} FROM ${table} ORDER BY rowid`);
  const personas = q.all('SELECT id,name,role,title FROM users ORDER BY id');
  db.close();
  const wb = new (require('exceljs').Workbook)();
  await wb.xlsx.load(bytes);
  const sheet = wb.getWorksheet('Employees');
  const headers = [['Project','project'], ['Subproject','subproject'], ['Category','category'], ...require('../server/fielddefs').WORKBOOK_HEADERS];
  if (sheet.rowCount !== 1001 || sheet.columnCount !== headers.length) throw Error('Unexpected sample shape');
  const columns = {};
  headers.forEach(([label, key], i) => {
    if (!key) return;
    if (sheet.getRow(1).getCell(i + 1).text !== label) throw Error(`Unexpected sample column: ${label}`);
    columns[key] = Array.from({ length: 1000 }, (_, j) => {
      const v = sheet.getRow(j + 2).getCell(i + 1).value;
      return v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v);
    });
  });
  if (!columns.emp_code.every((id, i) => id === `TEST-${String(i + 1).padStart(4, '0')}`)) throw Error('Unexpected employee IDs');
  return gzipSync(JSON.stringify({ schema, reference, personas, columns }), { level: 9 });
}
module.exports = { buildSample };
