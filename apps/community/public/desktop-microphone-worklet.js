import {MicrophonePCM} from './desktop-microphone-pcm.mjs';

class DesktopMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = new MicrophonePCM(sampleRate, packet => this.port.postMessage(packet, [packet]));
  }
  process(inputs, outputs) {
    // The destination keeps the processing graph alive but never plays local mic feedback.
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0]?.[0];
    if (input) this.pcm.push(input);
    return true;
  }
}
registerProcessor('desktop-microphone', DesktopMicrophoneProcessor);
