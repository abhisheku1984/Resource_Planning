/* One chosen language per voice session. Never substitute the other language,
   a cloud recognizer or a remote synthesis voice. */
import { offlineSpeech } from './speech/offline.js';

const pack = (lang) => ({ langs: [lang], processLocally: true });
const tag = (s) => String(s || '').toLowerCase().replaceAll('_', '-');
const family = (s) => tag(s).split('-')[0];
function locales(language) {
  const preferred = (navigator.languages || [navigator.language]).filter((s) => family(s) === language);
  const indian = language === 'hi' ? 'hi-IN' : 'en-IN';
  return [...new Set([indian, ...preferred, ...(language === 'hi' ? ['hi'] : ['en-US', 'en-GB', 'en'])])];
}
async function findPack(Recognition, languages, current) {
  if (!Recognition.available) return { state: 'available', lang: languages[0] };
  let downloading, downloadable, unknown = false;
  for (const lang of languages) {
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

export function createLocalVoice({ onCommand, onState, onPlayback = () => {}, language: initial = 'en', offline = offlineSpeech }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let language = initial === 'hi' ? 'hi' : 'en';
  const t = (en, hi) => language === 'hi' ? hi : en;
  const setup = () => t('Run npm run voice:setup in the app folder for offline Indian English and Hindi.', 'ऑफ़लाइन हिन्दी और भारतीय अंग्रेज़ी के लिए ऐप फ़ोल्डर में npm run voice:setup चलाएँ।');
  let epoch = 0, active = false, mic = null, speaking = null, installLang = null;
  let localInput = null, sessionPacks = null;
  const status = (text, action = active ? 'stop' : 'start', help = false) => onState({ active, text, action, help });
  function cancelSpeech() {
    const old = speaking; speaking = null; // ignore late catalogue, WAV and end/error events
    old?.cancel?.();
  }
  function stop(text = t('Voice off. You can still type.', 'माइक बंद है। आप हिन्दी में लिख सकते हैं।'), help = false) {
    ++epoch; active = false; installLang = null; sessionPacks = null;
    localInput?.close(); localInput = null;
    const old = mic; mic = null;
    try { old?.abort(); } catch { /* already ended */ }
    cancelSpeech(); status(text, 'start', help);
  }
  function setLanguage(next) {
    language = next === 'hi' ? 'hi' : 'en';
    stop(t('English selected. Start voice mode or type a question.', 'हिन्दी चुनी गई है। बोलना शुरू करें या अपना सवाल लिखें।'));
  }
  function prepareSpeaker() {
    try { window.speechSynthesis?.getVoices(); } catch { /* speaker is optional */ }
  }
  const noSpeaker = () => t('No local English read-aloud voice is available.', 'पढ़कर सुनाने के लिए हिन्दी की स्थानीय आवाज़ उपलब्ध नहीं है।') + ' ' + setup();
  function speak(text, done, knownPacks) {
    const token = {}; speaking = token;
    function finish(ok, note = '') { if (speaking === token) { speaking = null; done(ok, note); } }
    function choose(packs) {
      if (speaking !== token) return;
      try {
        if (packs?.output && offline.canPlay()) {
          const label = t('Voice: Indian English (KSP, offline).', 'आवाज़: हिन्दी (ऑफ़लाइन)।');
          token.cancel = offline.play(packs.output, text, (ok) => finish(ok, ok ? label : setup()));
          return;
        }
        const synth = window.speechSynthesis;
        const voices = synth?.getVoices().filter((v) => v.localService === true && family(v.lang) === language) || [];
        // Recognition locale is NOT a synthesis accent. Select an actual device voice.
        const indian = voices.find((v) => tag(v.lang) === `${language}-in`);
        const voice = indian || voices[0];
        if (!voice || !window.SpeechSynthesisUtterance) return finish(false, noSpeaker());
        const note = !indian && language === 'en' ? `Device voice: ${voice.lang}. For an Indian accent, run npm run voice:setup.` : '';
        const u = new window.SpeechSynthesisUtterance(text); u.voice = voice; u.lang = voice.lang;
        token.cancel = () => synth.cancel();
        u.onend = () => finish(true, note); u.onerror = () => finish(false);
        synth.speak(u);
      } catch { finish(false); }
    }
    if (knownPacks || !offline.canPlay()) choose(knownPacks);
    else offline.packs(language).then(choose, () => choose(null));
  }
  function micError(code, lang) {
    const errors = {
      'not-allowed': t('Microphone access was denied. Allow the microphone for this site and in Windows Settings → Privacy & security → Microphone.', 'माइक की अनुमति नहीं मिली। साइट और Windows सेटिंग → गोपनीयता और सुरक्षा → माइक्रोफ़ोन में अनुमति दें।'),
      'audio-capture': t('No usable microphone. Check Windows Settings → System → Sound → Input and choose the correct device.', 'माइक उपलब्ध नहीं है। Windows सेटिंग → सिस्टम → साउंड → इनपुट में सही माइक चुनें।'),
      'no-speech': t('No complete phrase heard. Start voice mode, speak a short question, then pause.', 'पूरा वाक्य नहीं सुनाई दिया। माइक चालू करें, छोटा सवाल पूछें और थोड़ा रुकें।'),
      'service-not-allowed': t('The browser speech service is blocked or unavailable.', 'ब्राउज़र की वाक् सेवा उपलब्ध नहीं है।') + ' ' + setup(),
      'language-not-supported': t(`The browser could not use its ${lang} speech pack.`, `${lang} स्पीच पैक का उपयोग नहीं हो सका।`) + ' ' + setup(),
      'model-error': t('Could not load the offline recognizer. Allow site storage, then try again.', 'ऑफ़लाइन वाक् पहचान लोड नहीं हुई। साइट को स्टोरेज की अनुमति दें और फिर कोशिश करें।') + ' ' + setup(),
      'too-slow': t('The offline recognizer could not keep up. Close other busy tabs and try a shorter question.', 'ऑफ़लाइन वाक् पहचान धीमी है। दूसरे टैब बंद करें और छोटा सवाल पूछें।'),
    };
    stop(errors[code] || t('Could not start local recording. Check the input device and open Ask in its own desktop browser tab.', 'स्थानीय रिकॉर्डिंग चालू नहीं हुई। इनपुट डिवाइस जाँचें और ऐप को अलग डेस्कटॉप टैब में खोलें।'), code !== 'no-speech');
  }
  async function command(id, lang, text) {
    if (id !== epoch) return;
    if (!text) return micError('no-speech', lang);
    if (/^(?:stop (?:voice(?: mode)?|listening)|voice off)[.!?]?$/i.test(text) ||
      (language === 'hi' && /^(?:सुनना|माइक|आवाज़|आवाज) बंद (?:करें|करो|कीजिए)[।.!?]?$/.test(text))) return stop();
    status(t('Checking… microphone paused.', 'जाँच जारी है… माइक रुका हुआ है।'));
    try {
      const answer = await onCommand(text);
      if (id !== epoch) return;
      if (!answer) return listen(id, lang);
      status(t('Reading reply… microphone paused.', 'जवाब पढ़ा जा रहा है… माइक रुका हुआ है।'));
      speak(answer, (ok, note) => listen(id, lang, note || (ok ? '' : t('Could not read the reply aloud.', 'जवाब पढ़कर नहीं सुनाया जा सका।'))), sessionPacks);
    } catch { if (id === epoch) stop(t('Voice turn failed. Try again or type your message.', 'जवाब नहीं मिल सका। फिर कोशिश करें या अपना सवाल लिखें।')); }
  }
  async function listen(id, lang, note = '') {
    if (id !== epoch) return;
    try {
      if (localInput) {
        status(t('Waiting for microphone access…', 'माइक की अनुमति का इंतज़ार है…'));
        if (!await localInput.listen() || id !== epoch) return;
      } else {
        const rec = new Recognition();
        if (!('processLocally' in rec)) return stop(setup(), true);
        rec.processLocally = true;
        if (rec.processLocally !== true) return stop(setup(), true);
        rec.lang = lang; rec.continuous = false; rec.interimResults = false;
        mic = rec; let transcript = '';
        rec.onresult = (e) => {
          if (mic !== rec || transcript) return;
          transcript = Array.from(e.results).filter((r) => r.isFinal).map((r) => r[0].transcript).join(' ').trim();
          if (transcript) rec.stop();
        };
        rec.onerror = (e) => { if (mic === rec) micError(e.error, lang); };
        rec.onend = () => { if (mic === rec) { mic = null; command(id, lang, transcript); } };
        rec.start();
      }
      const source = localInput ? `${lang} · ${t('offline', 'ऑफ़लाइन')}` : lang;
      status(t(`Listening (${source})… Ask a question, then pause.`, `सुन रहे हैं (${source})… सवाल पूछें और थोड़ा रुकें।`) + (note ? ' ' + note : ''));
    } catch { if (id === epoch) micError('capture-failed', lang); }
  }
  async function toggle() {
    if (active) return stop();
    if (speaking) return;
    if (!window.isSecureContext) return stop(t('Voice needs localhost on this computer, or HTTPS. Opening a remote HTTP address is not enough.', 'इस कंप्यूटर पर localhost या HTTPS का उपयोग करें। दूसरे कंप्यूटर के HTTP पते पर माइक उपलब्ध नहीं होगा।'), true);
    const id = ++epoch, requested = installLang;
    active = true; installLang = null; sessionPacks = null;
    try {
      const policyError = t('This page’s permissions policy blocks access. Open the app in its own tab or check with IT.', 'इस पेज की नीति अनुमति नहीं देती। ऐप को अलग टैब में खोलें या अपने आईटी व्यवस्थापक से पूछें।');
      if (blockedByPolicy('microphone')) return stop(policyError, true);
      if (!requested && offline.canListen()) {
        status(t('Checking installed offline speech…', 'इंस्टॉल किए गए ऑफ़लाइन स्पीच पैक की जाँच हो रही है…'));
        const packs = await offline.packs(language);
        if (id !== epoch) return;
        sessionPacks = packs;
        if (packs.input) {
          const lang = language === 'hi' ? 'hi-IN' : 'en-IN';
          status(t('Loading Indian English recognition. The microphone is still off…', 'हिन्दी वाक् पहचान लोड हो रही है। माइक अभी बंद है…'));
          localInput = offline.openInput(packs.input, { ready: () => listen(id, lang), transcript: (text) => command(id, lang, text),
            error: (code) => { if (id === epoch) micError(code, lang); } });
          return;
        }
      }
      if (blockedByPolicy('on-device-speech-recognition')) return stop(policyError + ' ' + setup(), true);
      if (!Recognition || !('processLocally' in new Recognition())) return stop(t('This browser does not provide on-device recognition.', 'इस ब्राउज़र में स्थानीय वाक् पहचान उपलब्ध नहीं है।') + ' ' + setup(), true);
      status(requested ? t(`Installing the ${requested} speech pack…`, `${requested} स्पीच पैक इंस्टॉल हो रहा है…`) : t('Checking local English speech packs…', 'स्थानीय हिन्दी स्पीच पैक की जाँच हो रही है…'));
      // Only the explicit second click can request a browser installation.
      if (requested) {
        const installed = await Recognition.install(pack(requested));
        if (id !== epoch) return;
        if (!installed) return stop(t('The browser did not install the pack.', 'ब्राउज़र ने पैक इंस्टॉल नहीं किया।') + ' ' + setup(), true);
      }
      const found = await findPack(Recognition, locales(language), () => id === epoch);
      if (id !== epoch) return;
      if (found.state === 'available') return listen(id, found.lang);
      active = false;
      if (found.state === 'downloading') return status(t(`The ${found.lang} speech pack is downloading. When it finishes, select Check again. The microphone is off.`, `${found.lang} स्पीच पैक डाउनलोड हो रहा है। पूरा होने पर “फिर जाँचें” चुनें। माइक बंद है।`), 'retry', true);
      if (found.state === 'downloadable' && Recognition.install && !requested) {
        installLang = found.lang;
        return status(t(`Allow the browser to install its ${found.lang} speech pack once. No audio is uploaded.`, `${found.lang} पैक इंस्टॉल करने के लिए अनुमति दें। आपकी आवाज़ अपलोड नहीं होती।`), 'install');
      }
      const msg = found.state === 'downloadable' ? t('The browser cannot install this English pack.', 'ब्राउज़र यह हिन्दी पैक इंस्टॉल नहीं कर सकता।')
        : found.state === 'unavailable' ? t('No local English speech pack is available from the browser.', 'ब्राउज़र में स्थानीय हिन्दी स्पीच पैक उपलब्ध नहीं है।')
        : t('The browser has not confirmed an English speech pack is ready.', 'ब्राउज़र ने अभी हिन्दी स्पीच पैक तैयार होने की पुष्टि नहीं की है।');
      status(msg + ' ' + setup(), 'start', true);
    } catch { if (id === epoch) stop(t('Could not start local speech. Open Ask in its own tab.', 'स्थानीय वाक् पहचान शुरू नहीं हुई। ऐप को अलग टैब में खोलें।') + ' ' + setup(), true); }
  }
  function togglePlayback(reply) {
    if (active) return;
    if (speaking) {
      cancelSpeech();
      return onPlayback({ playing: false, text: t('Playback stopped. The app microphone is off.', 'आवाज़ बंद कर दी गई है। ऐप का माइक बंद है।') });
    }
    const sample = t('This is the English speaker test. To ask a question, select Start voice mode.', 'नमस्ते। यह हिन्दी आवाज़ की जाँच है। सवाल पूछने के लिए बोलना शुरू करें चुनें।');
    onPlayback({ playing: true, text: reply ? t('Reading the last reply. The app microphone is off.', 'पिछला जवाब पढ़ा जा रहा है। ऐप का माइक बंद है।')
      : t('Playing a speaker test. The app microphone is off.', 'स्पीकर की जाँच हो रही है। ऐप का माइक बंद है।') });
    const finished = reply ? t('Finished reading. The app microphone is off.', 'जवाब पढ़ लिया गया। ऐप का माइक बंद है।')
      : t('Speaker test finished. No sound? Check your output device and volume.', 'स्पीकर की जाँच पूरी हुई। आवाज़ नहीं आई? स्पीकर और वॉल्यूम जाँचें।');
    speak(reply || sample, (ok, note) => onPlayback({ playing: false, help: !ok,
      text: [ok ? finished : t('Could not play sound. Check your output device and volume.', 'आवाज़ नहीं चलाई जा सकी। आउटपुट डिवाइस और वॉल्यूम जाँचें।'), note].filter(Boolean).join(' ') }));
  }
  return { toggle, stop, togglePlayback, prepareSpeaker, setLanguage, isActive: () => active || !!speaking };
}
