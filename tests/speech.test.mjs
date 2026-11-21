import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { install } from '../voice/setup.js';
import { prepare } from '../voice/prepare.js';
import { runtimes, modelDir, packStatus } from '../voice/catalog.js';
import models from '../voice/assets.js';
import express from 'express';
import { speechAssets } from '../server/speech-assets.js';
import { createLocalVoice, speakerSettings } from '../public/js/voice.js';
import { levelSpeech } from '../public/js/speech/level.js';
import { spokenText } from '../public/js/speech/studio-text.js';
import { phrases } from '../public/js/speech/phrases.js';
import { offlineSpeech } from '../public/js/speech/offline.js';
import { openOfflineInput } from '../public/js/speech/offline-input.js';

function replace(t, obj, key, value) {
  const old = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, value });
  t.after(() => old ? Object.defineProperty(obj, key, old) : delete obj[key]);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('voice CLI verifies bytes before publishing; refused or corrupt downloads never replace the old file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'voice-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('verified fixture'), asset = { file: 'example', url: 'test', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const file = path.join(dir, asset.file); await writeFile(file, 'previous');
  for (const res of [new Response(null, { status: 403 }), new Response('too short'), new Response(Buffer.alloc(bytes.length)), new Response(Buffer.alloc(bytes.length + 2))]) {
    await assert.rejects(install(asset, dir, async () => res));
    assert.equal(await readFile(file, 'utf8'), 'previous'); assert.deepEqual(await readdir(dir), [asset.file]);
  }
  assert.equal(await install(asset, dir, async () => new Response(bytes)), 'installed');
  assert.equal(await install(asset, dir, () => assert.fail('no redundant download')), 'already verified');
});

function workerHarness(t, getUserMedia) {
  let worker, node, closedContext = 0;
  replace(t, globalThis, 'navigator', { mediaDevices: { getUserMedia } });
  replace(t, globalThis, 'Worker', class {
    constructor(url) { assert.equal(url, '/speech/vosk.worker.js'); this.messages = []; worker = this; }
    postMessage(m) { this.messages.push(m); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage({ data }); }
  });
  replace(t, globalThis, 'AudioContext', class {
    audioWorklet = { addModule: async (url) => assert.match(url, /mic-worklet.js$/) };
    sampleRate = 16000; async resume() {} async close() { closedContext++; }
    createMediaStreamSource() { return { connect(node) { return node; } }; }
  });
  replace(t, globalThis, 'AudioWorkletNode', class { constructor() { node = this; } port = { close() {} }; connect() {} disconnect() {} });
  return { get worker() { return worker; }, get node() { return node; }, get closedContext() { return closedContext; } };
}
const media = (track) => ({ getTracks: () => [track], getAudioTracks: () => [track] });

test('offline mic: partials never dispatch; release tracks before final text; drop queued finals including from a previous turn', async (t) => {
  const track = { stops: 0, stop() { this.stops++; } };
  const h = workerHarness(t, async () => media(track));
  const texts = [], partials = []; let waiting;
  const input = openOfflineInput('/speech/models/test', { ready: () => { waiting = input.listen(); }, error: assert.fail, partial: (text) => partials.push(text),
    transcript(text) { assert.equal(track.stops, 1); assert.equal(h.closedContext, 1); texts.push(text); } });
  t.after(input.close);
  h.worker.emit({ event: 'load', result: true }); await waiting;
  const first = h.worker.messages.at(-1).recognizerId;
  const result = { event: 'result', result: { text: 'कुल कितने कर्मचारी हैं' }, recognizerId: first };
  const partial = { ...result, event: 'partialresult', result: { partial: 'कुल कितने' } };
  h.worker.emit(partial); assert.deepEqual(partials, ['कुल कितने']); h.worker.emit({ ...result, result: { text: ' ' } });
  assert.deepEqual(texts, []); h.worker.emit(result); h.worker.emit(result);
  await input.listen(); assert.notEqual(first, h.worker.messages.at(-1).recognizerId);
  h.worker.emit(result); h.worker.emit(partial); assert.deepEqual(partials, ['कुल कितने']); assert.deepEqual(texts, ['कुल कितने कर्मचारी हैं']);
  input.close(); h.worker.emit(result); assert.equal(track.stops, 2); assert.ok(h.worker.terminated);
});

test('stopping during a microphone permission prompt releases even a late-granted stream', async (t) => {
  let grant, stopped = false;
  const h = workerHarness(t, () => new Promise((resolve) => { grant = resolve; }));
  const input = openOfflineInput('/speech/models/test', { ready() {}, transcript: assert.fail, error: assert.fail });
  const wait = input.listen(); input.close();
  grant(media({ stop() { stopped = true; } })); assert.equal(await wait, false);
  assert.ok(stopped && h.worker.terminated); assert.ok(!h.worker.messages.some((m) => m.action === 'create'));
});

test('offline mic reports permission denial separately from a bad model and terminates the worker', async (t) => {
  const h = workerHarness(t, async () => { throw new DOMException('blocked', 'NotAllowedError'); });
  const errors = [], events = { ready() {}, transcript: assert.fail, error: (e) => errors.push(e) };
  const input = openOfflineInput('/speech/models/test', events); await input.listen(); assert.ok(h.worker.terminated);
  openOfflineInput('/speech/models/test', events); h.worker.emit({ event: 'error' });
  assert.ok(h.worker.terminated); assert.deepEqual(errors, ['not-allowed', 'model-error']);
});

for (const lang of ['en', 'hi']) test(`installed ${lang} engines need neither native speech API; mic stays off through playback`, async (t) => {
  replace(t, globalThis, 'window', { isSecureContext: true });
  // A policy blocking *browser speech packs* must not block our own recognizer.
  replace(t, globalThis, 'document', { featurePolicy: { features: () => ['on-device-speech-recognition'], allowsFeature: () => false } });
  let events, finish, listens = 0, closed = 0, cancel = 0, reads = 0; const commands = [], states = [];
  const q = lang === 'hi' ? 'कुल कितने कर्मचारी हैं' : 'how many people';
  const offline = { canListen: () => true, canPlay: () => true,
    packs: async (language) => { assert.equal(language, lang); return { input: lang + '-mic', output: lang + '-speaker' }; },
    openInput(url, handlers) { assert.equal(url, lang + '-mic'); events = handlers; return { listen: async () => ++listens, close: () => closed++ }; },
    play(url, text, done) { reads++; assert.equal(url, lang + '-speaker'); assert.equal(text, '5'); finish = done; return () => cancel++; } };
  const voice = createLocalVoice({ offline, language: lang, onState: (s) => states.push(s), onCommand: async (text) => { commands.push(text); return '5'; } });
  await voice.toggle(); assert.equal(listens, 0); await events.ready(); assert.match(states.at(-1).text, /offline|ऑफ़लाइन/);
  await events.transcript(q); assert.equal(reads, 1); assert.equal(listens, 1);
  finish(true); await tick(); assert.equal(listens, 2); await events.transcript(q);
  voice.stop(); finish(true); await events.transcript(q); await events.ready();
  assert.deepEqual(commands, [q, q]); assert.equal(listens, 2); assert.equal(cancel, 1); assert.equal(closed, 1);
});

test('speaker/pack lookups cancelled by Stop or language switch never create a worker or use a microphone', async (t) => {
  replace(t, globalThis, 'window', { isSecureContext: true }); replace(t, globalThis, 'document', {});
  let resolve;
  const offline = { canListen: () => true, canPlay: () => true, packs: () => new Promise((r) => { resolve = r; }), openInput: assert.fail, play: assert.fail };
  const voice = createLocalVoice({ offline, onState() {}, onCommand: assert.fail });
  const start = voice.toggle(); voice.stop(); resolve({ input: 'late' }); await start;
  voice.togglePlayback('last reply'); assert.ok(voice.isActive()); voice.setLanguage('hi'); resolve({ output: 'late' }); await tick(); assert.ok(!voice.isActive());
  voice.togglePlayback('जवाब'); voice.togglePlayback('जवाब'); resolve({ output: 'also late' }); await tick(); assert.ok(!voice.isActive());
});

test('without an Indian English pack or device voice, preserve working English output and identify its real locale', (t) => {
  const voiceUS = { lang: 'en-US', localService: true }, spoken = [], states = [];
  replace(t, globalThis, 'window', { speechSynthesis: { getVoices: () => [voiceUS, { lang: 'en-IN', localService: false }], speak(u) { spoken.push(u); u.onend(); } },
    SpeechSynthesisUtterance: class {} });
  const voice = createLocalVoice({ onState() {}, onCommand: assert.fail, onPlayback: (s) => states.push(s) });
  voice.togglePlayback('Hello'); assert.equal(spoken[0].voice, voiceUS); assert.match(states.at(-1).text, /en-US.*Indian accent/);
});

test('microphone permission policy or an insecure page blocks both recognition paths before model lookup', async (t) => {
  replace(t, globalThis, 'window', { isSecureContext: false });
  replace(t, globalThis, 'document', { featurePolicy: { features: () => ['microphone'], allowsFeature: () => false } });
  const states = [], offline = { canListen: () => true, packs: assert.fail, openInput: assert.fail };
  const voice = createLocalVoice({ offline, onCommand: assert.fail, onState: (s) => states.push(s) });
  await voice.toggle(); assert.match(states.at(-1).text, /localhost/); window.isSecureContext = true;
  await voice.toggle(); assert.match(states.at(-1).text, /permissions policy/); assert.equal(states.at(-1).active, false);
});

const peak = (pcm) => pcm.reduce((p, x) => Math.max(p, Math.abs(x)), 0);
test('speech leveling raises quiet phrases, preserves silence, respects volume and leaves headroom even at 200%', () => {
  const raw = Float32Array.from({ length: 4800 }, (_, i) => i < 480 || i > 4200 ? 0 : 0.02 * Math.sin(i / 4));
  const render = (vol) => { const pcm = raw.slice(); levelSpeech(pcm, 24000, vol); return pcm; };
  assert.ok(peak(render(1)) > 3.9 * peak(raw));
  assert.equal(peak(render(0.5)), peak(render(1)) / 2); assert.equal(peak(render(0)), 0);
  assert.ok(peak(render(2)) > 1.9 * peak(render(1))); assert.equal(peak(render(2).subarray(0, 480)), 0);
  raw[1000] = 1; raw[2000] = -1; const strong = render(2); assert.ok(peak(strong) <= 0.891 && peak(strong) > 0.85);
  assert.equal(strong[0], 0); assert.equal(strong.at(-1), 0);
  raw.fill(0); assert.equal(peak(render(2)), 0); raw.fill(1e-7); assert.equal(peak(render(1)), peak(raw));
  raw[150] = NaN; assert.throws(() => render(1));
});

test('Studio preserves names, acronyms, leading zeroes, counts and decimals before splitting a long report', () => {
  const hi = (s) => spokenText(s, 'hi', (w) => { assert.equal(w, 'Giga'); return 'गिग'; });
  assert.match(hi('Giga One में ५ कर्मचारी।'), /गिगा वन में पाँच कर्मचारी/);
  assert.match(hi('CRM BL-007: ₹१,२३,४०५.५०'), /सी आर एम बी एल- शून्य शून्य सात.*एक लाख तेईस हज़ार चार सौ पाँच दशमलव पाँच शून्य रुपये/);
  assert.match(hi('1,234,567'), /बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ/);
  const en = spokenText('प्रिया शर्मा: QA-005, 2.05%', 'en'); assert.match(en, /priya sharma: Q A- zero zero five.*2\.05%/);
  const long = (en + ' हिन्दी। ').repeat(12).trim(); const chunks = phrases(long, 60);
  assert.ok(chunks.length > 1 && chunks.every((p) => p.length <= 60)); assert.equal(chunks.join(' '), long.replace(/\s+/g, ' '));
  assert.deepEqual(phrases('  ', 40), []); assert.equal(phrases('x'.repeat(403), 100).join('').length, 403);
});

test('speaker preference is bounded and independent of language or microphone state', () => {
  assert.deepEqual(speakerSettings('broken', 'NaN'), { mode: 'auto', volume: 1 });
  assert.deepEqual(speakerSettings(null, null), { mode: 'auto', volume: 1 });
  assert.deepEqual(speakerSettings('studio', '-1'), { mode: 'studio', volume: 0 });
  assert.deepEqual(speakerSettings('device', '999'), { mode: 'device', volume: 2 });
});

test('Auto prefers Studio; init failure can fall back, never after audible speech or Stop; explicit choices are honored', async (t) => {
  const calls = [], states = []; let mode = 'auto', packs = { studio: '/studio-hi', output: '/standard-hi' };
  replace(t, globalThis, 'window', {});
  const offline = { canPlay: () => true, packs: async (l) => { assert.equal(l, 'hi'); return packs; },
    openInput: assert.fail, play(model, text, done, opts) { calls.push({ model, done, opts }); return () => {}; } };
  const voice = createLocalVoice({ language: 'hi', offline, onPlayback: (s) => states.push(s), onState() {}, onCommand: assert.fail,
    getSpeaker: () => speakerSettings(mode, '150') });
  voice.togglePlayback('जवाब'); await tick(); const first = calls[0]; assert.equal(first.model, packs.studio);
  const { onStart, ...opts } = first.opts; assert.deepEqual(opts, { engine: 'studio', language: 'hi', volume: 1.5 });
  assert.equal(typeof onStart, 'function');
  first.done(false, false); await tick(); assert.equal(calls[1].model, packs.output); calls[1].done(true, true);
  assert.match(states.at(-1).text, /स्टूडियो शुरू नहीं हुआ.*स्टैंडर्ड/s);
  voice.togglePlayback('फिर'); await tick(); calls.at(-1).done(false, true); await tick(); assert.equal(calls.length, 3);
  voice.togglePlayback('फिर'); await tick(); calls.at(-1).done(false, false); voice.stop(); await tick(); assert.equal(calls.length, 4);
  mode = 'standard'; voice.togglePlayback('फिर'); await tick(); assert.equal(calls.at(-1).model, packs.output); voice.stop();
  mode = 'studio'; packs = { output: '/standard-hi' }; voice.togglePlayback('फिर'); await tick();
  assert.equal(calls.length, 5); assert.match(states.at(-1).text, /install-studio-voices-windows/); assert.equal(states.at(-1).help, true);
});

test('Device choice bypasses bundled packs, uses only a matching local voice and caps its API volume at 1', (t) => {
  const hi = { name: 'Local Hindi', lang: 'hi-IN', localService: true }, utterances = [];
  replace(t, globalThis, 'window', { SpeechSynthesisUtterance: class {}, speechSynthesis: {
    getVoices: () => [{ lang: 'hi-IN', localService: false }, hi], speak(u) { utterances.push(u); u.onend(); } } });
  let pct = 40;
  const voice = createLocalVoice({ language: 'hi', onState() {}, onCommand: assert.fail, getSpeaker: () => speakerSettings('device', pct),
    offline: { canPlay: () => true, packs: assert.fail, play: assert.fail } });
  voice.togglePlayback('नमस्ते'); assert.equal(utterances[0].voice, hi); assert.equal(utterances[0].volume, 0.4);
  pct = 180; voice.togglePlayback('फिर'); assert.equal(utterances[1].volume, 1);
  pct = 0; voice.togglePlayback('फिर'); assert.equal(utterances.length, 2); assert.equal(voice.isActive(), false);
});

test('offline playback primes only one next phrase, and Stop discards both pending PCM and late worker events', async (t) => {
  const sources = [], messages = []; let worker, closed = 0, ended = 0;
  replace(t, globalThis, 'Worker', class { constructor() { worker = this; } postMessage(m) { messages.push(m); } terminate() { this.ended = true; } });
  replace(t, globalThis, 'AudioContext', class {
    async resume() {} async close() { closed++; }
    createBuffer(_, n, sampleRate) { const pcm = new Float32Array(n); return { getChannelData: () => pcm, copyToChannel: (s) => pcm.set(s), sampleRate }; }
    createBufferSource() { const s = { connect() {}, disconnect() {}, start() { sources.push(s); }, stop() { this.stopped = true; } }; return s; }
  });
  const flush = (more) => worker.onmessage({ data: { more, hz: 24000, pcm: new Float32Array(800).fill(0.04) } });
  const play = () => offlineSpeech.play('studio', 'three phrases', () => ended++, { engine: 'studio', volume: 2 });
  const stop = play(); await flush(true); await flush(true); assert.equal(sources.length, 1); assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { next: true }); sources[0].onended(); assert.equal(sources.length, 2); assert.equal(messages.length, 3);
  stop(); await flush(false); assert.ok(sources[1].stopped && worker.ended); assert.equal(sources.length, 2); assert.equal(closed, 1); assert.equal(ended, 0);
  play(); await flush(true); sources.at(-1).onended(); assert.equal(ended, 0, 'wait for slow next inference');
  await flush(false); sources.at(-1).onended(); assert.equal(ended, 1); assert.equal(closed, 2);
});

test('Studio status requires its complete runtime and selected-language model, independently of mic and Standard', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice-status-'));
  const app = express(); app.use('/speech', speechAssets(root)); const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { await new Promise((r) => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/speech/`;
  const status = async () => (await fetch(base + 'status')).json();
  assert.deepEqual(await status(), { en: {}, hi: {} });
  const a = models.find((x) => x.kind === 'studio' && x.lang === 'hi');
  for (const rel of ['.cache/models/' + a.file, ...['g2p.js', 'studio_g2p.js', 'ipa_g2p.js'].map((f) => 'studio/node_modules/ninada/src/' + f),
    ...['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs'].map((f) => 'studio/node_modules/onnxruntime-web/dist/' + f)]) {
    const file = path.join(root, rel); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'fixture');
  }
  const model = path.join(root, '.cache/models', a.file);
  await truncate(model, a.bytes); assert.deepEqual(await status(), { en: {}, hi: {} }, 'missing WASM');
  await writeFile(path.join(root, 'studio/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'), 'fixture');
  assert.deepEqual(await status(), { en: {}, hi: { studio: '/speech/models/' + a.file } });
  assert.equal((await fetch(base + 'models/' + a.file, { method: 'HEAD' })).status, 200);
  await truncate(model, a.bytes - 1); assert.deepEqual(await status(), { en: {}, hi: {} }, 'wrong model size');
});

async function writeRuntime(root, kind) {
  for (const file of Object.values(runtimes[kind])) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'runtime fixture');
  }
}
test('Windows preflight repairs Studio-only mic files, skips installed languages and works fully offline on next launch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'voice setup with spaces ')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, modelDir); await mkdir(dir, { recursive: true });
  const files = models.map(({ lang, kind }) => {
    const file = `${lang}-${kind}`, bytes = Buffer.from(file);
    return { file, url: file, lang, kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  await writeRuntime(root, 'studio');
  for (const a of files.filter(a => a.kind === 'studio')) await writeFile(path.join(dir, a.file), a.file);
  const calls = [], opt = { root, models: files, log() {}, runtime: async () => { calls.push('runtime'); await writeRuntime(root, 'input'); await writeRuntime(root, 'output'); },
    download: async (file) => { calls.push(file); return new Response(file); } };
  await prepare(opt); assert.deepEqual(calls, ['runtime', 'en-input', 'hi-input']);
  for (const p of Object.values(packStatus(root, files))) assert.deepEqual(Object.keys(p).sort(), ['input', 'studio']);
  const offline = { ...opt, download: assert.fail, runtime: assert.fail }; await prepare(offline);
  // An interrupted/refused repair does not replace existing files or touch a sibling language.
  const en = path.join(dir, 'en-input'); await writeFile(en, 'bad-data');
  await assert.rejects(prepare({ ...offline, download: async () => new Response(null, { status: 503 }) }), /Indian English microphone.*503/);
  assert.equal(await readFile(en, 'utf8'), 'bad-data'); assert.equal(await readFile(path.join(dir, 'hi-input'), 'utf8'), 'hi-input');
  calls.length = 0; await prepare(opt); assert.deepEqual(calls, ['en-input']);
  // A fresh/non-Studio language gets the fast voice too, without a second installer.
  await rm(path.join(dir, 'hi-studio')); calls.length = 0; await prepare(opt); assert.deepEqual(calls, ['hi-output']);
  await prepare(offline); assert.ok(!((await readdir(root)).includes('data')));
});

test('Studio only vs unreachable server: mic reports the right blocker, does not open a track or send a command', async (t) => {
  replace(t, globalThis, 'window', { isSecureContext: true }); replace(t, globalThis, 'document', {});
  let pack = { studio: '/speech/models/en.onnx' }; const states = [];
  const offline = { canListen: () => true, packs: async () => pack, openInput: assert.fail };
  const voice = createLocalVoice({ offline, onState: (s) => states.push(s), onCommand: assert.fail });
  await voice.toggle(); assert.match(states.at(-1).text, /English microphone pack is missing/);
  const issue = states.at(-1); voice.dismiss('closed'); assert.equal(states.at(-1), issue);
  pack = null; await voice.toggle(); assert.match(states.at(-1).text, /Could not check/); assert.doesNotMatch(states.at(-1).text, /missing|npm/);
  voice.setLanguage('hi'); pack = {}; await voice.toggle(); assert.match(states.at(-1).text, /हिन्दी माइक पैक/);
});

test('a known mic permission denial is actionable before any pack probe, including after closing Ask', async (t) => {
  replace(t, globalThis, 'window', { isSecureContext: true }); replace(t, globalThis, 'document', {});
  replace(t, globalThis, 'navigator', { permissions: { query: async (p) => { assert.deepEqual(p, { name: 'microphone' }); return { state: 'denied' }; } } });
  const states = [], offline = { canListen: assert.fail, packs: assert.fail, openInput: assert.fail };
  const voice = createLocalVoice({ offline, onState: (s) => states.push(s), onCommand: assert.fail });
  await voice.toggle(); assert.match(states.at(-1).text, /access was denied/); assert.equal(states.at(-1).active, false);
  const last = states.at(-1); voice.dismiss('Ask closed'); assert.equal(states.at(-1), last);
});

test('local mic previews near-silence then signal once per turn without submitting partials or audio', async (t) => {
  const h = workerHarness(t, async () => media({ stop() {} })); const hints = [];
  const input = openOfflineInput('local', { transcript: assert.fail, error: assert.fail, quiet: (q) => hints.push(q) });
  t.after(input.close); await input.listen();
  const frame = (level) => h.node.port.onmessage({ data: new Float32Array(2048).fill(level) });
  const id = h.worker.messages.at(-1).recognizerId;
  for (let i = 0; i < 45; i++) { frame(0); h.worker.emit({ event: 'partialresult', result: { partial: '' }, recognizerId: id }); }
  assert.deepEqual(hints, [true]); frame(1200); frame(1200); assert.deepEqual(hints, [true, false]);
});
