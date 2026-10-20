/** Bounded streaming resampler. No input audio is retained beyond one PCM packet. */
export class MicrophonePCM {
  constructor(inputRate, emit, packetSamples = 2048) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000) throw new Error('Unsupported audio rate');
    this.ratio = 48000 / inputRate;
    this.emit = emit;
    this.phase = 0;
    this.previous = 0;
    this.packet = new ArrayBuffer(packetSamples * 2);
    this.view = new DataView(this.packet);
    this.offset = 0;
  }
  push(samples) {
    for (const raw of samples) {
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      this.phase += this.ratio;
      while (this.phase >= 1) {
        this.phase -= 1;
        const fraction = 1 - this.phase / this.ratio;
        const sample = this.previous + (value - this.previous) * fraction;
        this.view.setInt16(this.offset * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        if (++this.offset === this.packet.byteLength / 2) {
          const complete = this.packet;
          this.packet = new ArrayBuffer(complete.byteLength);
          this.view = new DataView(this.packet);
          this.offset = 0;
          this.emit(complete);
        }
      }
      this.previous = value;
    }
  }
}
