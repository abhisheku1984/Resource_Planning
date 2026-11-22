'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');

// This folder is published verbatim on the public Internet. Adding another
// asset should be deliberate; never publish the checkout or an operator's DB.
test('Pages publishes only the static guide, not the workforce application or roster', () => {
  const entries = fs.readdirSync(docs, { withFileTypes: true });
  assert.deepEqual(entries.map(e => e.name).sort(), ['.nojekyll', 'index.html', 'mark.svg', 'site.css']);
  assert.ok(entries.every(e => e.isFile()), 'no symlinks or bundled private directories');
  assert.doesNotMatch(html, /<(?:script|iframe|form|input)\b|\/api\/|localhost:|@resourceplanning\.io/i);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /GitHub Pages/);
});

test('guide assets, section links and linked repository files resolve at the project-site path', () => {
  const base = new URL('https://abhisheku1984.github.io/Resource_Planning/');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const blob = '/abhisheku1984/Resource_Planning/blob/main/';
  for (const [, raw] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const url = new URL(raw.replaceAll('&amp;', '&'), base);
    if (url.origin === base.origin) {
      assert.ok(url.pathname.startsWith(base.pathname), `root-relative link escapes the Pages site: ${raw}`);
      if (url.hash) assert.ok(ids.has(url.hash.slice(1)), `missing section: ${raw}`);
      if (url.pathname !== base.pathname) assert.ok(fs.statSync(path.join(docs, url.pathname.slice(base.pathname.length))).isFile());
    } else {
      assert.equal(url.origin, 'https://github.com', `unexpected external destination: ${raw}`);
      if (url.pathname.startsWith(blob)) assert.ok(fs.statSync(path.join(root, url.pathname.slice(blob.length))).isFile());
    }
  }
});
