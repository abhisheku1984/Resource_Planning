'use strict';
// Setup-time only (CLI or Windows launcher), never from the running server.
const fs = require('node:fs');
const { mkdir, rename, rm } = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const assets = require('./assets');

async function verified(file, asset) {
  if (fs.statSync(file, { throwIfNoEntry: false })?.size !== asset.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === asset.sha256;
}
async function install(asset, dir, download = fetch, progress) {
  const file = path.join(dir, asset.file);
  if (await verified(file, asset)) return 'already verified';
  const temp = file + '.' + randomUUID() + '.part';
  const idle = new AbortController();
  let timer;
  function keepAlive() {
    clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('Download stalled')), 30_000); timer.unref();
  }
  try {
    keepAlive();
    const res = await download(asset.url, { headers: { Accept: 'application/vnd.github.raw+json', 'Accept-Encoding': 'identity', 'User-Agent': 'ResourcePlanning-Voice-Setup' }, signal: AbortSignal.any([idle.signal, AbortSignal.timeout(300_000)]) });
    if (!res.ok) throw new Error(`Download returned HTTP ${res.status}`);
    let bytes = 0;
    await pipeline(res.body, async function* (chunks) {
      for await (const chunk of chunks) {
        if ((bytes += chunk.length) > asset.bytes) throw new Error('Download larger than expected');
        keepAlive(); progress?.(bytes); yield chunk;
      }
    }, fs.createWriteStream(temp, { flags: 'wx' }));
    clearTimeout(timer);
    if (!await verified(temp, asset)) throw new Error('Size or SHA-256 mismatch; file was not installed');
    await rename(temp, file);
    return 'installed';
  } finally { clearTimeout(timer); await rm(temp, { force: true }); }
}
async function main() {
  const args = process.argv.slice(2);
  const studio = args[0] === '--studio';
  if (studio) args.shift();
  const [lang] = args;
  if (args.length > 1 || (lang && !['en', 'hi'].includes(lang))) throw new Error('Use npm run voice:setup or npm run voice:studio, optionally followed by -- en or -- hi');
  const dir = path.join(__dirname, '.cache', 'models');
  await mkdir(dir, { recursive: true });
  for (const asset of assets.filter((a) => (a.kind === 'studio') === studio && (!lang || a.lang === lang))) {
    console.log(`Checking ${asset.file} (${Math.ceil(asset.bytes / 1e6)} MB)…`);
    console.log('  ' + await install(asset, dir));
  }
  console.log(studio
    ? 'Ready. Refresh Ask on localhost, choose English or हिन्दी, and select Test speaker. Auto uses Studio when installed.'
    : 'Ready. Open Ask on localhost, choose English or हिन्दी, and select Start voice mode or Test speaker.');
}
if (require.main === module) main().catch((err) => {
  console.error(`Voice setup failed: ${err.cause?.message || err.message}. Check your connection and disk space, then rerun the command. No workbook data was changed.`);
  process.exitCode = 1;
});
module.exports = { install, verified };
