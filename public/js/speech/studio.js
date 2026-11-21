// Only imported inside the speaker worker, on an explicit local playback.
import * as ort from '/speech/ort/ort.wasm.min.mjs';
import { cleanStudioText, studioTextToIds, STUDIO_SAMPLE_RATE } from '/speech/tokens/studio_g2p.js';
import { englishToDevanagari } from '/speech/tokens/g2p.js';
import { spokenText } from './studio-text.js';

ort.env.wasm.wasmPaths = new URL('/speech/ort/', self.location.href).href;
ort.env.wasm.numThreads = 1; // no child/blob worker, cross-origin isolation or GPU needed
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';
let session;
export function prepare(text, language) {
  return cleanStudioText(spokenText(text, language, englishToDevanagari), language);
}
export async function synthesize(modelUrl, text, language) {
  const { studioIds: ids, lang } = studioTextToIds(text, language);
  if (lang !== language) throw new Error('Unsupported script for this voice');
  session ??= await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    scales: new ort.Tensor('float32', Float32Array.from(language === 'hi' ? [1, 0.40, 0] : [1, 0.56, 0.616]), [3]),
  };
  let out;
  try {
    out = await session.run(feeds);
    const pcm = out.waveform.data.slice();
    if (!pcm.length) throw new Error('No speech generated');
    return { pcm, hz: STUDIO_SAMPLE_RATE };
  } finally {
    for (const tensor of [...Object.values(feeds), ...Object.values(out || {})]) tensor.dispose();
  }
}
