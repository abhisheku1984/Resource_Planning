// Level mono speech in-place. Measure 20 ms frames, not the silence between
// sentences. One gain per phrase preserves its dynamics (no pumping on vowels).
// The soft knee only touches peaks; leave ~1 dB sample headroom before playback.
export function levelSpeech(pcm, hz, volume = 1) {
  const frame = Math.max(1, Math.round(hz * 0.02));
  const energies = new Float32Array(Math.ceil(pcm.length / frame));
  let loudest = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (!Number.isFinite(pcm[i])) throw new Error('Invalid speech sample');
    energies[Math.floor(i / frame)] += pcm[i] * pcm[i];
  }
  for (let i = 0; i < energies.length; i++) {
    energies[i] /= Math.min(frame, pcm.length - i * frame);
    loudest = Math.max(loudest, energies[i]);
  }
  let energy = 0, frames = 0;
  const gate = Math.max(1e-6, loudest * 0.01);
  for (const e of energies) if (e >= gate) { energy += e; frames++; }
  volume = Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
  // Boost before the limiter, attenuate after it. Even 200% cannot clip.
  const gain = (frames ? Math.min(4, 0.20 / Math.sqrt(energy / frames)) : 1) * Math.max(1, volume);
  const fade = Math.max(1, Math.round(hz * 0.003));
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i] * gain, a = Math.abs(x);
    const limited = a <= 0.72 ? x : Math.sign(x) * (0.72 + 0.17 * (1 - Math.exp(-(a - 0.72) / 0.17)));
    pcm[i] = limited * Math.min(1, volume) * Math.min(1, i / fade, (pcm.length - 1 - i) / fade);
  }
}
