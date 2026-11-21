// Opt-in integration check; see voice/README.md. No hardware, native speech
// packs, production DB, external speech service or prerecorded test file needed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to a desktop Chromium/Chrome/Edge executable');
const studio = process.argv.includes('--studio'), engine = studio ? 'studio' : 'standard';
const require = createRequire(import.meta.url);
const dir = await mkdtemp(path.join(tmpdir(), 'ask-audio-'));
process.env.DB_FILE = ':memory:'; process.env.DATA_DIR = dir;
const { app } = require('../server/index');
require('../server/seed').run({ quiet: true });
const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const launch = (args = []) => chromium.launch({ executablePath: process.env.CHROME_PATH, args, headless: true });

// Use the actual local voice to make a PCM WAV for Chromium's file-backed
// getUserMedia device. Silence at both ends gives Vosk a natural turn boundary.
async function makeQuestion(page, modelUrl, language, text, file) {
  const { samples, hz, before, after } = await page.evaluate(async (params) => {
    const { levelSpeech } = await import('/js/speech/level.js');
    const data = await new Promise((resolve, reject) => {
      const worker = new Worker('/js/speech/speaker-worker.js', { type: 'module' });
      const timer = setTimeout(() => { worker.terminate(); reject(Error('No speaker output')); }, 90_000);
      worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(Error(e.message)); };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer); worker.terminate();
        if (data.error || data.more) reject(Error('Expected one spoken question')); else resolve(data);
      };
      worker.postMessage(params);
    });
    let pcm = data.pcm, hz = data.hz;
    if (params.engine === 'standard') {
      const wave = new DataView(data.wav); hz = wave.getUint32(24, true);
      if (wave.getUint16(22, true) !== 1 || wave.getUint16(34, true) !== 16) throw Error('Expected mono PCM16');
      pcm = Float32Array.from(new Int16Array(data.wav, 44), (x) => x / 32768);
    } else if (hz !== 24000 || !(pcm instanceof Float32Array)) throw Error('Expected Studio PCM');
    function measure() {
      let sq = 0, pk = 0; for (const x of pcm) { sq += x * x; pk = Math.max(pk, Math.abs(x)); }
      return { rms: Math.sqrt(sq / pcm.length), peak: pk };
    }
    const before = measure(); levelSpeech(pcm, hz);
    return { samples: Array.from(pcm, (x) => Math.round(x * 32767)), hz, before, after: measure() };
  }, { modelUrl, language, text, engine });
  assert.ok(before.rms > 0 && after.rms > 0 && after.peak <= 0.891);
  const db = (x) => (20 * Math.log10(x)).toFixed(1);
  console.log(`${language} ${engine} · ${hz} Hz · RMS ${db(before.rms)} → ${db(after.rms)} dBFS · peak ${db(after.peak)} dBFS`);
  const pcm = Buffer.alloc(2 * (samples.length + 4 * hz)); samples.forEach((x, i) => pcm.writeInt16LE(x, (i + hz) * 2));
  const head = Buffer.alloc(44); head.write('RIFF'); head.writeUInt32LE(pcm.length + 36, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(hz, 24);
  head.writeUInt32LE(hz * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  await writeFile(file, Buffer.concat([head, pcm]));
}
async function turn(lang, file) {
  const browser = await launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${file}`]);
  try {
    const context = await browser.newContext({ permissions: ['microphone'] });
    const page = await context.newPage(), external = [], posts = [], errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    context.on('request', (req) => {
      if (!req.url().startsWith(base + '/')) external.push(req.url());
      if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
    });
    await page.addInitScript(() => {
      for (const key of ['SpeechRecognition', 'webkitSpeechRecognition', 'speechSynthesis']) Object.defineProperty(window, key, { value: undefined });
      // Observe real lifetimes; do not simulate transcripts or speaker events.
      window.tracks = []; window.playbacks = []; window.levels = [];
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => { const s = await get(...args); tracks.push(...s.getAudioTracks()); return s; };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        playbacks.push(tracks.map((t) => t.readyState));
        let peak = 0; for (const x of this.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(x));
        levels.push({ peak, hz: this.buffer.sampleRate }); return start.apply(this, args);
      };
    });
    await page.goto(base); await page.fill('#login-email', 'priya.nair@resourceplanning.io'); await page.fill('#login-pw', 'Super@12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('.assistant-launch').first().click();
    const ask = page.locator('.assistant'), l = (en, hi) => lang === 'hi' ? hi : en;
    const click = (name) => ask.getByRole('button', { name, exact: true }).click();
    await click(l('English', 'हिन्दी')); await ask.locator('.assistant-scope select').selectOption({ label: 'Giga One' });
    await ask.locator('.voice-help summary').click();
    if (studio) {
      // Leave Auto selected; exercise the boost and verify the actual buffers below.
      const volume = ask.getByRole('slider', { name: l('Volume', 'वॉल्यूम') });
      await volume.press('End'); assert.equal(await volume.inputValue(), '200');
    } else await ask.locator('#ask-speaker-mode').selectOption('standard');
    await ask.locator('.voice-help summary').click();
    // Cold mic: no speaker test, AudioContext warm-up or native language pack first.
    assert.deepEqual(await page.evaluate(() => [tracks.length, playbacks.length]), [0, 0]);
    const [res] = await Promise.all([page.waitForResponse((r) => r.url() === base + '/api/agent/ask', { timeout: 60_000 }), click(l('Start voice mode', 'बोलना शुरू करें'))]);
    const request = res.request().postDataJSON(), answer = await res.json();
    assert.equal(request.language, lang); assert.equal(request.projectName, 'Giga One'); assert.equal(answer.kind, 'count', JSON.stringify(request));
    assert.equal(answer.projectName, request.projectName);
    await page.waitForFunction(() => playbacks.length === 1 && tracks.length === 2, null, { timeout: 100_000 });
    assert.deepEqual(await page.evaluate(() => playbacks[0]), ['ended']); await click(l('Stop voice', 'माइक बंद करें'));
    assert.deepEqual(await page.evaluate(() => tracks.map((t) => t.readyState)), ['ended', 'ended']);
    await click(l('Close assistant', 'सहायक बंद करें')); await page.locator('.assistant-launch').first().click();
    await click(l('Test speaker', 'स्पीकर जाँचें')); await page.waitForFunction(() => playbacks.length === 2, null, { timeout: 100_000 });
    assert.deepEqual(await page.evaluate(() => playbacks[1]), ['ended', 'ended']); await click(l('Stop playback', 'सुनना रोकें'));
    for (const { hz, peak } of await page.evaluate(() => levels)) {
      if (studio) assert.equal(hz, 24000, 'no silent fallback to the standard pack');
      assert.ok(peak > 0.1 && peak <= 0.891, `unexpected playback peak ${peak}`);
    }
    assert.deepEqual(external, []); assert.deepEqual(posts, ['/api/auth/login', '/api/agent/ask']); assert.deepEqual(errors, []);
    console.log(`${lang}: “${request.message}” → “${answer.reply}” → spoken reply → mic resumed → stopped; standalone speaker did not open the mic`);
  } finally { await browser.close(); }
}
try {
  const packs = await (await fetch(base + '/speech/status')).json();
  const cases = { en: 'How many people?', hi: 'कुल कितने कर्मचारी हैं?' };
  const browser = await launch();
  try {
    const page = await browser.newPage(); await page.goto(base);
    for (const [lang, text] of Object.entries(cases)) {
      const model = packs[lang]?.[studio ? 'studio' : 'output'];
      assert.ok(packs[lang]?.input && model, `Install voice:setup${studio ? ' and voice:studio' : ''} first (${lang})`);
      await makeQuestion(page, model, lang, text, path.join(dir, lang + '.wav'));
    }
  } finally { await browser.close(); }
  for (const lang of Object.keys(cases)) await turn(lang, path.join(dir, lang + '.wav'));
} finally {
  await new Promise((resolve) => server.close(resolve)); require('../server/db').db.close(); await rm(dir, { recursive: true, force: true });
}
