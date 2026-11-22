'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const names = ['.nojekyll','index.html','workspace.js','engine.js','sqlite.wasm','sample.gz','workbooks.js','site.css','mark.svg','notices.txt',
  ...[400,500,600,700].map(w => `inter-latin-${w}-normal.woff2`),'noto-sans-devanagari-wght.woff2'].sort();

test('both branch publishing folders serve the app with only known project-relative assets', () => {
  const entries = fs.readdirSync(docs, {withFileTypes:true});
  assert.deepEqual(entries.map(x => x.name).sort(), names);
  assert.ok(entries.every(x => x.isFile()), 'no symlinks or bundled private directories');
  assert.ok(!fs.existsSync(path.join(root,'.nojekyll')), 'must not bypass the root publication allowlist');
  const config = fs.readFileSync(path.join(root,'_config.yml'),'utf8');
  assert.match(config, /^exclude: \["\*\*"\]$/m);
  const allowed = ['docs',...names.filter(n => n !== '.nojekyll')].sort();
  assert.deepEqual(JSON.parse(config.match(/^include: (.+)$/m)[1]), allowed.map(n => `[${n[0]}]${n.slice(1)}`));
  for (const entry of fs.readdirSync(root)) if (allowed.includes(entry)) assert.ok(['index.html','docs'].includes(entry), `stray Pages entry in root: ${entry}`);
  for (const [dir,prefix] of [[root,'./docs/'],[docs,'./']]) {
    const html = fs.readFileSync(path.join(dir,'index.html'),'utf8');
    assert.ok(html.includes(`type="module" src="${prefix}workspace.js"`));
    assert.match(html, /form-action 'none'/);
    assert.doesNotMatch(html, /<form\b|<iframe\b|https?:\/\/|http-equiv="refresh"/i);
    for (const [,ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      assert.ok(ref.startsWith(prefix)); assert.ok(fs.statSync(path.join(dir,ref)).isFile());
    }
  }
});

test('published demo has only the pinned TEST fixture, not workbooks, sessions or sign-in credentials', () => {
  const {personas, reference, columns} = JSON.parse(gunzipSync(fs.readFileSync(path.join(docs,'sample.gz'))));
  assert.deepEqual(columns.emp_code, Array.from({length:1000},(_,i) => `TEST-${String(i+1).padStart(4,'0')}`));
  assert.deepEqual([columns.first_name[0],columns.last_name[0]], ['Aarav','Sen']);
  assert.equal(columns.bench_category.filter(v => v === 'Bench').length,200);
  assert.ok(personas.length && personas.every(p => Object.keys(p).sort().join(',') === 'id,name,role,title'));
  assert.deepEqual(Object.keys(reference).sort(),['categories','category_fields','employee_groups','fields','projects','subprojects','suppliers','user_capabilities','user_projects']);
  for (const name of ['workspace.js','engine.js']) assert.doesNotMatch(fs.readFileSync(path.join(docs,name),'utf8'), /Admin@12345|Super@12345|@resourceplanning\.io|rp\.token|localhost:\d/);
});

test('shipped static build matches source and never opens an operator DB', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rp-pages-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  execFileSync(process.execPath,['--disable-warning=ExperimentalWarning','scripts/build-pages.js','--check'],{
    cwd:root,env:{...process.env,DATA_DIR:path.join(dir,'private'),DB_FILE:path.join(dir,'must-not-open.db')},stdio:'pipe'
  });
  assert.deepEqual(fs.readdirSync(dir),[]);
});
