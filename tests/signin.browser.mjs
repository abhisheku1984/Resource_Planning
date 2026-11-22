// The real sign-in page and real Node API, with a disposable database. Intercept
// the two synthetic HTTPS names locally; this test never contacts a real host.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rp-entry-browser-data-'));
process.env.DATA_DIR = dir; process.env.DB_FILE = ':memory:';
const { app } = require('../server/index'), { db } = require('../server/db');
const email = 'test-owner@example.test', password = randomBytes(24).toString('base64url');
const pages = 'https://project.example.test', team = 'https://workforce.example.test';
const { signInPage } = require('../scripts/sign-in-page');
let server, browser;
try {
  await require('../server/private-setup').initializePrivateApp(async()=>({name:'Test owner',email,password}));
  server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const upstream = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context = await browser.newContext();
  const unexpected = [], requests = [], logins = [];
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin === pages && req.method() === 'GET') {
      if (u.pathname === '/Resource_Planning/') return route.fulfill({contentType:'text/html',body:signInPage({teamOrigin:team},'./')});
      if (['/Resource_Planning/mark.svg','/Resource_Planning/site.css'].includes(u.pathname)) return route.fulfill({body:'',contentType:u.pathname.endsWith('.css')?'text/css':'image/svg+xml'});
    }
    if (u.origin === team) {
      requests.push(u.pathname);
      if(u.pathname === '/api/auth/login') logins.push({method:req.method(), token:req.headers().authorization});
      return route.fulfill({response:await route.fetch({url:upstream+u.pathname+u.search,maxRedirects:0})});
    }
    unexpected.push(u.origin+u.pathname); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror',err => unexpected.push(err.message));
  const entry = pages+'/Resource_Planning/?next=https://ignored.example/#/directory';
  const submit = async pw => {
    await page.getByLabel('Login ID (email)').fill(email);
    await page.getByLabel('Password',{exact:true}).fill(pw);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
  };
  for (let visit=0; visit<2; visit++) {
    requests.length=0;
    await page.goto(entry); await page.waitForURL(team+'/login');
    await page.getByRole('heading',{name:'Sign in to Resource Planning'}).waitFor();
    assert.equal(page.url(),team+'/login');
    assert.equal(await page.locator('nav').count(),0);
    assert.deepEqual(await page.locator('form input').evaluateAll(els=>els.map(el=>el.value)),['','']);
    assert.ok(!requests.includes('/api/bootstrap'));
    if (visit === 0) {
      await submit('wrong'); await page.getByRole('alert').waitFor();
      assert.ok(!requests.includes('/api/bootstrap')); assert.equal(page.url(),team+'/login');
    } else assert.ok(await page.evaluate(()=>!!localStorage.getItem('rp.token')), 'valid prior session is not used at the login entry');
    await submit(password); await page.getByRole('navigation',{name:'Primary'}).waitFor();
    await page.getByRole('button',{name:'Open project workspace'}).waitFor();
    assert.equal(page.url(),team+'/');
  }
  assert.deepEqual(logins,Array.from({length:3},()=>({method:'POST',token:undefined})));
  assert.deepEqual(unexpected,[]);
  console.log('Configured GitHub entry → private /login → dashboard, including a repeat visit with a valid saved session. No credential requests to Pages.');
} finally {
  await browser?.close(); if (server) await new Promise(r=>server.close(r)); db.close(); fs.rmSync(dir,{recursive:true,force:true});
}
