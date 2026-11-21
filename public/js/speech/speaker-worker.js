import { WASI, File, OpenFile, PreopenDirectory, ConsoleStdout } from '/speech/wasi/index.js';

// No real filesystem, audio device or network API is passed into the synthesizer.
// Its only inputs are the locally served voice and an in-memory UTF-8 text file.
let resources;
async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Voice asset unavailable');
  return res;
}
self.onmessage = async ({ data: { modelUrl, text } }) => {
  try {
    resources ??= Promise.all([
      WebAssembly.compileStreaming(get('/speech/flite.wasm')),
      get(modelUrl).then((r) => r.arrayBuffer()).then((bytes) => new File(bytes, { readonly: true })),
    ]);
    const [module, voice] = await resources;
    const out = new File([]), silent = () => new ConsoleStdout(() => {});
    const fds = [new OpenFile(new File([])), silent(), silent(), new PreopenDirectory('.', [
      ['voice.flitevox', voice], ['input.txt', new File(new TextEncoder().encode(text + '\n'))], ['answer.wav', out],
    ])];
    const wasi = new WASI(['flite', '-voice', 'voice.flitevox', '-f', 'input.txt', '-o', 'answer.wav'], [], fds, { debug: false });
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    if (wasi.start(instance) !== 0 || out.data.length <= 44) throw new Error('No speech generated');
    const wav = out.data.slice().buffer;
    self.postMessage({ wav }, [wav]);
  } catch { self.postMessage({ error: true }); }
};
