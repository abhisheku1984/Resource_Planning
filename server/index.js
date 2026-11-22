'use strict';
const path = require('node:path');
const express = require('express');
const hosted = require.main === module && process.argv.includes('--hosted');
if (hosted) {
  try { require('./hosted').checkDisk(); }
  catch (err) { console.error('[startup]', err.message); process.exit(1); }
}
const auth = require('./auth');
const { initializePrivateApp } = require('./private-setup');
const { router } = require('./routes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
// Bind to loopback by default: only this machine can reach the app.
// Set HOST=0.0.0.0 (or start-windows.bat --lan) when you deliberately want
// other people on your network to connect.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The hosted preview is embedded by Arena; local/Windows installs keep their
// original same-origin framing policy. This does not relax scripts or API auth.
const FRAME_ANCESTORS = !hosted && process.env.ARENA_PREVIEW === '1'
  ? "frame-ancestors 'self' https://arena.ai https://*.arena.ai" : "frame-ancestors 'self'";

app.disable('x-powered-by');

// Preview-host friendly: no origin or host allowlist, and allow iframe embedding.
app.use((req, res, next) => {
  // --- security headers ---
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=()');
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
    FRAME_ANCESTORS,
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  res.removeHeader('X-Frame-Options');
  if (hosted) {
    // The login form and API share one HTTPS origin; Pages never calls the API.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Export-Rows');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

if (hosted) app.post('/api/auth/login', express.json({ limit: '4kb' }), require('./hosted').loginBudget());
app.use(express.json({ limit: '40mb' }));

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

// Static SPA. The app is plain ES modules with no build step, so a browser that
// caches a module will keep running old code after an update - which looks like
// "the new feature is missing". Force a revalidation on every asset.
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: 0,
  etag: true,
  setHeaders(res, filePath) {
    const rel = path.relative(PUBLIC_DIR, filePath);
    if (rel === 'index.html' || rel.endsWith('.js') || rel.endsWith('.css') || rel.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // fonts and other binary assets can be cached; they change rarely
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));
app.get('*', (req, res, next) => {
  // Never return the SPA document as a missing asset or legacy model response.
  if (req.path.startsWith('/api/') || /^\/speech(?:\/|$)/.test(req.path) || path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

async function start() {
  // The first administrator is configured on the host, before opening a port.
  try {
    await initializePrivateApp(hosted ? require('./hosted').initialOwner : undefined, { firstAccountOnly: hosted });
  } finally {
    if (hosted) delete process.env.RP_OWNER_PASSWORD;
  }
  app.listen(PORT, HOST, () => {
    const local = HOST === '127.0.0.1' || HOST === 'localhost';
    console.log('');
    console.log('  Resource Planning is running.');
    console.log(hosted ? '  Open:   your HTTPS service address followed by /login' : process.env.CODESPACES === 'true'
      ? `  Open:   Codespaces Ports tab > port ${PORT} (Private) > Open in Browser`
      : `  Open:   http://localhost:${PORT}`);
    console.log(`  Bound:  ${HOST}:${PORT}  ${local ? '(this computer only)' : '(reachable from your network)'}`);
    if (!local && !hosted) {
      console.log('');
      console.log('  WARNING: HOST is set to ' + HOST + ', so other machines on your');
      console.log('           network can open this app. Unset HOST to restrict it.');
    }
    console.log('');
    console.log('  Stop:    Ctrl+C');
    console.log('');
  });
}

if (require.main === module) start().catch(err => {
  console.error('[startup]', err.message);
  process.exitCode = 1;
});

module.exports = { app };
