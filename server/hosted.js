'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Explicit hosted mode only. Check the mount BEFORE requiring db.js, which
// otherwise creates the default database and directory as an import side effect.
function checkDisk() {
  const dir = process.env.DATA_DIR;
  if (!dir || !path.isAbsolute(dir) || process.env.DB_FILE || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw Error('Hosted startup requires an existing mounted directory in DATA_DIR and no DB_FILE override.');
  }
  fs.accessSync(dir, fs.constants.W_OK | fs.constants.R_OK);
  process.umask(0o077);
}

function initialOwner() {
  const { RP_OWNER_NAME: name, RP_OWNER_EMAIL: email, RP_OWNER_PASSWORD: password } = process.env;
  if (!name || !email || !password || password.length < 14 || password.length > 256) {
    throw Error('Set RP_OWNER_NAME, RP_OWNER_EMAIL and a unique RP_OWNER_PASSWORD (14–256 characters) privately on the host.');
  }
  return { name, email, password };
}

// A small single-instance failure budget; no forwarded-IP trust, persistent
// identifier logs or unbounded table of attempted usernames. A reverse proxy /
// identity-aware gateway should also restrict access before handling real PII.
function loginBudget() {
  const interval = 5 * 60_000;
  let until = 0, failures = 0;
  const byId = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (now >= until) { until = now + interval; failures = 0; byId.clear(); }
    const id = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    if (failures >= 200 || (byId.get(id) || 0) >= 10) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((until - now) / 1000))));
      return res.status(429).json({ error: 'Too many sign-in attempts. Please try again in a few minutes.' });
    }
    // Reserve before verification (including aborted requests); refund valid
    // logins. Even concurrent requests cannot grow the map past the budget.
    failures++;
    byId.set(id, (byId.get(id) || 0) + 1);
    const windowEnd = until;
    res.once('finish', () => {
      if (windowEnd !== until || res.statusCode !== 200) return;
      failures--;
      const left = byId.get(id) - 1;
      if (left) byId.set(id, left); else byId.delete(id);
    });
    next();
  };
}
module.exports = { checkDisk, initialOwner, loginBudget };
