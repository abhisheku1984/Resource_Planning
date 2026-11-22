// Run the application's own registered handlers and permission middleware in
// a worker, not an HTTP server. This deliberately implements only their small
// request/response contract; it neither listens on a port nor makes a fetch.
function Router() {
  const routes = []; let onError;
  const router = { use(fn) { onError = fn; } };
  for (const method of ['get','post','put','patch','delete']) {
    router[method] = (path, ...handlers) => routes.push({ method: method.toUpperCase(), parts: path.split('/'), handlers });
  }
  router.dispatch = (req, pathname) => new Promise((resolve, reject) => {
    const parts = pathname.split('/');
    const route = routes.find(r => r.method === req.method && r.parts.length === parts.length && r.parts.every((p,i) => p[0] === ':' || p === parts[i]));
    let status = 200; const headers = {};
    const res = { status(v) { status = v; return res; }, setHeader(k,v) { headers[k] = v; },
      json(v) { headers['Content-Type']='application/json'; resolve({status,headers,body:JSON.stringify(v)}); },
      end(bytes) { resolve({ status, headers, body: bytes }); } };
    if (!route) return res.status(404).json({ error: 'This action is not available in the sample workspace.' });
    req.params = Object.fromEntries(route.parts.flatMap((p,i) => p[0] === ':' ? [[p.slice(1), decodeURIComponent(parts[i])]] : []));
    let i = 0;
    function next(err) {
      if (err) return onError(err,req,res,reject);
      try { Promise.resolve(route.handlers[i++](req,res,next)).catch(next); } catch (e) { next(e); }
    }
    next();
  });
  return router;
}
module.exports = { Router };
