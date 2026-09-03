import assert from 'node:assert/strict';
import { analyzeSpeech, normalize, removeDc, resampleAudio } from '../app/dsp.ts';

const sampleRate = 48000;
const samples = new Float32Array(sampleRate * 3);

for (let index = sampleRate; index < sampleRate * 2; index += 1) {
  samples[index] = 0.32 * Math.sin(2 * Math.PI * 160 * index / sampleRate);
}

let randomState = 7;
for (let index = sampleRate * 2; index < sampleRate * 3; index += 1) {
  randomState = randomState * 16807 % 2147483647;
  samples[index] = 0.14 * (randomState / 2147483647 * 2 - 1);
}

const analysis = analyzeSpeech(samples, sampleRate);
const durations = { 0: 0, 1: 0, 2: 0 };
for (const segment of analysis.segments) durations[segment.classId] += segment.end - segment.start;

assert.ok(durations[0] > 0.8, 'silence should be classified as background');
assert.ok(durations[2] > 0.7, 'the periodic sine should be classified as voiced');
assert.ok(durations[1] > 0.7, 'the noise should be classified as unvoiced');
assert.ok(analysis.estimatedPitchHz && Math.abs(analysis.estimatedPitchHz - 160) < 5, 'pitch should be close to 160 Hz');

const withDc = Float32Array.from([0.2, 0.4, 0.6]);
const centered = removeDc(withDc);
assert.ok(Math.abs(centered[0] + centered[2]) < 1e-6, 'DC removal should center samples');
const normalized = normalize(Float32Array.from([-0.25, 0.5]));
assert.ok(Math.abs(normalized[1] - 0.98) < 1e-6, 'normalization should set the peak to 0.98');

const at8k = new Float32Array(8000);
for (let index = 0; index < at8k.length; index += 1) at8k[index] = Math.sin(2 * Math.PI * 440 * index / 8000);
const at2k = await resampleAudio(at8k, 8000, 2000);
assert.equal(at2k.length, 2000, '2 kHz resampling should produce the correct sample count');
assert.ok(at2k.every(Number.isFinite), '2 kHz resampling should contain only finite samples');
const playbackReady = await resampleAudio(at2k, 2000, 8000);
assert.equal(playbackReady.length, 8000, '2 kHz audio should upsample for Web Audio playback');

console.log('DSP checks passed', {
  segmentCount: analysis.segments.length,
  durations,
  pitchHz: analysis.estimatedPitchHz,
});
