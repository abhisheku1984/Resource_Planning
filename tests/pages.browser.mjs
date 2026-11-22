// Exercise exactly the checked-in Pages artifacts behind a project subpath, with
// no Node API. Run: CHROMIUM_PATH=/path/to/chrome npm run test:pages-browser
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ExcelJS from 'exceljs';
const root = fileURLToPath(new URL('../',import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'rp-pages-browser-'));
const assets = new Map(fs.readdirSync(path.join(root,'docs')).map(n => [n,path.join(root,'docs',n)]));
const bad = [], requests = [];
const types = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.wasm':'application/wasm','.svg':'image/svg+xml','.woff2':'font/woff2','.gz':'application/gzip'};
const server = createServer((req,res) => {
  const uri = new URL(req.url,'http://local.test').pathname;
  const m = /^\/(root-source|docs-source)\/Resource_Planning\/(.*)$/.exec(uri);
  let file;
  if (m && req.method === 'GET') {
    if (m[1] === 'root-source') file = (!m[2] || m[2] === 'sample.html') ? path.join(root,m[2] || 'index.html') : m[2].startsWith('docs/') ? assets.get(m[2].slice(5) || 'index.html') : null;
    else file = assets.get(m[2] || 'index.html');
  }
  if (!file) { bad.push(req.method+' '+uri); res.writeHead(404).end(); return; }
  requests.push(uri);
  res.setHeader('Content-Type',types[path.extname(file)] || 'text/plain');
  if (m[1] === 'docs-source' && file.endsWith('sample.gz')) res.setHeader('Content-Encoding','gzip');
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
try {
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const context = await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
  context.on('request',r => { if (!r.url().startsWith(origin+'/') && !/^(data:|blob:)/.test(r.url())) bad.push(r.url()); });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror',e => bad.push('page error: '+e.message));
  page.on('console',m => { if (m.type() === 'error') bad.push('console: '+m.text()); });
  const nav = label => page.locator('nav .nav-item').filter({hasText:label}).click();
  const waitCount = text => page.waitForFunction(v => document.querySelector('#row-count')?.textContent === v, text);
  const waitPlacements = text => page.getByText(text+' placements',{exact:true}).first().waitFor();
  const download = async button => { const [d] = await Promise.all([page.waitForEvent('download',{timeout:45000}),button.click()]);
    const file = path.join(temp,d.suggestedFilename()); await d.saveAs(file); return file; };
  const type = async (q,text) => { await q.fill(text); await q.press('Tab'); };
  const entry = origin+'/root-source/Resource_Planning/';
  // The default for a not-yet-connected install must not open the sample or accept credentials.
  const team = JSON.parse(fs.readFileSync(path.join(root,'deploy/site.json'),'utf8')).teamOrigin;
  if (!team) {
    await page.goto(entry+'?next=https://ignored.example/#/dashboard');
    await page.getByRole('heading',{name:'Sign in to Resource Planning'}).waitFor();
    assert.equal(await page.locator('form, input, nav').count(),0);
    assert.ok(!requests.some(p => /workspace\.js|sample\.gz/.test(p)));
    await page.getByRole('link',{name:'Open the fictional sample'}).click();
  } else await page.goto(entry+'sample.html');
  await waitPlacements('1,000');
  assert.match(await page.title(), /Sample workspace/); assert.equal(await page.locator('input[type=password]').count(),0);
  const instructions = page.getByRole('link', {name:'Team sign-in'});
  assert.equal(await instructions.getAttribute('href'), 'https://abhisheku1984.github.io/Resource_Planning/');
  assert.equal(await instructions.getAttribute('target'), '_blank');
  // User-facing drill-down, not just static files or a dashboard picture.
  await page.getByRole('button',{name:'Open project workspace'}).click();
  await page.locator('.project-card').filter({hasText:'Nexus Digital'}).click();
  await page.locator('.tree-node').filter({hasText:'Core Banking Migration'}).click();
  await page.locator('.tree-node').filter({hasText:'Delivery Status'}).click(); await waitCount('250');
  await nav('Employee Directory'); await waitCount('1,000');
  await page.getByTitle('Filter by Bench Category',{exact:true}).click();
  await page.locator('.facet-option-label').getByText('Bench',{exact:true}).click(); await waitCount('200');
  await page.getByRole('button',{name:'Clear all',exact:true}).first().click(); await waitCount('1,000');
  await page.getByLabel('Search employees').fill('TEST-0001'); await waitCount('1');
  await page.locator('#table-host tr[data-id] td').first().click();
  const detail = page.locator('[data-field-key=detail_comments]');
  assert.equal(await detail.inputValue(),'Sample note 0001'); await type(detail,'Pages sample edit');
  await page.locator('.save-state.saved').first().waitFor();
  const oneRow = await download(page.getByTitle('Export current view to Excel'));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(oneRow);
  assert.equal(wb.getWorksheet('Employees').actualRowCount,2);
  assert.ok(wb.getWorksheet('Employees').getRow(2).values.includes('Pages sample edit'));
  await nav('Audit Trail'); await page.locator('.tl-new').getByText('Pages sample edit',{exact:true}).waitFor();
  await nav('Administration'); await page.locator('#admin-body .card').first().waitFor();
  await nav('Users & Access'); await page.getByText('Sample accounts only',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button', {name:/Change login ID|Reset password|New user/i}).count(), 0);
  await page.getByRole('button',{name:'Ask',exact:true}).click();
  await page.locator('.assistant-scope select').selectOption('Giga One');
  const ask = page.getByPlaceholder('Ask a question or describe an employee update');
  await ask.fill('How many people are on bench?'); await ask.press('Enter');
  await page.locator('.ask-source').filter({hasText:'Giga One'}).waitFor();
  await page.getByRole('button',{name:'Close assistant'}).click();
  // The persona switch uses no password, changes actual ACLs, and does not
  // discard changes made elsewhere in the tab.
  const choose = async id => { await page.locator('.user-chip').click(); await page.getByLabel('View as').selectOption(id);
    await page.getByRole('button',{name:'Open workspace',exact:true}).click(); };
  await choose('2'); await waitPlacements('250'); assert.equal(await page.locator('nav').getByText('Users & Access').count(),0);
  await choose('1'); await waitPlacements('1,000');
  await nav('Data Hub'); await page.getByRole('button',{name:'Replace entire roster'}).click();
  const full = await download(page.getByRole('button',{name:'Export current roster'}));
  assert.ok(fs.statSync(full).size > fs.statSync(oneRow).size);
  const file = page.locator('#roster-file');
  await file.setInputFiles({ name:'not-the-sample.xlsx', mimeType:'application/octet-stream', buffer:Buffer.from('not sample bytes') });
  await page.getByRole('button',{name:'Preview replacement'}).click(); await page.getByText(/Not a sample workbook/).waitFor();
  await file.setInputFiles(oneRow); await page.getByRole('button',{name:'Preview replacement'}).click();
  await page.getByText('New roster from ',{exact:false}).first().waitFor();
  await page.locator('#roster-confirm').fill('REPLACE');
  await page.getByRole('button',{name:'Delete old roster and import'}).click(); await page.getByText('Roster replaced',{exact:true}).waitFor();
  await nav('Employee Directory'); await waitCount('1');
  await page.reload(); await waitCount('1,000');
  // Same payload also works when /docs is already the publishing source; a
  // hash deep link on a phone opens the app without a rewrite or repo visit.
  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/docs-source/Resource_Planning/sample.html#/directory'); await waitCount('1,000');
  await page.getByLabel('Toggle navigation').click(); await nav('Dashboard'); await waitPlacements('1,000');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  assert.equal(await page.evaluate(() => localStorage.getItem('rp.token')),null);
  assert.equal(context.pages().length,1);
  assert.deepEqual(bad,[]); assert.ok(requests.some(p => p.endsWith('/workbooks.js')));
  console.log('Pages browser checks passed: both sources, desktop/mobile, scoped projects, search/filter/CRM, Ask, audit, roles, Excel, guarded replacement, reset and no external/API requests.');
} catch (err) {
  if (page) console.error('Last screen:', (await page.locator('body').innerText().catch(()=>'' )).slice(-2400));
  console.error('Unexpected traffic/errors:',bad); throw err;
} finally { await browser?.close(); await new Promise(r => server.close(r)); fs.rmSync(temp,{recursive:true,force:true}); }
