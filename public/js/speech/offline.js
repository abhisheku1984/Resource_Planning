import { openOfflineInput } from './offline-input.js';
import { levelSpeech } from './level.js';

// Only the install command downloads files from the internet. A button click
// reads availability on the app origin; it cannot install anything.
async function packs(language) {
  try {
    const res = await fetch('/speech/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return res.ok ? (await res.json())[language] || {} : {};
  } catch { return {}; }
}
function play(modelUrl, text, done, { engine = 'standard', language = 'en', volume = 1, onStart } = {}) {
  const ctx = new AudioContext();
  let worker, source, pending, timer, more = false, closed = false, started = false;
  function cancel() {
    if (closed) return;
    closed = true; clearTimeout(timer); worker?.terminate(); pending = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* source never started */ }
      source.disconnect(); source = null;
    }
    ctx.close().catch(() => {});
  }
  function finish(ok) { if (!closed) { cancel(); done(ok, started); } }
  function request(data) {
    timer = setTimeout(() => finish(false), 90_000);
    worker.postMessage(data);
  }
  function pump() {
    if (closed || source || !pending) return;
    try {
      source = ctx.createBufferSource(); source.buffer = pending; pending = null;
      source.connect(ctx.destination);
      source.onended = () => {
        source.disconnect(); source = null;
        if (pending) pump(); else if (!more) finish(true);
      };
      source.start();
      if (!started) { started = true; onStart?.(); }
      if (more && !closed) request({ next: true });
    } catch { finish(false); }
  }
  try {
    worker = new Worker('/js/speech/speaker-worker.js', { type: 'module' });
    worker.onerror = worker.onmessageerror = () => finish(false);
    const running = ctx.resume(); running.catch(() => finish(false));
    worker.onmessage = async ({ data }) => {
      if (closed) return;
      try {
        let audio;
        if (data.pcm instanceof Float32Array && data.hz === 24000) {
          audio = ctx.createBuffer(1, data.pcm.length, data.hz); audio.copyToChannel(data.pcm, 0);
        } else if (data.wav) audio = await ctx.decodeAudioData(data.wav);
        else return finish(false);
        await running;
        if (closed) return;
        clearTimeout(timer);
        levelSpeech(audio.getChannelData(0), audio.sampleRate, volume);
        pending = audio; more = data.more; pump();
      } catch { finish(false); }
    };
    request({ modelUrl, text, engine, language });
  } catch { finish(false); }
  return cancel;
}
const audioSupported = () => !!(window.Worker && window.AudioContext && window.WebAssembly);
export const offlineSpeech = {
  canListen: () => audioSupported() && !!(window.AudioWorkletNode && navigator.mediaDevices?.getUserMedia),
  canPlay: audioSupported, packs, openInput: openOfflineInput, play,
};
