/* One chosen language per voice session. Never substitute the other language,
   a cloud-backed recognizer, or a remote synthesis voice. Switching language,
   like Stop, invalidates pending pack checks, recognition and spoken replies. */
const pack = (lang) => ({ langs: [lang], processLocally: true });
const family = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];
function locales(language) {
  const preferred = (navigator.languages || [navigator.language]).filter((s) => family(s) === language);
  const defaults = language === 'hi' ? ['hi-IN', 'hi'] : ['en-US', 'en-IN', 'en-GB', 'en'];
  return [...new Set([...preferred, ...defaults])];
}
async function findPack(Recognition, languages, current) {
  // Engines without static pack APIs can still enforce processLocally on start.
  if (!Recognition.available) return { state: 'available', lang: languages[0] };
  let downloading, downloadable, unknown = false;
  for (const lang of languages) {
    // A combined langs array tests whether ALL the packs exist, not any one.
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

export function createLocalVoice({ onCommand, onState, onPlayback = () => {}, language: initial = 'en' }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let language = initial === 'hi' ? 'hi' : 'en';
  const t = (en, hi) => language === 'hi' ? hi : en;
  let epoch = 0, active = false, mic = null, speaking = null, installLang = null;
  const status = (text, action = active ? 'stop' : 'start', help = false) => onState({ active, text, action, help });
  function cancelSpeech() {
    if (!speaking) return;
    speaking = null; // ignore late end/error events from this utterance
    window.speechSynthesis?.cancel();
  }
  function stop(text = t('Voice off. You can still type.', 'माइक बंद है। आप हिन्दी में लिख सकते हैं।'), help = false) {
    ++epoch; active = false; installLang = null;
    const old = mic; mic = null;
    try { old?.abort(); } catch { /* already ended */ }
    cancelSpeech();
    status(text, 'start', help);
  }
  function setLanguage(next) {
    language = next === 'hi' ? 'hi' : 'en';
    stop(t('English selected. Start voice mode or type a question.', 'हिन्दी चुनी गई है। बोलना शुरू करें या अपना सवाल लिखें।'));
  }
  function prepareSpeaker() {
    // Some browsers populate the catalogue asynchronously after the first query.
    // This neither plays sound nor requests microphone access.
    try { window.speechSynthesis?.getVoices(); } catch { /* speaker is optional */ }
  }
  // False means there is no matching device voice. Otherwise done reports
  // success/failure, unless this utterance has since been cancelled.
  function speak(text, done, preferredLang) {
    try {
      const synth = window.speechSynthesis;
      const voices = synth?.getVoices().filter((v) => v.localService === true && family(v.lang) === language) || [];
      const voice = voices.find((v) => v.lang === preferredLang) || voices[0];
      if (!voice || !window.SpeechSynthesisUtterance) return false;
      const u = new window.SpeechSynthesisUtterance(text);
      speaking = u; u.voice = voice; u.lang = voice.lang;
      const finish = (ok) => { if (speaking === u) { speaking = null; done(ok); } };
      u.onend = () => finish(true); u.onerror = () => finish(false);
      synth.speak(u);
    } catch { speaking = null; done(false); }
    return true;
  }
  function listen(id, lang, note = '') {
    if (id !== epoch) return;
    try {
      const rec = new Recognition();
      if (!('processLocally' in rec)) return stop(t('This browser cannot recognize speech on-device.', 'यह ब्राउज़र डिवाइस पर आवाज़ नहीं पहचान सकता।'), true);
      rec.processLocally = true;
      if (rec.processLocally !== true) return stop(t('On-device recognition could not be enabled. Type instead.', 'स्थानीय वाक् पहचान चालू नहीं हो सकी। हिन्दी में लिखें।'), true);
      rec.lang = lang; rec.continuous = false; rec.interimResults = false;
      mic = rec;
      let transcript = '';
      rec.onresult = (e) => {
        if (mic !== rec || transcript) return;
        transcript = Array.from(e.results).filter((r) => r.isFinal).map((r) => r[0].transcript).join(' ').trim();
        if (transcript) rec.stop();
      };
      rec.onerror = (e) => {
        if (mic !== rec) return;
        const errors = {
          'not-allowed': t('Microphone access was denied. Allow the microphone for this site, then try again.', 'माइक की अनुमति नहीं मिली। इस साइट के लिए माइक की अनुमति देकर फिर कोशिश करें।'),
          'audio-capture': t('No microphone available. Check the input device in your system settings.', 'माइक नहीं मिला। अपने डिवाइस की इनपुट सेटिंग जाँचें।'),
          'no-speech': t('No speech heard. Start voice mode to try again.', 'कोई आवाज़ नहीं सुनाई दी। फिर से बोलना शुरू करें।'),
          'service-not-allowed': t('The on-device speech service is blocked or unavailable in this tab.', 'इस टैब में स्थानीय वाक् पहचान उपलब्ध नहीं है या इसकी अनुमति नहीं है।'),
          'language-not-supported': t(`The browser could not use its ${lang} speech pack. Check again after the pack is installed.`, `${lang} स्पीच पैक का उपयोग नहीं हो सका। पैक के इंस्टॉल होने के बाद फिर जाँचें।`),
        };
        stop(errors[e.error] || t('On-device recognition failed. Open the app in its own tab and try again.', 'वाक् पहचान नहीं चल सकी। ऐप को अलग टैब में खोलकर फिर कोशिश करें।'), e.error !== 'no-speech');
      };
      rec.onend = async () => {
        if (mic !== rec) return;
        mic = null;
        if (!transcript) return stop(t('No speech heard. Start voice mode to try again.', 'कोई आवाज़ नहीं सुनाई दी। फिर से बोलना शुरू करें।'));
        if (/^(?:stop (?:voice(?: mode)?|listening)|voice off)[.!?]?$/i.test(transcript) ||
          (language === 'hi' && /^(?:सुनना|माइक|आवाज़|आवाज) बंद (?:करें|करो|कीजिए)[।.!?]?$/.test(transcript))) return stop();
        status(t('Checking… microphone paused.', 'जाँच जारी है… माइक रुका हुआ है।'));
        try {
          const answer = await onCommand(transcript);
          if (id !== epoch) return;
          if (!answer) return listen(id, lang);
          status(t('Reading reply… microphone paused.', 'जवाब पढ़ा जा रहा है… माइक रुका हुआ है।'));
          const resume = (ok) => listen(id, lang, ok ? '' : t(' Could not read the reply aloud.', ' जवाब पढ़कर नहीं सुनाया जा सका।'));
          if (!speak(answer, resume, lang)) listen(id, lang, t(' No local English read-aloud voice available.', ' हिन्दी में पढ़ने के लिए स्थानीय आवाज़ उपलब्ध नहीं है।'));
        } catch { if (id === epoch) stop(t('Voice turn failed. Try again or type your message.', 'जवाब नहीं मिल सका। फिर कोशिश करें या अपना सवाल लिखें।')); }
      };
      rec.start(); status(t(`Listening (${lang})… Say a question, a CRM command, or “stop listening”.`, `सुन रहे हैं (${lang})… सवाल पूछें, CRM का निर्देश दें या कहें “सुनना बंद करें”।`) + note);
    } catch { stop(t('The microphone could not start. Check this site’s microphone permission.', 'माइक चालू नहीं हो सका। इस साइट की माइक अनुमति जाँचें।'), true); }
  }
  async function toggle() {
    if (active) return stop();
    if (speaking) return; // standalone playback is stopped by its own button, never by opening the mic
    if (!window.isSecureContext) return stop(t('Voice needs localhost on this computer, or HTTPS. Opening a remote HTTP address is not enough.', 'इस कंप्यूटर पर localhost या HTTPS का उपयोग करें। दूसरे कंप्यूटर के HTTP पते पर माइक उपलब्ध नहीं होगा।'), true);
    const id = ++epoch, requested = installLang;
    try {
      if (blockedByPolicy('on-device-speech-recognition') || blockedByPolicy('microphone')) {
        return stop(t('This page’s permissions policy blocks local speech or microphone access. Open the app in its own tab. If it is managed, check with IT.', 'इस पेज की नीति माइक या स्थानीय वाक् पहचान की अनुमति नहीं देती। ऐप को अलग टैब में खोलें या अपने आईटी व्यवस्थापक से पूछें।'), true);
      }
      if (!Recognition || !('processLocally' in new Recognition())) return stop(t('This browser does not provide on-device recognition. Use a current desktop browser, device dictation, or type instead.', 'इस ब्राउज़र में स्थानीय वाक् पहचान उपलब्ध नहीं है। हिन्दी में टाइप करें या समर्थित डेस्कटॉप ब्राउज़र आज़माएँ।'), true);
      active = true; installLang = null;
      status(requested ? t(`Installing the ${requested} speech pack…`, `${requested} स्पीच पैक इंस्टॉल हो रहा है…`) : t('Checking local English speech packs…', 'स्थानीय हिन्दी स्पीच पैक की जाँच हो रही है…'));
      // Only an explicit second click can request the browser download.
      if (requested) {
        const installed = await Recognition.install(pack(requested));
        if (id !== epoch) return;
        if (!installed) return stop(t('The browser did not install the pack. Check the browser download prompt and connection, then try again.', 'पैक इंस्टॉल नहीं हुआ। ब्राउज़र का डाउनलोड संदेश और इंटरनेट कनेक्शन जाँचें, फिर कोशिश करें।'), true);
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
      const message = found.state === 'unavailable' ? t('No local English speech pack is available to this site in this browser.', 'इस ब्राउज़र में इस साइट के लिए स्थानीय हिन्दी स्पीच पैक उपलब्ध नहीं है। आप हिन्दी में लिख सकते हैं।')
        : found.state === 'downloadable' && !Recognition.install ? t('An English pack is downloadable, but this browser cannot install it from this page.', 'हिन्दी पैक डाउनलोड किया जा सकता है, लेकिन यह ब्राउज़र इस पेज से उसे इंस्टॉल नहीं कर सकता।')
        : t('The browser has not confirmed that an English speech pack is ready.', 'ब्राउज़र ने अभी हिन्दी स्पीच पैक तैयार होने की पुष्टि नहीं की है।');
      status(message, 'retry', true);
    } catch (err) {
      if (id === epoch) stop(err.name === 'NotAllowedError' || err.name === 'SecurityError'
        ? t('The browser blocked access to local speech packs. Open the app in its own tab or check with IT.', 'ब्राउज़र ने स्थानीय स्पीच पैक की अनुमति नहीं दी। ऐप को अलग टैब में खोलें या आईटी व्यवस्थापक से पूछें।')
        : t('Could not check or install a browser speech pack. Open the app in its own tab and try again.', 'स्पीच पैक की जाँच या स्थापना नहीं हो सकी। ऐप को अलग टैब में खोलकर फिर कोशिश करें।'), true);
    }
  }
  // Standalone output doesn't touch the microphone, its preflight action, or
  // installLang. A speaker test must never grant consent to a pack download.
  function togglePlayback(reply) {
    if (active) return; // hands-free mode already handles its own spoken replies
    if (speaking) {
      cancelSpeech();
      return onPlayback({ playing: false, text: t('Playback stopped. The app microphone is off.', 'आवाज़ बंद कर दी गई है। ऐप का माइक बंद है।') });
    }
    const sample = t('This is the English speaker test. To speak, select Start voice mode. Or type a question and press Enter.', 'यह हिन्दी आवाज़ की जाँच है। माइक के लिए बोलना शुरू करें चुनें, या सवाल लिखकर एंटर दबाएँ।');
    onPlayback({ playing: true, text: reply ? t('Reading the last reply. The app microphone is off.', 'पिछला जवाब पढ़ा जा रहा है। ऐप का माइक बंद है।')
      : t('Playing a speaker test. The app microphone is off.', 'स्पीकर की जाँच हो रही है। ऐप का माइक बंद है।') });
    const finished = reply ? t('Finished reading. The app microphone is off.', 'जवाब पढ़ लिया गया। ऐप का माइक बंद है।')
      : t('Speaker test finished. No sound? Check your speakers or headphones and volume.', 'स्पीकर की जाँच पूरी हुई। आवाज़ नहीं आई? स्पीकर या हेडफ़ोन और वॉल्यूम जाँचें।');
    const done = (ok) => onPlayback({ playing: false, help: !ok, text: ok ? finished
      : t('Could not play sound. Check your output device and volume, or use text.', 'आवाज़ नहीं चलाई जा सकी। आउटपुट डिवाइस और वॉल्यूम जाँचें या लिखकर पूछें।') });
    if (!speak(reply || sample, done)) onPlayback({ playing: false, help: true, text: t(
      'No local English read-aloud voice is available. Try again after a local English voice is ready, or type and read replies here.',
      'पढ़कर सुनाने के लिए हिन्दी की स्थानीय आवाज़ उपलब्ध नहीं है। स्थानीय आवाज़ तैयार होने पर फिर कोशिश करें या लिखकर पूछें और जवाब यहीं पढ़ें।') });
  }
  return { toggle, stop, togglePlayback, prepareSpeaker, setLanguage, isActive: () => active || !!speaking };
}
