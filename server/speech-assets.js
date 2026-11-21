'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const assets = require('../voice/assets');

// Read-only allowlist. Never expose node_modules, model staging files or a write/download API.
function speechAssets(root = path.join(__dirname, '../voice')) {
  const router = express.Router();
  const files = new Map();
  function serve(url, file) {
    file = path.join(root, file);
    files.set(url, file);
    router.get(url, (req, res) => {
      res.sendFile(file, { maxAge: url.startsWith('/models/') ? '1d' : 0 }, (err) => {
        if (err && !res.headersSent) res.sendStatus(404);
      });
    });
  }
  const vosk = 'node_modules/@lichess-org/vosk-browser/dist/';
  const wasi = 'node_modules/@bjorn3/browser_wasi_shim/dist/';
  serve('/vosk.worker.js', vosk + 'vosk.worker.js');
  serve('/vosk.wasm', vosk + 'vosk.wasm');
  serve('/flite.wasm', 'node_modules/@echogarden/flite-wasi/flite.wasm');
  for (const name of ['debug', 'fd', 'fs_mem', 'fs_opfs', 'index', 'strace', 'wasi', 'wasi_defs']) serve(`/wasi/${name}.js`, `${wasi}${name}.js`);
  for (const a of assets) serve('/models/' + a.file, '.cache/models/' + a.file);
  router.get('/status', (req, res) => {
    const packs = { en: {}, hi: {} };
    const has = (url) => fs.existsSync(files.get(url));
    const input = has('/vosk.wasm') && has('/vosk.worker.js');
    const output = has('/flite.wasm') && has('/wasi/index.js');
    for (const a of assets) {
      const url = '/models/' + a.file;
      if ((a.kind === 'input' ? input : output) && fs.statSync(files.get(url), { throwIfNoEntry: false })?.size === a.bytes) packs[a.lang][a.kind] = '/speech' + url;
    }
    res.set('Cache-Control', 'no-store').json(packs);
  });
  // Missing runtime/data files must not receive the SPA's HTML fallback.
  router.use((req, res) => res.sendStatus(404));
  return router;
}
module.exports = { speechAssets };
