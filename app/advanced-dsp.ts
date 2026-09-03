export type PitchFrame = {
  time: number;
  pitchHz: number | null;
  periodicity: number;
  rmsDb: number;
  amplitude: number;
};

export type FormantFrame = {
  time: number;
  f1Hz: number | null;
  f2Hz: number | null;
  f3Hz: number | null;
};

export type MfccFrame = {
  time: number;
  coefficients: number[];
  delta: number[];
  deltaDelta: number[];
};

export type VoiceQuality = {
  voicedFrames: number;
  totalFrames: number;
  validCycleCount: number;
  voicedRatio: number;
  meanF0Hz: number | null;
  medianF0Hz: number | null;
  f0StdHz: number | null;
  minF0Hz: number | null;
  maxF0Hz: number | null;
  jitterLocalPercent: number | null;
  shimmerLocalPercent: number | null;
  hnrDb: number | null;
};

export type AdvancedAnalysisResult = {
  sampleRate: number;
  durationSec: number;
  frameLengthMs: number;
  hopLengthMs: number;
  pitchFrames: PitchFrame[];
  voiceQuality: VoiceQuality;
  formantFrames: FormantFrame[];
  formantMediansHz: [number | null, number | null, number | null];
  validFormantFrames: number;
  mfccFrames: MfccFrame[];
  mfccCoefficientCount: number;
};

export type FilterType = 'highpass' | 'lowpass';

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * clamp(ratio, 0, 1))];
}

function median(values: number[]) {
  return values.length ? percentile(values, .5) : null;
}

function mean(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function standardDeviation(values: number[]) {
  const average = mean(values);
  if (average === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length);
}

function nextPowerOfTwo(value: number) {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
}

function fftPowerSpectrum(frame: Float64Array, fftSize: number) {
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  real.set(frame.subarray(0, Math.min(frame.length, fftSize)));

  for (let index = 1, reversed = 0; index < fftSize; index += 1) {
    let bit = fftSize >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let length = 2; length <= fftSize; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < fftSize; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const even = offset + index;
        const odd = even + length / 2;
        const oddReal = twiddleReal * real[odd] - twiddleImaginary * imaginary[odd];
        const oddImaginary = twiddleReal * imaginary[odd] + twiddleImaginary * real[odd];
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  return Float64Array.from({ length: fftSize / 2 + 1 }, (_, index) => (real[index] ** 2 + imaginary[index] ** 2) / fftSize);
}

function estimatePitch(frame: Float64Array, sampleRate: number) {
  const stride = Math.max(1, Math.floor(sampleRate / 8000));
  const reducedRate = sampleRate / stride;
  const reducedLength = Math.floor(frame.length / stride);
  const reduced = new Float64Array(reducedLength);
  let average = 0;
  for (let index = 0; index < reducedLength; index += 1) {
    reduced[index] = frame[index * stride];
    average += reduced[index];
  }
  average /= Math.max(1, reducedLength);
  for (let index = 0; index < reducedLength; index += 1) reduced[index] -= average;

  const minimumLag = Math.max(2, Math.ceil(reducedRate / 400));
  const maximumLag = Math.min(reducedLength - 3, Math.floor(reducedRate / 70));
  if (maximumLag <= minimumLag) return { pitchHz: null, periodicity: 0 };
  // Candidate lags stay inside the advertised 70–400 Hz range, while one
  // extra lag on either side remains available for sub-sample interpolation.
  const interpolationMaximumLag = Math.min(reducedLength - 2, maximumLag + 1);
  const cumulativeMeanNormalizedDifference = new Float64Array(interpolationMaximumLag + 1);
  cumulativeMeanNormalizedDifference[0] = 1;
  let runningDifference = 0;

  for (let lag = 1; lag <= interpolationMaximumLag; lag += 1) {
    let difference = 0;
    for (let index = 0; index < reducedLength - lag; index += 1) {
      const delta = reduced[index] - reduced[index + lag];
      difference += delta * delta;
    }
    runningDifference += difference;
    cumulativeMeanNormalizedDifference[lag] = runningDifference > 1e-18 ? difference * lag / runningDifference : 1;
  }

  let bestLag = 0;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if (cumulativeMeanNormalizedDifference[lag] < .2) {
      bestLag = lag;
      while (bestLag < maximumLag && cumulativeMeanNormalizedDifference[bestLag + 1] < cumulativeMeanNormalizedDifference[bestLag]) bestLag += 1;
      break;
    }
  }
  if (!bestLag) {
    bestLag = minimumLag;
    for (let lag = minimumLag + 1; lag <= maximumLag; lag += 1) {
      if (cumulativeMeanNormalizedDifference[lag] < cumulativeMeanNormalizedDifference[bestLag]) bestLag = lag;
    }
  }

  const left = cumulativeMeanNormalizedDifference[bestLag - 1];
  const center = cumulativeMeanNormalizedDifference[bestLag];
  const right = cumulativeMeanNormalizedDifference[bestLag + 1];
  const denominator = left - 2 * center + right;
  const correction = Math.abs(denominator) > 1e-12
    ? clamp(.5 * (left - right) / denominator, -.5, .5)
    : 0;
  const refinedLag = clamp(bestLag + correction, reducedRate / 400, reducedRate / 70);
  const integerLag = Math.floor(refinedLag);
  const fractionalLag = refinedLag - integerLag;
  let numerator = 0;
  let energyA = 0;
  let energyB = 0;
  for (let index = 0; index < reducedLength - integerLag - 1; index += 1) {
    const a = reduced[index];
    const b = reduced[index + integerLag] * (1 - fractionalLag) + reduced[index + integerLag + 1] * fractionalLag;
    numerator += a * b;
    energyA += a * a;
    energyB += b * b;
  }
  const correlation = numerator / Math.sqrt(energyA * energyB + 1e-18);
  return {
    pitchHz: reducedRate / refinedLag,
    periodicity: clamp(correlation, 0, 1),
  };
}

function extractPitchFrames(samples: Float32Array, sampleRate: number, frameLength: number, hopLength: number) {
  const provisional: PitchFrame[] = [];
  for (let start = 0; start + Math.ceil(frameLength / 2) <= samples.length; start += hopLength) {
    const actualLength = Math.min(frameLength, samples.length - start);
    const frame = new Float64Array(frameLength);
    let square = 0;
    for (let index = 0; index < actualLength; index += 1) {
      frame[index] = Number.isFinite(samples[start + index]) ? samples[start + index] : 0;
      square += frame[index] ** 2;
    }
    const amplitude = Math.sqrt(square / Math.max(1, actualLength));
    const rmsDb = 20 * Math.log10(Math.max(amplitude, 1e-8));
    const pitch = rmsDb > -72 ? estimatePitch(frame, sampleRate) : { pitchHz: null, periodicity: 0 };
    provisional.push({
      time: (start + actualLength / 2) / sampleRate,
      pitchHz: pitch.pitchHz,
      periodicity: pitch.periodicity,
      rmsDb,
      amplitude,
    });
  }

  const levels = provisional.map((frame) => frame.rmsDb);
  const lowLevel = percentile(levels, .2);
  const highLevel = percentile(levels, .8);
  const energyThreshold = highLevel - lowLevel < 6
    ? Math.max(-60, lowLevel - 12)
    : clamp(Math.max(lowLevel + 8, highLevel - 26), -60, -24);

  return provisional.map((frame) => ({
    ...frame,
    pitchHz: frame.rmsDb >= energyThreshold && frame.periodicity >= .48 && frame.pitchHz && frame.pitchHz >= 70 && frame.pitchHz <= 400
      ? frame.pitchHz
      : null,
  }));
}

function parabolicPeak(samples: Float32Array, index: number) {
  if (index <= 0 || index >= samples.length - 1) return index;
  const left = Math.abs(Number.isFinite(samples[index - 1]) ? samples[index - 1] : 0);
  const center = Math.abs(Number.isFinite(samples[index]) ? samples[index] : 0);
  const right = Math.abs(Number.isFinite(samples[index + 1]) ? samples[index + 1] : 0);
  const denominator = left - 2 * center + right;
  return index + (Math.abs(denominator) > 1e-12 ? clamp(.5 * (left - right) / denominator, -.5, .5) : 0);
}

function cycleMeasurements(samples: Float32Array, sampleRate: number, frames: PitchFrame[], hopSeconds: number) {
  const periods: number[] = [];
  const amplitudes: number[] = [];
  const relativePeriodDifferences: number[] = [];
  const relativeAmplitudeDifferences: number[] = [];
  let runStart = 0;

  while (runStart < frames.length) {
    while (runStart < frames.length && frames[runStart].pitchHz === null) runStart += 1;
    if (runStart >= frames.length) break;
    let runEnd = runStart + 1;
    while (runEnd < frames.length && frames[runEnd].pitchHz !== null && frames[runEnd].time - frames[runEnd - 1].time <= hopSeconds * 1.6) runEnd += 1;
    if (runEnd - runStart < 3) {
      runStart = runEnd;
      continue;
    }

    const run = frames.slice(runStart, runEnd);
    const firstPitch = run[0].pitchHz as number;
    const firstPeriod = sampleRate / firstPitch;
    const firstStart = clamp(Math.floor((run[0].time - hopSeconds / 2) * sampleRate), 0, samples.length - 1);
    // The first energy-qualified frame can straddle a silence-to-voice onset.
    // Search far enough beyond its nominal boundary to land on a real cycle.
    const firstEnd = clamp(Math.ceil(firstStart + Math.max(firstPeriod * 2, sampleRate * .035)), firstStart + 1, samples.length);
    let initialIndex = firstStart;
    let initialPeak = 0;
    for (let index = firstStart; index < firstEnd; index += 1) {
      const peak = Math.abs(Number.isFinite(samples[index]) ? samples[index] : 0);
      if (peak > initialPeak) {
        initialPeak = peak;
        initialIndex = index;
      }
    }
    if (initialPeak < 1e-7) {
      runStart = runEnd;
      continue;
    }

    const marks: number[] = [parabolicPeak(samples, initialIndex)];
    const runLimit = Math.min(samples.length - 1, Math.ceil((run.at(-1)!.time + hopSeconds) * sampleRate));
    let nearestFrameIndex = 0;
    while (marks.at(-1)! < runLimit) {
      const previousMark = marks.at(-1)!;
      const previousTime = previousMark / sampleRate;
      while (nearestFrameIndex + 1 < run.length && Math.abs(run[nearestFrameIndex + 1].time - previousTime) <= Math.abs(run[nearestFrameIndex].time - previousTime)) nearestFrameIndex += 1;
      const nearest = run[nearestFrameIndex];
      const expectedPeriod = sampleRate / (nearest.pitchHz as number);
      const expected = previousMark + expectedPeriod;
      if (expected >= runLimit) break;
      const searchStart = clamp(Math.floor(expected - expectedPeriod * .2), Math.ceil(previousMark + expectedPeriod * .55), runLimit);
      const searchEnd = clamp(Math.ceil(expected + expectedPeriod * .2), searchStart + 1, runLimit + 1);
      let peakIndex = searchStart;
      let peakValue = 0;
      for (let index = searchStart; index < searchEnd; index += 1) {
        const peak = Math.abs(Number.isFinite(samples[index]) ? samples[index] : 0);
        if (peak > peakValue) {
          peakValue = peak;
          peakIndex = index;
        }
      }
      if (peakValue < 1e-7) break;
      marks.push(parabolicPeak(samples, peakIndex));
    }

    const runPeriods: number[] = [];
    const runAmplitudes: number[] = [];
    for (let index = 1; index < marks.length; index += 1) {
      const period = (marks[index] - marks[index - 1]) / sampleRate;
      const cycleStart = clamp(Math.round(marks[index - 1]), 0, samples.length - 1);
      const cycleEnd = clamp(Math.round(marks[index]), cycleStart + 1, samples.length);
      let minimum = Infinity;
      let maximum = -Infinity;
      let clipped = false;
      for (let sampleIndex = cycleStart; sampleIndex < cycleEnd; sampleIndex += 1) {
        const sample = Number.isFinite(samples[sampleIndex]) ? samples[sampleIndex] : 0;
        minimum = Math.min(minimum, sample);
        maximum = Math.max(maximum, sample);
        if (Math.abs(sample) >= .995) clipped = true;
      }
      if (period > 0 && !clipped && Number.isFinite(maximum - minimum) && maximum - minimum > 1e-7) {
        runPeriods.push(period);
        runAmplitudes.push(maximum - minimum);
      }
    }
    if (runPeriods.length >= 5) {
      const middlePeriod = median(runPeriods) as number;
      const acceptedIndices: number[] = [];
      for (let index = 0; index < runPeriods.length; index += 1) {
        if (Math.abs(runPeriods[index] - middlePeriod) / middlePeriod > .2) continue;
        acceptedIndices.push(index);
        periods.push(runPeriods[index]);
        amplitudes.push(runAmplitudes[index]);
      }
      const runAveragePeriod = mean(acceptedIndices.map((index) => runPeriods[index]));
      const runAverageAmplitude = mean(acceptedIndices.map((index) => runAmplitudes[index]));
      for (let index = 1; index < acceptedIndices.length; index += 1) {
        const previous = acceptedIndices[index - 1];
        const current = acceptedIndices[index];
        if (current !== previous + 1) continue;
        if (runAveragePeriod) relativePeriodDifferences.push(Math.abs(runPeriods[current] - runPeriods[previous]) / runAveragePeriod);
        if (runAverageAmplitude) relativeAmplitudeDifferences.push(Math.abs(runAmplitudes[current] - runAmplitudes[previous]) / runAverageAmplitude);
      }
    }
    runStart = runEnd;
  }
  return { periods, amplitudes, relativePeriodDifferences, relativeAmplitudeDifferences };
}

function voiceQualityFromFrames(frames: PitchFrame[], cycleSamples: Float32Array, cycleSampleRate: number, hopSeconds: number): VoiceQuality {
  const voiced = frames.filter((frame) => frame.pitchHz !== null);
  const pitches = voiced.map((frame) => frame.pitchHz as number);
  const cycles = cycleMeasurements(cycleSamples, cycleSampleRate, frames, hopSeconds);
  const { periods, relativePeriodDifferences, relativeAmplitudeDifferences } = cycles;
  const hnrValues = voiced
    .map((frame) => 10 * Math.log10(clamp(frame.periodicity, 1e-4, .9999) / Math.max(1e-4, 1 - frame.periodicity)))
    .filter(Number.isFinite);
  const enoughVoicing = voiced.length >= 3;
  let minimumPitch = Infinity;
  let maximumPitch = -Infinity;
  for (const pitch of pitches) {
    minimumPitch = Math.min(minimumPitch, pitch);
    maximumPitch = Math.max(maximumPitch, pitch);
  }

  return {
    voicedFrames: voiced.length,
    totalFrames: frames.length,
    validCycleCount: periods.length,
    voicedRatio: frames.length ? voiced.length / frames.length : 0,
    meanF0Hz: enoughVoicing ? mean(pitches) : null,
    medianF0Hz: enoughVoicing ? median(pitches) : null,
    f0StdHz: enoughVoicing ? standardDeviation(pitches) : null,
    minF0Hz: enoughVoicing ? minimumPitch : null,
    maxF0Hz: enoughVoicing ? maximumPitch : null,
    jitterLocalPercent: relativePeriodDifferences.length >= 4 ? 100 * (mean(relativePeriodDifferences) as number) : null,
    shimmerLocalPercent: relativeAmplitudeDifferences.length >= 4 ? 100 * (mean(relativeAmplitudeDifferences) as number) : null,
    hnrDb: hnrValues.length >= 3 ? median(hnrValues) : null,
  };
}

function levinsonDurbin(autocorrelation: Float64Array, order: number) {
  const coefficients = new Float64Array(order + 1);
  coefficients[0] = 1;
  let error = autocorrelation[0];
  if (!Number.isFinite(error) || error < 1e-10) return null;

  for (let index = 1; index <= order; index += 1) {
    let residual = autocorrelation[index];
    for (let previous = 1; previous < index; previous += 1) residual += coefficients[previous] * autocorrelation[index - previous];
    const reflection = clamp(-residual / Math.max(error, 1e-12), -.999, .999);
    const next = coefficients.slice();
    next[index] = reflection;
    for (let previous = 1; previous < index; previous += 1) next[previous] = coefficients[previous] + reflection * coefficients[index - previous];
    coefficients.set(next);
    error *= 1 - reflection ** 2;
    if (error < 1e-12) return null;
  }
  return coefficients;
}

function estimateFormants(samples: Float32Array, sampleRate: number, pitchFrames: PitchFrame[], frameLength: number) {
  const voicedFrames = pitchFrames.filter((frame) => frame.pitchHz !== null);
  const stride = Math.max(1, Math.ceil(voicedFrames.length / 180));
  const order = clamp(Math.round(sampleRate / 1000) + 2, 12, 20);
  const maximumFrequency = Math.min(5000, sampleRate / 2 - 100);
  const resolutionHz = 20;
  const formantFrames: FormantFrame[] = [];

  for (let sourceIndex = 0; sourceIndex < voicedFrames.length; sourceIndex += stride) {
    const pitchFrame = voicedFrames[sourceIndex];
    const center = Math.round(pitchFrame.time * sampleRate);
    const start = center - Math.floor(frameLength / 2);
    const frame = new Float64Array(frameLength);
    let previous = 0;
    for (let index = 0; index < frameLength; index += 1) {
      const sourceValue = start + index >= 0 && start + index < samples.length ? samples[start + index] : 0;
      const source = Number.isFinite(sourceValue) ? sourceValue : 0;
      const emphasized = source - .97 * previous;
      previous = source;
      const window = .54 - .46 * Math.cos(2 * Math.PI * index / Math.max(1, frameLength - 1));
      frame[index] = emphasized * window;
    }

    const autocorrelation = new Float64Array(order + 1);
    for (let lag = 0; lag <= order; lag += 1) {
      for (let index = 0; index < frame.length - lag; index += 1) autocorrelation[lag] += frame[index] * frame[index + lag];
    }
    const coefficients = levinsonDurbin(autocorrelation, order);
    if (!coefficients) {
      formantFrames.push({ time: pitchFrame.time, f1Hz: null, f2Hz: null, f3Hz: null });
      continue;
    }

    const envelope: { frequency: number; db: number }[] = [];
    for (let frequency = 100; frequency <= maximumFrequency; frequency += resolutionHz) {
      const phase = 2 * Math.PI * frequency / sampleRate;
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < coefficients.length; index += 1) {
        real += coefficients[index] * Math.cos(phase * index);
        imaginary -= coefficients[index] * Math.sin(phase * index);
      }
      envelope.push({ frequency, db: -10 * Math.log10(Math.max(real ** 2 + imaginary ** 2, 1e-12)) });
    }

    const peaks: { frequency: number; db: number }[] = [];
    for (let index = 2; index < envelope.length - 2; index += 1) {
      const value = envelope[index];
      if (value.db <= envelope[index - 1].db || value.db < envelope[index + 1].db) continue;
      const localFloor = Math.max(Math.min(envelope[index - 2].db, envelope[index - 1].db), Math.min(envelope[index + 1].db, envelope[index + 2].db));
      if (value.db - localFloor >= .15) peaks.push(value);
    }

    const f1 = peaks.find((peak) => peak.frequency >= 180 && peak.frequency <= 1300)?.frequency ?? null;
    const f2 = peaks.find((peak) => peak.frequency >= Math.max(650, (f1 ?? 400) + 220) && peak.frequency <= 3500)?.frequency ?? null;
    const f3 = peaks.find((peak) => peak.frequency >= Math.max(1700, (f2 ?? 1400) + 220) && peak.frequency <= maximumFrequency)?.frequency ?? null;
    formantFrames.push({ time: pitchFrame.time, f1Hz: f1, f2Hz: f2, f3Hz: f3 });
  }

  const values = ([1, 2, 3] as const).map((formant) => formantFrames
    .map((frame) => frame[`f${formant}Hz`])
    .filter((value): value is number => value !== null));
  return {
    frames: formantFrames,
    medians: values.map((items) => items.length >= 2 ? median(items) : null) as [number | null, number | null, number | null],
    validFrames: formantFrames.filter((frame) => frame.f1Hz !== null && frame.f2Hz !== null).length,
  };
}

const hzToMel = (frequency: number) => 2595 * Math.log10(1 + frequency / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function addDeltas(frames: Omit<MfccFrame, 'delta' | 'deltaDelta'>[]) {
  const calculate = (matrix: number[][]) => matrix.map((_, frameIndex) => matrix[frameIndex].map((__, coefficientIndex) => {
    let numerator = 0;
    for (let offset = 1; offset <= 2; offset += 1) {
      const future = matrix[Math.min(matrix.length - 1, frameIndex + offset)][coefficientIndex];
      const past = matrix[Math.max(0, frameIndex - offset)][coefficientIndex];
      numerator += offset * (future - past);
    }
    return numerator / 10;
  }));
  if (!frames.length) return [];
  const staticCoefficients = frames.map((frame) => frame.coefficients);
  const delta = calculate(staticCoefficients);
  const deltaDelta = calculate(delta);
  return frames.map((frame, index): MfccFrame => ({ ...frame, delta: delta[index], deltaDelta: deltaDelta[index] }));
}

function extractMfcc(samples: Float32Array, sampleRate: number, frameLength: number, hopLength: number) {
  if (samples.length < Math.ceil(frameLength / 2)) return [];
  const fftSize = Math.max(512, nextPowerOfTwo(frameLength));
  const filterCount = 26;
  const coefficientCount = 13;
  const totalFrames = Math.max(1, Math.floor((samples.length - Math.ceil(frameLength / 2)) / hopLength) + 1);
  const minimumMel = hzToMel(20);
  const maximumMel = hzToMel(Math.min(7600, sampleRate / 2 - 50));
  const melPoints = Array.from({ length: filterCount + 2 }, (_, index) => minimumMel + index / (filterCount + 1) * (maximumMel - minimumMel));
  const bins = melPoints.map((mel) => clamp(Math.floor((fftSize + 1) * melToHz(mel) / sampleRate), 0, fftSize / 2));
  const frames: Omit<MfccFrame, 'delta' | 'deltaDelta'>[] = [];

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const start = frameIndex * hopLength;
    const frame = new Float64Array(frameLength);
    const previousValue = start > 0 ? samples[start - 1] : 0;
    let previous = Number.isFinite(previousValue) ? previousValue : 0;
    for (let index = 0; index < frameLength; index += 1) {
      const sampleValue = start + index < samples.length ? samples[start + index] : 0;
      const sample = Number.isFinite(sampleValue) ? sampleValue : 0;
      const emphasized = sample - .97 * previous;
      previous = sample;
      frame[index] = emphasized * (.54 - .46 * Math.cos(2 * Math.PI * index / Math.max(1, frameLength - 1)));
    }
    const power = fftPowerSpectrum(frame, fftSize);
    const logEnergies = new Array<number>(filterCount);
    for (let filter = 0; filter < filterCount; filter += 1) {
      let energy = 0;
      const left = bins[filter];
      const center = Math.max(left + 1, bins[filter + 1]);
      const right = Math.max(center + 1, bins[filter + 2]);
      for (let bin = left; bin < Math.min(center, power.length); bin += 1) energy += power[bin] * (bin - left) / Math.max(1, center - left);
      for (let bin = center; bin <= Math.min(right, power.length - 1); bin += 1) energy += power[bin] * (right - bin) / Math.max(1, right - center);
      logEnergies[filter] = Math.log(Math.max(energy, 1e-12));
    }
    const coefficients = Array.from({ length: coefficientCount }, (_, coefficient) => {
      let total = 0;
      for (let filter = 0; filter < filterCount; filter += 1) total += logEnergies[filter] * Math.cos(Math.PI * coefficient * (filter + .5) / filterCount);
      return total * (coefficient === 0 ? Math.sqrt(1 / filterCount) : Math.sqrt(2 / filterCount));
    });
    frames.push({ time: (start + frameLength / 2) / sampleRate, coefficients });
  }
  const withDeltas = addDeltas(frames);
  const storageStride = Math.max(1, Math.ceil(withDeltas.length / 600));
  return withDeltas.filter((_, index) => index % storageStride === 0 || index === withDeltas.length - 1);
}

export function analyzeAdvancedSpeech(samples: Float32Array, sampleRate: number, cycleSamples = samples, cycleSampleRate = sampleRate): AdvancedAnalysisResult {
  const frameLength = Math.max(128, Math.round(sampleRate * .04));
  const hopLength = Math.max(64, Math.round(sampleRate * .01));
  const pitchInput = sampleRate > 9000 ? butterworthFilter(samples, sampleRate, 3600, 'lowpass') : samples;
  const pitchFrames = extractPitchFrames(pitchInput, sampleRate, frameLength, hopLength);
  const formants = estimateFormants(samples, sampleRate, pitchFrames, Math.round(sampleRate * .025));
  const mfccFrames = extractMfcc(samples, sampleRate, Math.round(sampleRate * .025), hopLength);
  return {
    sampleRate,
    durationSec: samples.length / sampleRate,
    frameLengthMs: 40,
    hopLengthMs: 10,
    pitchFrames,
    voiceQuality: voiceQualityFromFrames(pitchFrames, cycleSamples, cycleSampleRate, hopLength / sampleRate),
    formantFrames: formants.frames,
    formantMediansHz: formants.medians,
    validFormantFrames: formants.validFrames,
    mfccFrames,
    mfccCoefficientCount: 13,
  };
}

type BiquadCoefficients = { b0: number; b1: number; b2: number; a1: number; a2: number };

function butterworthCoefficients(sampleRate: number, cutoffHz: number, type: FilterType, qualityFactor: number): BiquadCoefficients {
  const cutoff = clamp(cutoffHz, 10, sampleRate * .49);
  const omega = 2 * Math.PI * cutoff / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = sine / (2 * qualityFactor);
  const a0 = 1 + alpha;
  const b0 = type === 'lowpass' ? (1 - cosine) / 2 : (1 + cosine) / 2;
  const b1 = type === 'lowpass' ? 1 - cosine : -(1 + cosine);
  const b2 = b0;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 };
}

function applyBiquad(samples: Float32Array, coefficients: BiquadCoefficients) {
  const output = new Float32Array(samples.length);
  let delay1 = 0;
  let delay2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const input = Number.isFinite(samples[index]) ? samples[index] : 0;
    const value = coefficients.b0 * input + delay1;
    delay1 = coefficients.b1 * input - coefficients.a1 * value + delay2;
    delay2 = coefficients.b2 * input - coefficients.a2 * value;
    output[index] = Number.isFinite(value) ? value : 0;
  }
  return output;
}

export function butterworthFilter(samples: Float32Array, sampleRate: number, cutoffHz: number, type: FilterType) {
  // The two Q values are the conjugate pole pairs of a fourth-order
  // Butterworth response. Cascading them keeps the cutoff at -3 dB.
  const firstSection = butterworthCoefficients(sampleRate, cutoffHz, type, .5411961);
  const secondSection = butterworthCoefficients(sampleRate, cutoffHz, type, 1.306563);
  return applyBiquad(applyBiquad(samples, firstSection), secondSection);
}

export function speechBandFilter(samples: Float32Array, sampleRate: number, lowHz = 80, highHz = 8000) {
  const safeLow = clamp(lowHz, 10, sampleRate * .45);
  const safeHigh = clamp(highHz, safeLow + 10, sampleRate * .49);
  return butterworthFilter(butterworthFilter(samples, sampleRate, safeLow, 'highpass'), sampleRate, safeHigh, 'lowpass');
}

export function noiseGate(samples: Float32Array, sampleRate: number, thresholdDb = -45, attackMs = 5, releaseMs = 120) {
  const output = new Float32Array(samples.length);
  const attack = Math.exp(-1 / Math.max(1, sampleRate * attackMs / 1000));
  const release = Math.exp(-1 / Math.max(1, sampleRate * releaseMs / 1000));
  let envelope = 0;
  let gain = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const input = Number.isFinite(samples[index]) ? samples[index] : 0;
    const level = Math.abs(input);
    envelope = level > envelope ? attack * envelope + (1 - attack) * level : release * envelope + (1 - release) * level;
    const levelDb = 20 * Math.log10(Math.max(envelope, 1e-8));
    const target = clamp((levelDb - (thresholdDb - 6)) / 12, 0, 1);
    const smoothing = target > gain ? attack : release;
    gain = smoothing * gain + (1 - smoothing) * target;
    output[index] = input * gain;
  }
  return output;
}
