/* One local Vosk worker per voice session, one fresh recognizer/stream per turn.
   Vosk returns a partial or final result for each chunk. Only a nonempty final
   from the current recognizer can leave this module as a command. */
export function openOfflineInput(modelUrl, { ready, transcript, error }) {
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
      node.port.onmessage = ({ data }) => {
        if (closed || id !== turn) return;
        if (++queued > 40) return fail('too-slow'); // bound queued audio on a slow machine
        worker.postMessage({ action: 'audioChunk', recognizerId, sampleRate, data }, [data.buffer]);
      };
      source.connect(node).connect(ctx.destination);
      timeout(45_000, 'no-speech');
      return true;
    } catch (e) {
      if (!closed && id === turn) fail(({ NotAllowedError: 'not-allowed', NotFoundError: 'audio-capture', NotReadableError: 'audio-capture' })[e.name] || 'capture-failed');
      return false;
    }
  }
  worker.onmessage = ({ data }) => {
    if (closed || !data || (data.recognizerId && data.recognizerId !== recognizerId)) return;
    if (data.event === 'error') return fail('model-error');
    if (data.event === 'load') { clearTimeout(timer); return data.result ? ready() : fail('model-error'); }
    if (data.event === 'partialresult' || data.event === 'result') queued = Math.max(0, queued - 1);
    const text = data.event === 'result' && data.result?.text?.trim();
    if (recognizerId && text) { pause(); transcript(text); }
  };
  worker.onerror = worker.onmessageerror = () => fail('model-error');
  timeout(90_000, 'model-error');
  worker.postMessage({ action: 'set', key: 'logLevel', value: -2 });
  worker.postMessage({ action: 'load', modelUrl, wasmUrl: '/speech/vosk.wasm' });
  return { listen, close };
}
