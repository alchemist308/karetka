"use strict";

// Synthesize each voice once at the device's sample rate. All voices start and end at zero.
function mechanicalKey(sampleRate, kind, variant = 0) {
  const returning = kind === "return";
  const space = kind === "space";
  const duration = returning ? 0.29 : 0.125;
  const samples = new Float32Array(Math.ceil(sampleRate * duration));
  const cutoff = returning ? 720 : space ? 790 : 1050 + variant * 45;
  const smoothing = 1 - Math.exp(-2 * Math.PI * cutoff / sampleRate);
  const bodyHz = returning ? 116 : space ? 124 : 168 + variant * 6;
  const releaseTime = returning ? 0.074 : 0.035;
  let seed = 5319 + variant * 17, low = 0, felt = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    low += smoothing * (seed / 2147483648 - 1 - low);
    felt += smoothing * (low - felt);
    const onset = 1 - Math.exp(-t / 0.005);
    const strike = onset * Math.exp(-t / (returning ? 0.043 : 0.021));
    const back = Math.max(0, t - releaseTime);
    const release = (1 - Math.exp(-back / 0.005)) * Math.exp(-back / 0.019);
    const body = Math.sin(2 * Math.PI * bodyHz * t);
    let v = strike * (0.17 * body + 0.55 * felt) + release * 0.18 * felt;
    if (returning) {
      const ring = Math.max(0, t - 0.045);
      v += 0.037 * Math.sin(2 * Math.PI * 665 * ring) *
        (1 - Math.exp(-ring / 0.008)) * Math.exp(-ring / 0.065);
    }
    samples[i] = v * Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.008));
  }
  return samples;
}
if (typeof module !== "undefined") module.exports = mechanicalKey;
