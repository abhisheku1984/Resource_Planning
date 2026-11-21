'use strict';
const path = require('node:path');
const { runtimes, modelDir, packStatus } = require('../voice/catalog');
const express = require('express');
const assets = require('../voice/assets');

// Read-only allowlist. Never expose node_modules, model staging files or a write/download API.
function speechAssets(root = path.join(__dirname, '../voice')) {
  const router = express.Router();
  function serve(url, file) {
    file = path.join(root, file);
    router.get(url, (req, res) => {
      res.sendFile(file, { maxAge: url.startsWith('/models/') ? '1d' : 0 }, (err) => {
        if (err && !res.headersSent) res.sendStatus(404);
      });
    });
  }
  for (const group of Object.values(runtimes)) for (const [url, file] of Object.entries(group)) serve(url, file);
  for (const a of assets) serve('/models/' + a.file, path.join(modelDir, a.file));
  router.get('/status', (req, res) => res.set('Cache-Control', 'no-store').json(packStatus(root)));
  // Missing runtime/data files must not receive the SPA's HTML fallback.
  router.use((req, res) => res.sendStatus(404));
  return router;
}
module.exports = { speechAssets };
