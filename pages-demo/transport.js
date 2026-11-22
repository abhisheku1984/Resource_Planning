let worker, sequence = 0;
const pending = new Map();
function engine() {
  if (worker) return worker;
  worker = new Worker(new URL('./engine.js', import.meta.url));
  worker.onmessage = ({data}) => {
    const receive = pending.get(data.id);
    if (receive) receive(new Response(data.body, {status:data.status, headers:data.headers}));
  };
  worker.onerror = () => {
    worker.terminate(); worker = null;
    for (const receive of pending.values()) receive(Response.json({error:'Could not open the browser demo. Reload in a current browser.'}, {status:503}));
  };
  return worker;
}
export function request(path, {method = 'GET', body, signal} = {}) {
  signal?.throwIfAborted();
  const target = engine(), id = ++sequence;
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); reject(new DOMException('Aborted','AbortError')); };
    signal?.addEventListener('abort', abort, {once:true});
    pending.set(id, res => { pending.delete(id); signal?.removeEventListener('abort',abort); resolve(res); });
    target.postMessage({ id, path, method, body: body ? JSON.parse(body) : undefined });
  });
}
// A sentinel for the UI's bootstrap, never a real bearer token. Do not read
// or write credentials in the github.io origin's shared localStorage.
export const readToken = () => 'sample-workspace';
export const storeToken = () => {};
