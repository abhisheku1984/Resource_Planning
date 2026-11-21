'use strict';
// Windows launcher preflight. This process finishes BEFORE the web server starts.
// Never import this module in an HTTP handler. No database, audio or browser input.
const path = require('node:path');
const { mkdir, mkdtemp, copyFile, rename, rm } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { packStatus, runtimeReady, modelDir } = require('./catalog');
const { verified, install } = require('./setup');
const assets = require('./assets');

// npm ci removes its target node_modules first. Stage its work so a failed or
// interrupted download doesn't uninstall an existing mic or speaker engine.
async function installRuntime(root) {
  if (!process.env.npm_execpath) throw new Error('Use the Windows launcher or npm run voice:prepare');
  const stage = await mkdtemp(path.join(root, '.cache', 'prepare-'));
  const dest = path.join(root, 'node_modules'), backup = path.join(root, '.cache', 'old-runtime-' + randomUUID());
  try {
    for (const file of ['package.json', 'package-lock.json']) await copyFile(path.join(root, file), path.join(stage, file));
    // npm_execpath is supplied by the launcher's npm run. No shell or quoting of Windows paths.
    execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      '--fetch-retries=1', '--fetch-timeout=30000'], { cwd: stage, stdio: 'inherit', timeout: 120_000 });
    if (!runtimeReady(stage, 'input') || !runtimeReady(stage, 'output')) throw new Error('Incomplete voice runtime');
    let saved = true;
    try { await rename(dest, backup); } catch (e) { if (e.code !== 'ENOENT') throw e; saved = false; }
    try { await rename(path.join(stage, 'node_modules'), dest); }
    catch (e) { if (saved) await rename(backup, dest); throw e; }
    if (saved) await rm(backup, { recursive: true, force: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function prepare({ root = __dirname, models = assets, runtime = installRuntime, download = fetch, log = console.log } = {}) {
  const packs = packStatus(root, models), dir = path.join(root, modelDir);
  // Always prepare both microphone languages; don't replace or redownload Studio.
  const wanted = [...models.filter((a) => a.kind === 'input'), ...models.filter((a) => a.kind === 'output' && !packs[a.lang].studio)];
  const missing = [];
  for (const a of wanted) if (!await verified(path.join(dir, a.file), a)) missing.push(a);
  const engines = !runtimeReady(root, 'input') || (wanted.some((a) => a.kind === 'output') && !runtimeReady(root, 'output'));
  if (engines || missing.length) {
    log(`Preparing Ask for offline use (one time): ${Math.ceil(missing.reduce((sum, a) => sum + a.bytes, 0) / 1e6)} MB of voice files${engines ? ' plus runtime' : ''}.`);
    await mkdir(dir, { recursive: true });
    if (engines) await runtime(root);
    for (const a of missing) {
      const label = `${a.lang === 'en' ? 'Indian English' : 'Hindi'} ${a.kind === 'input' ? 'microphone' : 'speaker'}`;
      log(`Downloading ${label}...`); let step = 0;
      try {
        await install(a, dir, download, (n) => {
          const next = Math.floor(n / a.bytes * 4);
          if (next > step) { step = next; log(`  ${label}: ${step * 25}%`); }
        });
      } catch (e) { throw new Error(`${label}: ${e.cause?.message || e.message}`); }
    }
  }
  log('Ask voice ready: Indian English and Hindi.');
}
if (require.main === module) prepare().catch((e) => {
  console.error(`Voice preparation did not finish: ${e.message}.`);
  process.exitCode = 1;
});
module.exports = { prepare };
