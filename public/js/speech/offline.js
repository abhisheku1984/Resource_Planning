import { openOfflineInput } from './offline-input.js';

// Only the install command downloads files from the internet. A button click
// reads availability on the app origin; it cannot install anything.
async function packs(language) {
  try {
    const res = await fetch('/speech/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return res.ok ? (await res.json())[language] || {} : {};
  } catch { return {}; }
}
function play(modelUrl, text, done) {
  const ctx = new AudioContext();
  let worker, source, timer, closed = false;
  function cancel() {
    if (closed) return;
    closed = true; clearTimeout(timer); worker?.terminate();
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* source never started */ }
    }
    ctx.close().catch(() => {});
  }
  function finish(ok) { if (!closed) { cancel(); done(ok); } }
  // Bound the WAV and WASM heap per chunk, also for long reports in Hindi.
  const chunks = text.match(/.{1,400}(?:\s+|$)|\S{1,400}/gs) || [];
  function next() {
    if (!chunks.length) return finish(true);
    timer = setTimeout(() => finish(false), 90_000);
    worker.postMessage({ modelUrl, text: chunks.shift() });
  }
  try {
    worker = new Worker('/js/speech/speaker-worker.js', { type: 'module' });
    worker.onerror = worker.onmessageerror = () => finish(false);
    const running = ctx.resume(); running.catch(() => finish(false));
    worker.onmessage = async ({ data }) => {
      if (closed) return;
      if (!data.wav) return finish(false);
      try {
        const [audio] = await Promise.all([ctx.decodeAudioData(data.wav), running]);
        if (closed) return;
        clearTimeout(timer);
        source = ctx.createBufferSource(); source.buffer = audio; source.connect(ctx.destination);
        source.onended = () => { source = null; if (!closed) next(); };
        source.start();
      } catch { finish(false); }
    };
    next();
  } catch { finish(false); }
  return cancel;
}
const audioSupported = () => !!(window.Worker && window.AudioContext && window.WebAssembly);
export const offlineSpeech = {
  canListen: () => audioSupported() && !!(window.AudioWorkletNode && navigator.mediaDevices?.getUserMedia),
  canPlay: audioSupported, packs, openInput: openOfflineInput, play,
};
