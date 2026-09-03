import assert from 'node:assert/strict';
import { analyzeSpeech, normalize, removeDc, resampleAudio } from '../app/dsp.ts';
import { analyzeAdvancedSpeech, butterworthFilter, noiseGate, speechBandFilter } from '../app/advanced-dsp.ts';

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

const advancedRate = 16000;
const steadyVoice = Float32Array.from({ length: advancedRate * 2 }, (_, index) => .3 * Math.sin(2 * Math.PI * 160 * index / advancedRate));
const advanced = analyzeAdvancedSpeech(steadyVoice, advancedRate);
assert.ok(advanced.voiceQuality.medianF0Hz && Math.abs(advanced.voiceQuality.medianF0Hz - 160) < 2, 'advanced F0 should track a 160 Hz voice');
assert.ok(advanced.voiceQuality.hnrDb !== null && advanced.voiceQuality.hnrDb > 15, 'a clean periodic signal should have high HNR');
assert.ok(advanced.voiceQuality.validCycleCount > 100, 'cycle-synchronous voice metrics should find enough cycles');
assert.ok(advanced.voiceQuality.jitterLocalPercent !== null && advanced.voiceQuality.jitterLocalPercent < .2, 'a steady tone should have near-zero local jitter');
assert.ok(advanced.voiceQuality.shimmerLocalPercent !== null && advanced.voiceQuality.shimmerLocalPercent < .2, 'a steady tone should have near-zero local shimmer');
assert.ok(advanced.mfccFrames.length > 10, 'MFCC analysis should return a time series');
assert.ok(advanced.mfccFrames.every((frame) => frame.coefficients.length === 13 && frame.delta.length === 13 && frame.deltaDelta.length === 13), 'MFCC, delta, and delta-delta should each contain 13 coefficients');
assert.ok(advanced.mfccFrames.flatMap((frame) => [...frame.coefficients, ...frame.delta, ...frame.deltaDelta]).every(Number.isFinite), 'MFCC output should be finite');
for (const expectedPitch of [70, 120, 220, 240, 300, 395, 400]) {
  const tone = Float32Array.from({ length: advancedRate }, (_, index) => .25 * Math.sin(2 * Math.PI * expectedPitch * index / advancedRate));
  const pitchAnalysis = analyzeAdvancedSpeech(tone, advancedRate);
  assert.ok(pitchAnalysis.voiceQuality.medianF0Hz && Math.abs(pitchAnalysis.voiceQuality.medianF0Hz - expectedPitch) < 2, `F0 should avoid octave errors at ${expectedPitch} Hz`);
  assert.ok(pitchAnalysis.voiceQuality.hnrDb !== null && pitchAnalysis.voiceQuality.hnrDb > 30, `clean ${expectedPitch} Hz HNR should not depend on an integer lag`);
}

const cycleCount = 400;
const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const localPerturbationPercent = (values) => 100 * average(values.slice(1).map((value, index) => Math.abs(value - values[index]))) / average(values);
function buildCycles(periodForCycle, amplitudeForCycle, count = cycleCount) {
  const values = [];
  const periods = [];
  const amplitudes = [];
  for (let cycle = 0; cycle < count; cycle += 1) {
    const periodSamples = periodForCycle(cycle);
    const amplitude = amplitudeForCycle(cycle);
    periods.push(periodSamples / advancedRate);
    amplitudes.push(2 * amplitude);
    for (let index = 0; index < periodSamples; index += 1) values.push(amplitude * Math.cos(2 * Math.PI * index / periodSamples));
  }
  return { samples: Float32Array.from(values), periods, amplitudes };
}
const jitterFixture = buildCycles(
  (cycle) => Math.round(80 * (1 + .05 * Math.sin(2 * Math.PI * cycle / 40))),
  () => .3,
);
const jitterAnalysis = analyzeAdvancedSpeech(jitterFixture.samples, advancedRate);
const expectedJitter = localPerturbationPercent(jitterFixture.periods);
assert.ok(jitterAnalysis.voiceQuality.jitterLocalPercent !== null && Math.abs(jitterAnalysis.voiceQuality.jitterLocalPercent - expectedJitter) < .03, 'local jitter should match known cycle-period perturbation');
const shimmerFixture = buildCycles(
  () => 80,
  (cycle) => .3 * (1 + .1 * Math.sin(2 * Math.PI * cycle / 40)),
);
const shimmerAnalysis = analyzeAdvancedSpeech(shimmerFixture.samples, advancedRate);
const expectedShimmer = localPerturbationPercent(shimmerFixture.amplitudes);
assert.ok(shimmerAnalysis.voiceQuality.shimmerLocalPercent !== null && Math.abs(shimmerAnalysis.voiceQuality.shimmerLocalPercent - expectedShimmer) < .03, 'local shimmer should match known cycle-amplitude perturbation');
const quietModulatedRun = buildCycles(
  () => 80,
  (cycle) => .1 * (1 + .1 * Math.sin(2 * Math.PI * cycle / 40)),
  400,
);
const loudSteadyRun = buildCycles(() => 80, () => .9, 400);
const separatedRuns = new Float32Array(quietModulatedRun.samples.length + advancedRate / 5 + loudSteadyRun.samples.length);
separatedRuns.set(quietModulatedRun.samples);
separatedRuns.set(loudSteadyRun.samples, quietModulatedRun.samples.length + advancedRate / 5);
const separatedRunsAnalysis = analyzeAdvancedSpeech(separatedRuns, advancedRate);
const expectedSeparatedShimmer = localPerturbationPercent(quietModulatedRun.amplitudes) / 2;
assert.ok(separatedRunsAnalysis.voiceQuality.shimmerLocalPercent !== null && Math.abs(separatedRunsAnalysis.voiceQuality.shimmerLocalPercent - expectedSeparatedShimmer) < .08, 'shimmer should be normalized within each voiced run before pair-weighted aggregation');

let mfccRandomState = 17;
const broadBand = Float32Array.from({ length: advancedRate }, () => {
  mfccRandomState = mfccRandomState * 16807 % 2147483647;
  return .4 * (mfccRandomState / 2147483647 * 2 - 1);
});
const halfGain = Float32Array.from(broadBand, (value) => value * .5);
const broadBandMfcc = analyzeAdvancedSpeech(broadBand, advancedRate).mfccFrames[20].coefficients;
const halfGainMfcc = analyzeAdvancedSpeech(halfGain, advancedRate).mfccFrames[20].coefficients;
const expectedC0Shift = 2 * Math.log(.5) * Math.sqrt(26);
assert.ok(Math.abs((halfGainMfcc[0] - broadBandMfcc[0]) - expectedC0Shift) < 1e-6, 'halving gain should produce the orthonormal log-power shift in MFCC C0');
assert.ok(halfGainMfcc.slice(1).every((value, index) => Math.abs(value - broadBandMfcc[index + 1]) < 1e-9), 'uniform gain should not change MFCC C1–C12');

const mfccRampSlope = .1;
const longMfccRamp = Float32Array.from({ length: advancedRate * 8 }, (_, index) => (
  .2 * Math.exp(mfccRampSlope * index / advancedRate) * Math.sin(2 * Math.PI * 200 * index / advancedRate)
));
const longMfcc = analyzeAdvancedSpeech(longMfccRamp, advancedRate).mfccFrames;
const middleMfcc = longMfcc[Math.floor(longMfcc.length / 2)];
const expectedC0Delta = 2 * mfccRampSlope * .01 * Math.sqrt(26);
assert.ok(longMfcc.length < 600 && longMfcc[1].time - longMfcc[0].time > .01, 'long MFCC series should be downsampled for storage');
assert.ok(Math.abs(middleMfcc.delta[0] - expectedC0Delta) < 1e-4, 'MFCC deltas should be computed at the native 10 ms hop before display downsampling');
const onsetVoice = Float32Array.from({ length: advancedRate * 1.2 }, (_, index) => index < advancedRate * .2 ? 0 : .3 * Math.sin(2 * Math.PI * 160 * (index - advancedRate * .2) / advancedRate));
const onsetAnalysis = analyzeAdvancedSpeech(onsetVoice, advancedRate);
assert.ok(onsetAnalysis.voiceQuality.validCycleCount > 100, 'cycle tracking should recover after a silence-to-voice onset');
const splitAmplitudeVoice = new Float32Array(Math.round(advancedRate * .39));
for (let index = Math.round(advancedRate * .04); index < Math.round(advancedRate * .16); index += 1) splitAmplitudeVoice[index] = .2 * Math.sin(2 * Math.PI * 160 * (index - advancedRate * .04) / advancedRate);
for (let index = Math.round(advancedRate * .23); index < Math.round(advancedRate * .35); index += 1) splitAmplitudeVoice[index] = .4 * Math.sin(2 * Math.PI * 160 * (index - advancedRate * .23) / advancedRate);
const splitAmplitudeAnalysis = analyzeAdvancedSpeech(splitAmplitudeVoice, advancedRate);
assert.ok(splitAmplitudeAnalysis.voiceQuality.shimmerLocalPercent !== null && splitAmplitudeAnalysis.voiceQuality.shimmerLocalPercent < .5, 'shimmer must not compare amplitudes across separate voiced runs');
const splitPitchVoice = new Float32Array(Math.round(advancedRate * .48));
for (let index = Math.round(advancedRate * .04); index < Math.round(advancedRate * .19); index += 1) splitPitchVoice[index] = .3 * Math.sin(2 * Math.PI * 140 * (index - advancedRate * .04) / advancedRate);
for (let index = Math.round(advancedRate * .27); index < Math.round(advancedRate * .42); index += 1) splitPitchVoice[index] = .3 * Math.sin(2 * Math.PI * 180 * (index - advancedRate * .27) / advancedRate);
const splitPitchAnalysis = analyzeAdvancedSpeech(splitPitchVoice, advancedRate);
assert.ok(splitPitchAnalysis.voiceQuality.validCycleCount > 35, 'cycle filtering should retain separate F0 populations across voiced runs');

let vowel = new Float32Array(advancedRate * 2);
for (let index = 0; index < vowel.length; index += advancedRate / 100) vowel[index] = 1;
for (const [frequency, bandwidth] of [[500, 60], [1500, 90], [2500, 120]]) {
  const radius = Math.exp(-Math.PI * bandwidth / advancedRate);
  const feedback1 = 2 * radius * Math.cos(2 * Math.PI * frequency / advancedRate);
  const feedback2 = -(radius ** 2);
  const resonated = new Float32Array(vowel.length);
  for (let index = 0; index < vowel.length; index += 1) resonated[index] = vowel[index] + feedback1 * (resonated[index - 1] ?? 0) + feedback2 * (resonated[index - 2] ?? 0);
  let peak = 0;
  for (const value of resonated) peak = Math.max(peak, Math.abs(value));
  vowel = Float32Array.from(resonated, (value) => value / peak * .6);
}
const vowelAnalysis = analyzeAdvancedSpeech(vowel, advancedRate);
assert.ok(vowelAnalysis.formantMediansHz[0] && Math.abs(vowelAnalysis.formantMediansHz[0] - 500) < 100, 'LPC should recover synthetic F1');
assert.ok(vowelAnalysis.formantMediansHz[1] && Math.abs(vowelAnalysis.formantMediansHz[1] - 1500) < 150, 'LPC should recover synthetic F2');
assert.ok(vowelAnalysis.formantMediansHz[2] && Math.abs(vowelAnalysis.formantMediansHz[2] - 2500) < 200, 'LPC should recover synthetic F3');

const mixedTone = Float32Array.from({ length: advancedRate }, (_, index) => .25 * Math.sin(2 * Math.PI * 120 * index / advancedRate) + .25 * Math.sin(2 * Math.PI * 3000 * index / advancedRate));
const lowPassed = butterworthFilter(mixedTone, advancedRate, 500, 'lowpass');
const projection = (data, frequency) => Math.abs(data.reduce((total, value, index) => total + value * Math.sin(2 * Math.PI * frequency * index / advancedRate), 0) * 2 / data.length);
assert.ok(projection(lowPassed, 120) > projection(lowPassed, 3000) * 20, 'low-pass filtering should reject out-of-band energy');
const fullScaleStep = Float32Array.from({ length: advancedRate }, () => .98);
const halfScaleStep = Float32Array.from({ length: advancedRate }, () => .49);
const fullScaleFiltered = butterworthFilter(fullScaleStep, advancedRate, 500, 'lowpass');
const halfScaleFiltered = butterworthFilter(halfScaleStep, advancedRate, 500, 'lowpass');
let maximumLinearityError = 0;
for (let index = 0; index < fullScaleFiltered.length; index += 1) maximumLinearityError = Math.max(maximumLinearityError, Math.abs(fullScaleFiltered[index] * .5 - halfScaleFiltered[index]));
assert.ok(maximumLinearityError < 1e-6, 'Butterworth sections should remain linear without internal clipping');
const bandPassed = speechBandFilter(mixedTone, advancedRate, 200, 3500);
assert.ok(projection(bandPassed, 3000) > projection(bandPassed, 120) * 5, 'speech band filter should reject energy below its high-pass cutoff');

const gateInput = Float32Array.from({ length: advancedRate * 2 }, (_, index) => (index < advancedRate ? .001 : .2) * Math.sin(2 * Math.PI * 220 * index / advancedRate));
const gated = noiseGate(gateInput, advancedRate, -35);
const rms = (data, start, end) => Math.sqrt(data.subarray(start, end).reduce((total, value) => total + value * value, 0) / Math.max(1, end - start));
assert.ok(rms(gated, 0, advancedRate / 2) < rms(gateInput, 0, advancedRate / 2) * .2, 'noise gate should attenuate quiet background');
assert.ok(rms(gated, advancedRate * 1.25, advancedRate * 1.75) > rms(gateInput, advancedRate * 1.25, advancedRate * 1.75) * .8, 'noise gate should retain strong speech-like energy');

const emptyAdvanced = analyzeAdvancedSpeech(new Float32Array(), advancedRate);
assert.equal(emptyAdvanced.pitchFrames.length, 0, 'empty input should produce no pitch frames');
assert.equal(emptyAdvanced.voiceQuality.medianF0Hz, null, 'empty input should not invent F0');
const corruptedAdvanced = analyzeAdvancedSpeech(Float32Array.from({ length: 500 }, (_, index) => index === 250 ? Number.NaN : 0), advancedRate);
assert.ok(corruptedAdvanced.mfccFrames.flatMap((frame) => frame.coefficients).every(Number.isFinite), 'invalid samples should be sanitized before MFCC extraction');

console.log('DSP checks passed', {
  segmentCount: analysis.segments.length,
  durations,
  pitchHz: analysis.estimatedPitchHz,
  advancedPitchHz: advanced.voiceQuality.medianF0Hz,
  hnrDb: advanced.voiceQuality.hnrDb,
});
