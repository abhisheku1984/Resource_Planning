/* Spoken turns, not a recorder. Never start a cloud-backed recognizer or use a
   remote synthesis voice, even if it is the browser default. One microphone
   turn ends before any reply is read aloud. Stop/close invalidates callbacks. */
export function createLocalVoice({ onCommand, onState }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const lang = 'en-US';
  const pack = { langs: [lang], processLocally: true };
  let epoch = 0, active = false, mic = null, speaking = null, needsPack = false;
  const status = (text) => onState({ active, needsPack, text });
  function stop(text = 'Voice off. You can still type.') {
    ++epoch; active = false; needsPack = false;
    const old = mic; mic = null;
    try { old?.abort(); } catch { /* already ended */ }
    if (speaking) { speaking = null; window.speechSynthesis?.cancel(); }
    status(text);
  }
  function listen(id, note = '') {
    if (id !== epoch) return;
    try {
      const rec = new Recognition();
      if (!('processLocally' in rec)) return stop('This browser lacks on-device recognition. Use a supported desktop browser or type.');
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
        const errors = { 'not-allowed': 'Allow microphone access, then start voice mode again.',
          'audio-capture': 'No microphone available. Check your input device.', 'no-speech': 'No speech heard. Start voice mode to try again.',
          'language-not-supported': 'Install the on-device English (US) speech pack, then try again.' };
        stop(errors[e.error] || 'On-device recognition is unavailable. Open the app directly in a browser, or type instead.');
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
          const synth = window.speechSynthesis;
          const voice = synth?.getVoices().find((v) => v.localService && /^en\b/i.test(v.lang));
          if (!answer || !voice || !window.SpeechSynthesisUtterance) return listen(id, !voice ? ' No local English read-aloud voice installed.' : '');
          const u = new window.SpeechSynthesisUtterance(answer);
          speaking = u; u.voice = voice; u.lang = voice.lang;
          const done = () => { if (speaking === u) { speaking = null; listen(id); } };
          u.onend = done; u.onerror = done;
          status('Reading reply… microphone paused.'); synth.speak(u);
        } catch { if (id === epoch) stop('Voice turn failed. Try again or type your message.'); }
      };
      rec.start(); status('Listening… Say a question, a CRM command, or “stop listening”.' + note);
    } catch { stop('Microphone unavailable. Allow access on localhost or HTTPS, or type instead.'); }
  }
  async function toggle() {
    if (active) return stop();
    if (!window.isSecureContext) return stop('Voice needs localhost or HTTPS. You can still type here.');
    const id = ++epoch, install = needsPack;
    try {
      if (!Recognition || !('processLocally' in new Recognition())) return stop('On-device speech recognition is not supported here. Open in a supported desktop browser or type instead.');
      active = true; needsPack = false; status(install ? 'Installing English speech pack…' : 'Checking on-device speech…');
      if (install && !await Recognition.install(pack)) return id === epoch && stop('Speech pack not installed. You can still type.');
      const available = Recognition.available ? await Recognition.available(pack) : 'available';
      if (id !== epoch) return;
      if (available !== 'available') {
        active = false; needsPack = available === 'downloadable' && !!Recognition.install;
        return status(needsPack ? 'English (US) needs a one-time browser download. No audio is uploaded.' : 'On-device English (US) is not ready. Check the browser’s speech packs or type instead.');
      }
      window.speechSynthesis?.getVoices(); // prime the asynchronous local voice catalogue
      listen(id);
    } catch { if (id === epoch) stop('Local speech is unavailable. Try a standalone tab with a microphone and an English (US) speech pack.'); }
  }
  return { toggle, stop, isActive: () => active };
}
