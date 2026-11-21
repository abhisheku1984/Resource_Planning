/* Never start a cloud-backed recognizer or select a remote synthesis voice.
   One microphone turn ends before its reply is read. Closing/stopping supersedes
   outstanding pack checks, installations, speech results and spoken replies. */
const pack = (lang) => ({ langs: [lang], processLocally: true });
function englishLocales() {
  const preferred = (navigator.languages || [navigator.language]).filter((s) => /^en(?:-|$)/i.test(s));
  return [...new Set([...preferred, 'en-US', 'en-IN', 'en-GB', 'en'])];
}
async function findPack(Recognition, current) {
  const languages = englishLocales();
  // Some engines support processLocally without the static pack APIs. Starting
  // them is still local-only; the recognition error event reports missing packs.
  if (!Recognition.available) return { state: 'available', lang: languages[0] };
  let downloading, downloadable, unknown = false;
  for (const lang of languages) {
    // A combined langs array asks if *all* the packs are available, not any one.
    const state = await Recognition.available(pack(lang));
    if (!current()) return null;
    if (state === 'available') return { state, lang };
    if (state === 'downloading') downloading ??= { state, lang };
    else if (state === 'downloadable') downloadable ??= { state, lang };
    else if (state !== 'unavailable') unknown = true;
  }
  return downloading || downloadable || { state: unknown ? 'unknown' : 'unavailable' };
}
function blockedByPolicy(feature) {
  const policy = document.permissionsPolicy || document.featurePolicy;
  return policy?.features?.().includes(feature) && !policy.allowsFeature(feature);
}

export function createLocalVoice({ onCommand, onState }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let epoch = 0, active = false, mic = null, speaking = null, installLang = null;
  const status = (text, action = active ? 'stop' : 'start', help = false) => onState({ active, text, action, help });
  function stop(text = 'Voice off. You can still type.', help = false) {
    ++epoch; active = false; installLang = null;
    const old = mic; mic = null;
    try { old?.abort(); } catch { /* already ended */ }
    if (speaking) { speaking = null; window.speechSynthesis?.cancel(); }
    status(text, 'start', help);
  }
  function speak(text, done) {
    const synth = window.speechSynthesis;
    const voice = synth?.getVoices().find((v) => v.localService && /^en\b/i.test(v.lang));
    if (!voice || !window.SpeechSynthesisUtterance) return false;
    const u = new window.SpeechSynthesisUtterance(text);
    speaking = u; u.voice = voice; u.lang = voice.lang;
    u.onend = u.onerror = () => { if (speaking === u) { speaking = null; done(); } };
    try { synth.speak(u); return true; } catch { speaking = null; return false; }
  }
  function listen(id, lang, note = '') {
    if (id !== epoch) return;
    try {
      const rec = new Recognition();
      if (!('processLocally' in rec)) return stop('This browser cannot recognize speech on-device.', true);
      rec.processLocally = true; rec.lang = lang; rec.continuous = false; rec.interimResults = false;
      mic = rec;
      let transcript = '';
      rec.onresult = (e) => {
        if (mic !== rec || transcript) return;
        transcript = Array.from(e.results).filter((r) => r.isFinal).map((r) => r[0].transcript).join(' ').trim();
        if (transcript) rec.stop();
      };
      rec.onerror = (e) => {
        if (mic !== rec) return;
        const errors = { 'not-allowed': 'Microphone access was denied. Allow the microphone for this site, then try again.',
          'audio-capture': 'No microphone available. Check the input device in your system settings.', 'no-speech': 'No speech heard. Start voice mode to try again.',
          'service-not-allowed': 'The on-device speech service is blocked or unavailable in this tab.',
          'language-not-supported': `The browser could not use its ${lang} speech pack. Check again after the pack is installed.` };
        stop(errors[e.error] || 'On-device recognition failed. Open the app in its own tab and try again.', e.error !== 'no-speech');
      };
      rec.onend = async () => {
        if (mic !== rec) return;
        mic = null;
        if (!transcript) return stop('No speech heard. Start voice mode to try again.');
        if (/^(?:stop (?:voice(?: mode)?|listening)|voice off)[.!?]?$/i.test(transcript)) return stop();
        status('Checking… microphone paused.');
        try {
          const answer = await onCommand(transcript);
          if (id !== epoch) return;
          if (!answer) return listen(id, lang);
          status('Reading reply… microphone paused.');
          if (!speak(answer, () => listen(id, lang))) listen(id, lang, ' No local English read-aloud voice available.');
        } catch { if (id === epoch) stop('Voice turn failed. Try again or type your message.'); }
      };
      rec.start(); status(`Listening (${lang})… Say a question, a CRM command, or “stop listening”.` + note);
    } catch { stop('The microphone could not start. Check this site’s microphone permission.', true); }
  }
  async function toggle() {
    if (active) return stop();
    if (speaking) return stop('Stopped reading. The app microphone is off.', true);
    if (!window.isSecureContext) return stop('Voice needs localhost on this computer, or HTTPS. Opening a remote HTTP address is not enough.', true);
    const id = ++epoch, requested = installLang;
    try {
      if (blockedByPolicy('on-device-speech-recognition') || blockedByPolicy('microphone')) {
        return stop('This page’s permissions policy blocks local speech or microphone access. Open the app in its own tab. If it is managed, check with IT.', true);
      }
      if (!Recognition || !('processLocally' in new Recognition())) return stop('This browser does not provide on-device recognition. Use a current desktop browser, device dictation, or type instead.', true);
      active = true; installLang = null;
      status(requested ? `Installing the ${requested} speech pack…` : 'Checking local English speech packs…');
      // This separate click supplies user activation for install(). Never start
      // a browser download, or fall back to a remote recognizer, on failure.
      if (requested) {
        const installed = await Recognition.install(pack(requested));
        if (id !== epoch) return;
        if (!installed) return stop('The browser did not install the pack. Check the browser download prompt and connection, then try again.', true);
      }
      const found = await findPack(Recognition, () => id === epoch);
      if (id !== epoch) return;
      if (found.state === 'available') {
        window.speechSynthesis?.getVoices(); // prime the asynchronous local voice catalogue
        return listen(id, found.lang);
      }
      active = false;
      if (found.state === 'downloading') return status(`The ${found.lang} speech pack is downloading. When it finishes, select Check again. The microphone is off.`, 'retry', true);
      if (found.state === 'downloadable' && Recognition.install && !requested) {
        installLang = found.lang;
        return status(`Allow the browser to install its ${found.lang} speech pack once. No audio is uploaded.`, 'install');
      }
      const message = found.state === 'unavailable' ? 'No local English speech pack is available to this site in this browser.'
        : found.state === 'downloadable' && !Recognition.install ? 'An English pack is downloadable, but this browser cannot install it from this page.'
        : 'The browser has not confirmed that an English speech pack is ready.';
      status(message, 'retry', true);
    } catch (err) {
      if (id === epoch) stop(err.name === 'NotAllowedError' || err.name === 'SecurityError'
        ? 'The browser blocked access to local speech packs. Open the app in its own tab or check with IT.'
        : 'Could not check or install a browser speech pack. Open the app in its own tab and try again.', true);
    }
  }
  // Device dictation enters text into Ask. Read-back is user initiated and never
  // opens an app microphone; only the OS can turn its own dictation mic off.
  function readReply(text) {
    if (active || speaking || !text) return;
    installLang = null;
    status('Reading the last reply. The app microphone is off.', 'stop-reading', true);
    if (!speak(text, () => status('Finished reading. The app microphone is off.', 'start', true))) {
      status('No local English read-aloud voice is available. The reply is in the conversation.', 'start', true);
    }
  }
  return { toggle, stop, readReply, isActive: () => active || !!speaking };
}
