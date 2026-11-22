// Adapters used only by the browser build. No server secrets or login system.
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex } = require('@noble/hashes/utils');
const approved = require('./fixture.json').sha256;
const exportsInTab = new Set();
const asBytes = v => typeof v === 'string' ? new TextEncoder().encode(v) : v;
function createHash(algorithm) {
  if (algorithm !== 'sha256') throw Error('Unsupported digest');
  const hash = sha256.create();
  return { update(v) { hash.update(asBytes(v)); return this; }, digest() { return bytesToHex(hash.digest()); } };
}
function randomBytes(size) { const v = crypto.getRandomValues(new Uint8Array(size)); return { toString: () => bytesToHex(v) }; }
async function sendWorkbook(res, wb) {
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  if (exportsInTab.size >= 32) exportsInTab.delete(exportsInTab.values().next().value);
  exportsInTab.add(bytesToHex(sha256(bytes)));
  res.end(bytes);
}
function workbookBytes(content) {
  const base64 = String(content).split(',').pop();
  if (!base64 || base64.length > 20_000_000) throw Object.assign(Error('Choose the sample workbook or an export from this tab.'), {status:422});
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const digest = bytesToHex(sha256(bytes));
  if (digest !== approved && !exportsInTab.has(digest)) throw Object.assign(Error('Not a sample workbook. Choose the unchanged 1,000-row fixture or an unmodified export from this tab. Nothing was imported.'), {status:422});
  return bytes;
}
// There is no on-disk DB to snapshot in Pages. Its separately confirmed Excel
// export is retained by the visitor; reload reconstructs the original fixture.
function saveRestorePoint() {}
module.exports = { createHash, randomBytes, randomUUID: () => crypto.randomUUID(), sendWorkbook, workbookBytes, saveRestorePoint,
  get Workbook() { if (!self.ExcelJS) importScripts('./workbooks.js'); return self.ExcelJS.Workbook; } };
