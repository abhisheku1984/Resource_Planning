'use strict';
// Shared read-only manifest. Importing this module never runs an installer.
const fs = require('node:fs');
const path = require('node:path');
const assets = require('./assets');
const files = (prefix, dir, names) => Object.fromEntries(names.map((name) => [prefix + name, dir + name]));
const runtimes = {
  input: files('/', 'node_modules/@lichess-org/vosk-browser/dist/', ['vosk.worker.js', 'vosk.wasm']),
  output: { '/flite.wasm': 'node_modules/@echogarden/flite-wasi/flite.wasm',
    ...files('/wasi/', 'node_modules/@bjorn3/browser_wasi_shim/dist/',
      ['debug', 'fd', 'fs_mem', 'fs_opfs', 'index', 'strace', 'wasi', 'wasi_defs'].map((n) => n + '.js')) },
  studio: { ...files('/ort/', 'studio/node_modules/onnxruntime-web/dist/', ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']),
    ...files('/tokens/', 'studio/node_modules/ninada/src/', ['studio_g2p.js', 'g2p.js', 'ipa_g2p.js']) },
};
const modelDir = '.cache/models';
const runtimeReady = (root, kind) => Object.values(runtimes[kind]).every((file) => {
  const stat = fs.statSync(path.join(root, file), { throwIfNoEntry: false });
  return stat?.isFile() && stat.size > 0;
});
function packStatus(root, models = assets) {
  const packs = { en: {}, hi: {} };
  const ready = Object.fromEntries(Object.keys(runtimes).map((k) => [k, runtimeReady(root, k)]));
  for (const a of models) if (ready[a.kind] && fs.statSync(path.join(root, modelDir, a.file), { throwIfNoEntry: false })?.size === a.bytes) {
    packs[a.lang][a.kind] = '/speech/models/' + a.file;
  }
  return packs;
}
module.exports = { runtimes, modelDir, runtimeReady, packStatus };
