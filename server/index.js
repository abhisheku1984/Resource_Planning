'use strict';
const path = require('node:path');
const express = require('express');
const { q, tx } = require('./db');
const auth = require('./auth');
const schema = require('./schema');
const { router } = require('./routes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));

// Preview-host friendly: no origin or host allowlist, and allow iframe embedding.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Export-Rows');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// bearer token sessions
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.token = token;
  req.user = token ? auth.userFromToken(token) : null;
  next();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', router);

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// static SPA
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// bootstrap seed on very first run so the app is never empty
function ensureSeeded() {
  const users = q.get('SELECT COUNT(*) c FROM users').c;
  if (users === 0) {
    console.log('[startup] empty database — creating demo dataset');
    require('./seed').run({ reset: false, quiet: true });
  } else {
    schema.seedFields();
  }
}

if (require.main === module) {
  ensureSeeded();
  app.listen(PORT, HOST, () => {
    console.log(`Resource Planning platform listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { app };
