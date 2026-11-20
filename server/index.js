'use strict';
const path = require('node:path');
const express = require('express');
const { q, tx } = require('./db');
const auth = require('./auth');
const schema = require('./schema');
const { router } = require('./routes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
// Bind to loopback by default: only this machine can reach the app.
// Set HOST=0.0.0.0 (or start-windows.bat --lan) when you deliberately want
// other people on your network to connect.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));

// Preview-host friendly: no origin or host allowlist, and allow iframe embedding.
app.use((req, res, next) => {
  // --- security headers ---
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // Everything this app loads is same-origin; no third-party scripts, no fonts
  // or analytics from anywhere else.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
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
    const where = HOST === '127.0.0.1' || HOST === 'localhost'
      ? `http://localhost:${PORT}  (this computer only)`
      : `http://${HOST}:${PORT}  (reachable from your network)`;
    console.log(`Resource Planning platform listening on ${where}`);
  });
}

module.exports = { app };
