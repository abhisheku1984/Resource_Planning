// One worker per tab. Reuse the same query, validation, CRM, Excel and audit
// code as Windows. No cookies, sign-in, HTTP API or persistence on Pages.
const { openSample, q, batch } = require('./db');
const { hydrateUser } = require('../server/permissions');
const { router } = require('../server/routes');
const session = crypto.randomUUID();
let userId, ready;
const json = (status, data) => ({status, headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
async function handle({ path, method = 'GET', body }) {
  ready ??= openSample().then(() => { userId = q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").id; });
  await ready;
  const url = new URL(path, 'https://sample.invalid');
  if (!url.pathname.startsWith('/api/')) return json(404, {error:'Not a sample action.'});
  const route = url.pathname.slice(4);
  if (route.startsWith('/auth/') || (route === '/users' && method === 'POST')
      || /^\/users\/[^/]+\/login-id$/.test(route)
      || (route.startsWith('/users/') && method === 'PATCH' && Object.hasOwn(body || {}, 'password'))) {
    return json(403, {error:'This is a sample workspace, not a sign-in service.'});
  }
  if (route === '/demo/personas' && method === 'GET') return json(200, { personas: q.all('SELECT id,name,title FROM users WHERE active=1 ORDER BY id') });
  if (route === '/demo/persona' && method === 'POST') {
    if (!q.get('SELECT id FROM users WHERE id=? AND active=1', body.id)) return json(422, {error:'Choose a sample account.'});
    userId = body.id; return json(200, {ok:true});
  }
  const query = Object.create(null);
  for (const [raw,v] of url.searchParams) {
    const key = raw.replace(/\[\]$/, '');
    if (raw.endsWith('[]') || Object.hasOwn(query,key)) query[key] = [].concat(query[key] ?? [], v);
    else query[key] = v;
  }
  const user = { ...hydrateUser(q.get('SELECT * FROM users WHERE id=?', userId)), browserDemo:true };
  return batch(() => router.dispatch({ method, query, body, user, token: session+':'+userId }, route));
}
let queue = Promise.resolve(); // serialize mutations, including async workbook previews
self.onmessage = ({data}) => {
  queue = queue.then(async () => {
    let result;
    try { result = await handle(data); }
    catch (err) { result = json(503, {error: 'Sample workspace unavailable: '+err.message+'. Reload this page to try again.'}); }
    self.postMessage({ id: data.id, ...result }, result.body instanceof Uint8Array ? [result.body.buffer] : []);
  });
};
