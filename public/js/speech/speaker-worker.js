import { phrases } from './phrases.js';

// One worker (and one model) per utterance. Pull at most one phrase ahead, so
// Stop can interrupt even a long inference and a report cannot fill the heap.
let engine, chunks, index = 0, model, language;
self.onmessage = async ({ data }) => {
  try {
    if (!data.next) {
      const studio = data.engine === 'studio';
      language = data.language === 'hi' ? 'hi' : 'en'; model = data.modelUrl;
      engine = studio ? await import('./studio.js') : await import('./flite.js');
      chunks = phrases(studio ? engine.prepare(data.text, language) : data.text, studio ? 100 : 400);
      index = 0;
    }
    if (!chunks[index]) throw new Error('Empty speech');
    const result = await engine.synthesize(model, chunks[index++], language);
    self.postMessage({ ...result, more: index < chunks.length }, [result.wav || result.pcm.buffer]);
  } catch { self.postMessage({ error: true }); }
};
