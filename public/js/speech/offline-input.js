/* One local Vosk worker per voice session, one fresh recognizer/stream per turn.
   Vosk returns a partial or final result for each chunk. Only a nonempty final
   from the current recognizer can leave this module as a command. */
export function openOfflineInput(modelUrl, { ready, transcript, partial, quiet, error }) {
  const worker = new Worker('/speech/vosk.worker.js', { type: 'module' });
  let closed = false, turn = 0, recognizerId = null, stream, ctx, node, timer, queued = 0;
  const release = (media) => media?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  function pause() {
    ++turn; clearTimeout(timer);
    const old = recognizerId; recognizerId = null; queued = 0;
    if (node) { node.onprocessorerror = null; node.port.onmessage = null; node.port.close(); node.disconnect(); node = null; }
    release(stream); stream = null;
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    if (old && !closed) worker.postMessage({ action: 'remove', recognizerId: old });
  }
  function close() {
    if (closed) return;
    closed = true; pause(); worker.terminate();
  }
  function fail(reason) { if (!closed) { close(); error(reason); } }
  function timeout(ms, reason) { clearTimeout(timer); timer = setTimeout(() => fail(reason), ms); }
  async function listen() {
    if (closed) return false;
    const id = ++turn;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      // The browser permission dialog may outlive Stop, closing Ask or switching language.
      if (closed || id !== turn) { release(media); return false; }
      stream = media; stream.getAudioTracks().forEach((track) => { track.onended = () => fail('audio-capture'); });
      ctx = new AudioContext({ sampleRate: 16000 });
      timeout(20_000, 'capture-failed');
      await Promise.all([ctx.resume(), ctx.audioWorklet.addModule('/js/speech/mic-worklet.js')]);
      if (closed || id !== turn) return false;
      const source = ctx.createMediaStreamSource(media), sampleRate = ctx.sampleRate;
      node = new AudioWorkletNode(ctx, 'ask-microphone', { channelCount: 1, channelCountMode: 'explicit' });
      node.onprocessorerror = () => fail('capture-failed');
      recognizerId = String(id);
      worker.postMessage({ action: 'create', recognizerId, sampleRate });
      let signal = false, silentSamples = 0, warned = false;
      node.port.onmessage = ({ data }) => {
        if (closed || id !== turn) return;
        // PCM16 amplitudes. A single hint after five seconds of near-silence,
        // not a recording or an assertion that the device is broken.
        if (!signal) {
          signal = data.some((x) => Math.abs(x) > 48);
          if (warned && signal) quiet?.(false);
          else if (!signal && !warned && (silentSamples += data.length) >= sampleRate * 5) { warned = true; quiet?.(true); }
        }
        if (++queued > 40) return fail('too-slow'); // bound queued audio on a slow machine
        worker.postMessage({ action: 'audioChunk', recognizerId, sampleRate, data }, [data.buffer]);
      };
      source.connect(node).connect(ctx.destination);
      clearTimeout(timer); timer = setTimeout(() => fail(signal ? 'no-speech' : 'no-input'), 45_000);
      return true;
    } catch (e) {
      if (!closed && id === turn) fail(({ NotAllowedError: 'not-allowed', NotFoundError: 'no-device', NotReadableError: 'device-busy' })[e.name] || 'capture-failed');
      return false;
    }
  }
  worker.onmessage = ({ data }) => {
    if (closed || !data || (data.recognizerId && data.recognizerId !== recognizerId)) return;
    if (data.event === 'error') return fail('model-error');
    if (data.event === 'load') { clearTimeout(timer); return data.result ? ready() : fail('model-error'); }
    if (data.event === 'partialresult' || data.event === 'result') queued = Math.max(0, queued - 1);
    if (!recognizerId || data.recognizerId !== recognizerId) return;
    if (data.event === 'partialresult') { partial?.(data.result?.partial?.trim() || ''); return; }
    const text = data.event === 'result' && data.result?.text?.trim();
    if (text) { pause(); transcript(text); }
  };
  worker.onerror = worker.onmessageerror = () => fail('model-error');
  timeout(90_000, 'model-error');
  worker.postMessage({ action: 'set', key: 'logLevel', value: -2 });
  worker.postMessage({ action: 'load', modelUrl, wasmUrl: '/speech/vosk.wasm' });
  return { listen, close };
}
