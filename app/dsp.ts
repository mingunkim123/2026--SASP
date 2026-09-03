export type SegmentClass = 0 | 1 | 2;

export type Segment = {
  id: string;
  start: number;
  end: number;
  classId: SegmentClass;
  confidence: number;
};

export type FrameFeature = {
  time: number;
  rmsDb: number;
  zcr: number;
  periodicity: number;
  pitchHz: number | null;
  classId: SegmentClass;
};

export type AnalysisResult = {
  segments: Segment[];
  frames: FrameFeature[];
  noiseFloorDb: number;
  speechThresholdDb: number;
  meanRmsDb: number;
  peakDbfs: number;
  estimatedPitchHz: number | null;
  spectralCentroidHz: number;
};

export const CLASS_META: Record<SegmentClass, { label: string; short: string }> = {
  0: { label: 'Background', short: 'BG' },
  1: { label: 'Unvoiced', short: 'UV' },
  2: { label: 'Voiced', short: 'V' },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const percentile = (values: number[], ratio: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * ratio)];
};

const median = (values: number[]) => percentile(values, 0.5);

export function mixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / buffer.numberOfChannels;
  }
  return mono;
}

function sinc(value: number) {
  if (Math.abs(value) < 1e-8) return 1;
  const phase = Math.PI * value;
  return Math.sin(phase) / phase;
}

function windowedSincResample(samples: Float32Array, sourceRate: number, targetRate: number) {
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const cutoff = Math.min(1, targetRate / sourceRate) * 0.94;
  const halfTaps = Math.min(256, Math.max(24, Math.ceil(12 / cutoff)));
  const sourcePerOutput = sourceRate / targetRate;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourcePosition = outputIndex * sourcePerOutput;
    const center = Math.floor(sourcePosition);
    const first = Math.max(0, center - halfTaps + 1);
    const last = Math.min(samples.length - 1, center + halfTaps);
    let sum = 0;
    let weightSum = 0;

    for (let sourceIndex = first; sourceIndex <= last; sourceIndex += 1) {
      const distance = sourcePosition - sourceIndex;
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / halfTaps);
      const weight = cutoff * sinc(cutoff * distance) * window;
      sum += samples[sourceIndex] * weight;
      weightSum += weight;
    }
    output[outputIndex] = weightSum ? sum / weightSum : 0;
  }
  return output;
}

export async function resampleAudio(samples: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return samples.slice();
  // Chromium rejects OfflineAudioContext sample rates below 3 kHz. The
  // assignment needs 2 kHz, so use an explicit anti-aliasing resampler there.
  if (sourceRate < 3000 || targetRate < 3000 || typeof OfflineAudioContext === 'undefined') {
    return windowedSincResample(samples, sourceRate, targetRate);
  }
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  try {
    const context = new OfflineAudioContext(1, outputLength, targetRate);
    const buffer = context.createBuffer(1, samples.length, sourceRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return rendered.getChannelData(0).slice();
  } catch {
    return windowedSincResample(samples, sourceRate, targetRate);
  }
}

export function normalize(samples: Float32Array) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak < 1e-8) return samples.slice();
  const gain = 0.98 / peak;
  return Float32Array.from(samples, (sample) => clamp(sample * gain, -1, 1));
}

export function removeDc(samples: Float32Array) {
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= Math.max(1, samples.length);
  return Float32Array.from(samples, (sample) => sample - mean);
}

export function preEmphasis(samples: Float32Array, coefficient = 0.97) {
  const output = new Float32Array(samples.length);
  if (!samples.length) return output;
  output[0] = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    output[index] = clamp(samples[index] - coefficient * samples[index - 1], -1, 1);
  }
  return output;
}

export function reverseAudio(samples: Float32Array) {
  return samples.slice().reverse();
}

function framePitch(frame: Float32Array, sampleRate: number) {
  const stride = Math.max(1, Math.floor(sampleRate / 8000));
  const rate = sampleRate / stride;
  const reducedLength = Math.floor(frame.length / stride);
  const reduced = new Float32Array(reducedLength);
  let mean = 0;
  for (let index = 0; index < reducedLength; index += 1) {
    reduced[index] = frame[index * stride];
    mean += reduced[index];
  }
  mean /= Math.max(1, reducedLength);
  for (let index = 0; index < reducedLength; index += 1) reduced[index] -= mean;

  const minLag = Math.max(2, Math.floor(rate / 400));
  const maxLag = Math.min(reducedLength - 3, Math.ceil(rate / 70));
  let bestLag = 0;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = 0; index < reducedLength - lag; index += 1) {
      const a = reduced[index];
      const b = reduced[index + lag];
      numerator += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const correlation = numerator / Math.sqrt(energyA * energyB + 1e-12);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  return {
    periodicity: clamp(bestCorrelation, 0, 1),
    pitchHz: bestLag ? rate / bestLag : null,
  };
}

function smoothClasses(classes: SegmentClass[]) {
  let smoothed = classes.slice();
  for (let pass = 0; pass < 2; pass += 1) {
    smoothed = smoothed.map((value, index, source) => {
      const votes: Record<SegmentClass, number> = { 0: 0, 1: 0, 2: 0 };
      for (let offset = -2; offset <= 2; offset += 1) {
        const neighbor = source[clamp(index + offset, 0, source.length - 1)];
        votes[neighbor] += offset === 0 ? 2 : 1;
      }
      return ([0, 1, 2] as SegmentClass[]).reduce((winner, candidate) => votes[candidate] > votes[winner] ? candidate : winner, value);
    });
  }
  return smoothed;
}

function estimateSpectralCentroid(samples: Float32Array, sampleRate: number) {
  if (!samples.length) return 0;
  const size = 1024;
  const stride = Math.max(size, Math.floor(samples.length / 16));
  let weighted = 0;
  let total = 0;
  for (let start = 0; start + size <= samples.length; start += stride) {
    for (let bin = 1; bin < size / 2; bin += 4) {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < size; index += 1) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1));
        const phase = 2 * Math.PI * bin * index / size;
        const value = samples[start + index] * window;
        real += value * Math.cos(phase);
        imaginary -= value * Math.sin(phase);
      }
      const magnitude = Math.hypot(real, imaginary);
      const frequency = bin * sampleRate / size;
      weighted += frequency * magnitude;
      total += magnitude;
    }
  }
  return total > 0 ? weighted / total : 0;
}

export function analyzeSpeech(samples: Float32Array, sampleRate: number, energyMarginDb = 9, voicingThreshold = 0.42): AnalysisResult {
  const frameLength = Math.max(64, Math.round(sampleRate * 0.025));
  const hopLength = Math.max(32, Math.round(sampleRate * 0.01));
  const rawFrames: Omit<FrameFeature, 'classId'>[] = [];
  let totalSquare = 0;
  let peak = 0;

  for (let start = 0; start < samples.length; start += hopLength) {
    const actualLength = Math.min(frameLength, samples.length - start);
    if (actualLength < frameLength / 2) break;
    const frame = new Float32Array(frameLength);
    let square = 0;
    let crossings = 0;
    for (let index = 0; index < actualLength; index += 1) {
      const sample = samples[start + index];
      frame[index] = sample;
      square += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      if (index > 0 && (sample >= 0) !== (frame[index - 1] >= 0)) crossings += 1;
    }
    totalSquare += square;
    const rms = Math.sqrt(square / actualLength);
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-7));
    const zcr = crossings / Math.max(1, actualLength - 1);
    const pitch = rmsDb > -65 ? framePitch(frame, sampleRate) : { periodicity: 0, pitchHz: null };
    rawFrames.push({ time: start / sampleRate, rmsDb, zcr, periodicity: pitch.periodicity, pitchHz: pitch.pitchHz });
  }

  const levels = rawFrames.map((frame) => frame.rmsDb);
  const noiseFloorDb = percentile(levels, 0.2);
  const activeLevel = percentile(levels, 0.72);
  const speechThresholdDb = clamp(Math.max(noiseFloorDb + energyMarginDb, activeLevel - 22), -58, -24);
  const rawClasses = rawFrames.map((frame): SegmentClass => {
    if (frame.rmsDb < speechThresholdDb) return 0;
    if (frame.periodicity >= voicingThreshold && frame.zcr < 0.18 && frame.pitchHz && frame.pitchHz >= 70 && frame.pitchHz <= 400) return 2;
    return 1;
  });
  const classes = smoothClasses(rawClasses);
  const frames = rawFrames.map((frame, index) => ({ ...frame, classId: classes[index] }));
  const segments: Segment[] = [];

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const start = frame.time;
    const end = Math.min(samples.length / sampleRate, frame.time + hopLength / sampleRate);
    const previous = segments.at(-1);
    if (previous && previous.classId === frame.classId) {
      previous.end = end;
      previous.confidence += frame.classId === 2 ? frame.periodicity : frame.classId === 0 ? clamp((speechThresholdDb - frame.rmsDb) / 20, 0.3, 1) : clamp(1 - frame.periodicity, 0.3, 1);
    } else {
      segments.push({ id: `segment-${index}`, start, end, classId: frame.classId, confidence: frame.classId === 2 ? frame.periodicity : frame.classId === 0 ? clamp((speechThresholdDb - frame.rmsDb) / 20, 0.3, 1) : clamp(1 - frame.periodicity, 0.3, 1) });
    }
  }

  for (const segment of segments) {
    const count = Math.max(1, Math.round((segment.end - segment.start) * sampleRate / hopLength));
    segment.confidence = clamp(segment.confidence / count, 0, 1);
  }

  const voicedPitches = frames.filter((frame) => frame.classId === 2 && frame.pitchHz).map((frame) => frame.pitchHz as number);
  return {
    segments,
    frames,
    noiseFloorDb,
    speechThresholdDb,
    meanRmsDb: 10 * Math.log10(Math.max(totalSquare / Math.max(1, samples.length), 1e-14)),
    peakDbfs: 20 * Math.log10(Math.max(peak, 1e-7)),
    estimatedPitchHz: voicedPitches.length ? median(voicedPitches) : null,
    spectralCentroidHz: estimateSpectralCentroid(samples, sampleRate),
  };
}

export function encodeWav(samples: Float32Array, sampleRate: number) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index], -1, 1);
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export function formatTime(seconds: number, precision = 2) {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(precision).padStart(precision + 3, '0')}`;
}
