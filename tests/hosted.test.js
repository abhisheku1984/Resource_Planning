'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..');
const args = ['--disable-warning=ExperimentalWarning', 'server/index.js', '--hosted'];
const secret = () => randomBytes(24).toString('hex');
function environment(dir) {
  const env = { ...process.env, HOST:'127.0.0.1', DATA_DIR:dir, NODE_ENV:'production', RP_SEED_ROWS:'170' };
  for (const key of ['DB_FILE','RP_OWNER_NAME','RP_OWNER_EMAIL','RP_OWNER_PASSWORD']) delete env[key];
  return env;
}
function refused(env, message) {
  const p = spawnSync(process.execPath, args, {cwd:root, env, encoding:'utf8', timeout:10000});
  assert.equal(p.status,1); assert.match(p.stderr,message); assert.doesNotMatch(p.stdout,/is running/);
  return p.stdout + p.stderr;
}
async function launch(env) {
  const lease = net.createServer(); lease.listen(0,'127.0.0.1'); await once(lease,'listening');
  const port = lease.address().port; await new Promise(r => lease.close(r));
  const child = spawn(process.execPath, args, {cwd:root,env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let logs = '';
  const exited = once(child,'exit');
  try {
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Hosted launch timed out')); }, 10000);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.stderr.on('data', chunk => { logs += chunk; });
      child.stdout.on('data', chunk => { logs += chunk; if (/Resource Planning is running/.test(logs)) {clearTimeout(timer); resolve();} });
      child.once('exit', () => {clearTimeout(timer); reject(Error('Hosted service exited before ready'));});
    });
  } catch (err) { child.kill(); throw err; }
  return {base:`http://127.0.0.1:${port}`, logs:()=>logs, stop:async()=>{child.kill(); await exited;}};
}

test('hosted startup refuses missing persistent storage, missing secrets, and fixture DB overrides before listening', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rp-host-config-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env = environment(dir);
  refused({...env,DATA_DIR:path.join(dir,'not-mounted')},/DATA_DIR/);
  refused({...env,DB_FILE:':memory:'},/DB_FILE/);
  assert.deepEqual(fs.readdirSync(dir),[]);
  refused(env,/RP_OWNER_PASSWORD/);
  const weak = 'too-short';
  assert.ok(!refused({...env, RP_OWNER_NAME:'Test',RP_OWNER_EMAIL:'test@example.test',RP_OWNER_PASSWORD:weak},/14–256/).includes(weak));
});

test('hosted login: one initial admin, protected workspace, changed password and second user survive restart without bootstrap secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rp-host-login-'));
  const env = environment(dir), email='owner@example.test', initial=secret(), next=secret(), staffPw=secret();
  const init = {...env,RP_OWNER_NAME:'Test owner',RP_OWNER_EMAIL:email,RP_OWNER_PASSWORD:initial};
  let host;
  async function api(route, body, token) {
    const res = await fetch(host.base+'/api'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}, body:body?JSON.stringify(body):undefined});
    return { status:res.status, data:await res.json(), headers:res.headers };
  }
  const login=(email,password)=>api('/auth/login',{email,password});
  try {
    host = await launch(init);
    assert.equal((await api('/health')).status,200);
    const page = await fetch(host.base+'/login'); assert.equal(page.status,200);
    assert.ok(!(await page.text()).includes(email));
    assert.equal(page.headers.get('access-control-allow-origin'),null);
    assert.ok(page.headers.get('strict-transport-security'));
    assert.equal((await api('/bootstrap')).status,401);
    assert.equal((await login(email,'not valid')).status,401);
    const owner = await login(email,initial); assert.equal(owner.status,200);
    const token = owner.data.token;
    assert.deepEqual((await api('/users',null,token)).data.users.map(u=>[u.email,u.role]),[[email,'admin']]);
    assert.equal((await api('/bootstrap',null,token)).data.user.isAdmin,true);
    assert.equal((await api('/users',{name:'Test staff',email:'staff@example.test',role:'supervisor',password:staffPw},token)).status,200);
    assert.equal((await api('/auth/password',{current:initial,next},token)).status,200);
    assert.equal((await api('/bootstrap',null,token)).status,401);
    assert.ok(!host.logs().includes(initial));
    await host.stop(); host = null;
    host = await launch(env); // the host no longer needs the original secret
    assert.equal((await login(email,initial)).status,401);
    assert.equal((await login(email,next)).status,200);
    const staff = await login('staff@example.test',staffPw); assert.equal(staff.status,200);
    assert.equal((await api('/users',null,staff.data.token)).status,403);
    for(let i=0;i<10;i++) assert.equal((await login('absent@example.test','not valid')).status,401);
    const limited = await login('absent@example.test','not valid'); assert.equal(limited.status,429); assert.ok(Number(limited.headers.get('retry-after'))>0);
    assert.equal((await login(email,next)).status,200);
    await host.stop(); host = null;
    const db = new DatabaseSync(path.join(dir,'resource_planning.db'));
    try { db.exec("UPDATE users SET active=0 WHERE role='admin'"); } finally {db.close();}
    // Even if the original three hosting settings remain, they cannot claim a stranded account.
    refused(init,/cannot reset an existing installation/);
  } finally { if(host) await host.stop(); fs.rmSync(dir,{recursive:true,force:true}); }
});
