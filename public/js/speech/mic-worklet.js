// Batch mono samples for Vosk (PCM16 amplitude, carried in a Float32Array).
// The output is intentionally silent: never monitor the microphone on speakers.
class AskMicrophone extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.used = 0; }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) for (const value of samples) {
      this.buffer[this.used++] = value * 32768;
      if (this.used === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('ask-microphone', AskMicrophone);
