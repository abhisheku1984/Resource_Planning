'use strict';
// Stream large workbooks on the Node server; Pages uses the browser writer.
async function sendWorkbook(res, wb) {
  await wb.xlsx.write(res);
  res.end();
}
function workbookBytes(content) { return Buffer.from(String(content).split(',').pop(), 'base64'); }
module.exports = { sendWorkbook, workbookBytes };
