'use strict';
// Build-time navigation only. Never take the destination from a visitor, a URL
// parameter, browser storage or an environment variable in the Pages build.
const { isIP } = require('node:net');
const setup = 'https://github.com/abhisheku1984/Resource_Planning/blob/main/HOSTING.md';

function loginTarget(config) {
  if (!config || Object.keys(config).join() !== 'teamOrigin') throw Error('deploy/site.json must contain only teamOrigin.');
  if (config.teamOrigin === null) return null;
  const raw = config.teamOrigin;
  const invalid = () => { throw Error('teamOrigin must be the permanent HTTPS origin of your own app server, without a path, credentials, query or fragment.'); };
  if (typeof raw !== 'string' || !/^https:\/\/[a-z\d.-]+(?::\d+)?\/?$/i.test(raw)) invalid();
  let url;
  try { url = new URL(raw); } catch { invalid(); }
  const host = url.hostname;
  const labels = host.split('.');
  if (isIP(host) || labels.length < 2 || labels.some(n => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(n)) ||
      ['localhost','github.com','github.io','github.dev','e2b.app'].some(d => host === d || host.endsWith('.' + d))) invalid();
  return url.origin + '/login';
}

function signInPage(config, assets) {
  const target = loginTarget(config);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#133649">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'">${target ? `\n  <meta http-equiv="refresh" content="0;url=${target}">` : ''}
  <title>Sign in · Resource Planning</title>
  <link rel="icon" href="${assets}mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${assets}site.css">
</head>
<body class="entry-page">
  <main class="entry-card">
    <div class="entry-brand"><img src="${assets}mark.svg" width="40" height="40" alt="">Resource Planning</div>
    <p class="entry-kicker">Team workspace</p>
    <h1>Sign in to Resource Planning</h1>
    ${target ? `<p>Opening your team’s sign-in page at <strong>${new URL(target).host}</strong>. Use your Resource Planning ID and password there, not your GitHub password.</p>
    <a class="entry-action" href="${target}" rel="noreferrer">Continue to sign in →</a>` : `<p>The team server hasn’t been connected yet. Once it’s connected, this link will open the app’s login page. Don’t enter a password on GitHub Pages.</p>
    <a class="entry-action" href="${setup}" rel="noreferrer">Owner: connect team sign-in →</a>`}
    <aside class="entry-demo"><strong>Just exploring?</strong> <a href="./sample.html">Open the fictional sample</a> — no account or real staff data.</aside>
  </main>
</body>
</html>
`;
}
module.exports = { loginTarget, signInPage };
