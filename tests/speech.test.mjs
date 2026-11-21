import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { install } from '../voice/setup.js';
import { createLocalVoice } from '../public/js/voice.js';
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
  let worker, closedContext = 0;
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
  replace(t, globalThis, 'AudioWorkletNode', class { port = { close() {} }; connect() {} disconnect() {} });
  return { get worker() { return worker; }, get closedContext() { return closedContext; } };
}
const media = (track) => ({ getTracks: () => [track], getAudioTracks: () => [track] });

test('offline mic: partials never dispatch; release tracks before final text; drop queued finals including from a previous turn', async (t) => {
  const track = { stops: 0, stop() { this.stops++; } };
  const h = workerHarness(t, async () => media(track));
  const texts = []; let waiting;
  const input = openOfflineInput('/speech/models/test', { ready: () => { waiting = input.listen(); }, error: assert.fail,
    transcript(text) { assert.equal(track.stops, 1); assert.equal(h.closedContext, 1); texts.push(text); } });
  t.after(input.close);
  h.worker.emit({ event: 'load', result: true }); await waiting;
  const first = h.worker.messages.at(-1).recognizerId;
  const result = { event: 'result', result: { text: 'कुल कितने कर्मचारी हैं' }, recognizerId: first };
  h.worker.emit({ ...result, event: 'partialresult' }); h.worker.emit({ ...result, result: { text: ' ' } });
  assert.deepEqual(texts, []); h.worker.emit(result); h.worker.emit(result);
  await input.listen(); assert.notEqual(first, h.worker.messages.at(-1).recognizerId);
  h.worker.emit(result); assert.deepEqual(texts, ['कुल कितने कर्मचारी हैं']);
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
