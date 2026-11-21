// Opt-in integration check; see voice/README.md. No hardware, native speech
// packs, production DB, external speech service or prerecorded test file needed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to a desktop Chromium/Chrome/Edge executable');
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
async function makeQuestion(page, modelUrl, text, file) {
  const wav = Buffer.from(await page.evaluate(({ modelUrl, text }) => new Promise((resolve, reject) => {
    const worker = new Worker('/js/speech/speaker-worker.js', { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(Error('No WAV produced')); }, 60_000);
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(Error(e.message)); };
    worker.onmessage = ({ data }) => {
      clearTimeout(timer); worker.terminate();
      if (data.wav) resolve(Array.from(new Uint8Array(data.wav))); else reject(Error('Synthesis failed'));
    };
    worker.postMessage({ modelUrl, text });
  }), { modelUrl, text }));
  assert.equal(wav.indexOf('data'), 36); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.ok(wav.subarray(44).some((b) => b !== 0));
  const hz = wav.readUInt32LE(24), pcm = Buffer.concat([Buffer.alloc(2 * hz), wav.subarray(44), Buffer.alloc(6 * hz)]);
  const header = wav.subarray(0, 44); header.writeUInt32LE(pcm.length + 36, 4); header.writeUInt32LE(pcm.length, 40);
  await writeFile(file, Buffer.concat([header, pcm]));
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
      window.tracks = []; window.playbacks = [];
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => { const s = await get(...args); tracks.push(...s.getAudioTracks()); return s; };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) { playbacks.push(tracks.map((t) => t.readyState)); return start.apply(this, args); };
    });
    await page.goto(base); await page.fill('#login-email', 'priya.nair@resourceplanning.io'); await page.fill('#login-pw', 'Super@12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('.assistant-launch').first().click();
    const ask = page.locator('.assistant'), l = (en, hi) => lang === 'hi' ? hi : en;
    const click = (name) => ask.getByRole('button', { name, exact: true }).click();
    await click(l('English', 'हिन्दी')); await ask.locator('.assistant-scope select').selectOption({ label: 'Giga One' });
    await click(l('Test speaker', 'स्पीकर जाँचें')); await page.waitForFunction(() => playbacks.length === 1);
    assert.deepEqual(await page.evaluate(() => playbacks[0]), []); await click(l('Stop playback', 'सुनना रोकें'));
    const [res] = await Promise.all([page.waitForResponse((r) => r.url() === base + '/api/agent/ask', { timeout: 60_000 }), click(l('Start voice mode', 'बोलना शुरू करें'))]);
    const request = res.request().postDataJSON(), answer = await res.json();
    assert.equal(request.language, lang); assert.equal(request.projectName, 'Giga One'); assert.equal(answer.kind, 'count', JSON.stringify(request));
    assert.equal(answer.projectName, request.projectName);
    await page.waitForFunction(() => playbacks.length === 2 && tracks.length === 2);
    assert.deepEqual(await page.evaluate(() => playbacks[1]), ['ended']); await click(l('Stop voice', 'माइक बंद करें'));
    assert.deepEqual(await page.evaluate(() => tracks.map((t) => t.readyState)), ['ended', 'ended']);
    assert.deepEqual(external, []); assert.deepEqual(posts, ['/api/auth/login', '/api/agent/ask']); assert.deepEqual(errors, []);
    console.log(`${lang}: “${request.message}” → “${answer.reply}” → spoken reply → mic resumed → stopped`);
  } finally { await browser.close(); }
}
try {
  const packs = await (await fetch(base + '/speech/status')).json();
  const cases = { en: 'How many people?', hi: 'कुल कितने कर्मचारी हैं?' };
  const browser = await launch();
  try {
    const page = await browser.newPage(); await page.goto(base);
    for (const [lang, text] of Object.entries(cases)) {
      assert.ok(packs[lang]?.input && packs[lang].output, `Run npm run voice:setup first (${lang})`);
      await makeQuestion(page, packs[lang].output, text, path.join(dir, lang + '.wav'));
    }
  } finally { await browser.close(); }
  for (const lang of Object.keys(cases)) await turn(lang, path.join(dir, lang + '.wav'));
} finally {
  await new Promise((resolve) => server.close(resolve)); require('../server/db').db.close(); await rm(dir, { recursive: true, force: true });
}
