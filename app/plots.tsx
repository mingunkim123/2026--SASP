'use client';

import { useEffect, useRef } from 'react';
import type { FrameFeature, Segment } from './dsp';

const SEGMENT_COLORS = ['rgba(118, 124, 132, .12)', 'rgba(235, 180, 86, .18)', 'rgba(79, 141, 170, .17)'];

function prepareCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function useCanvas(draw: (canvas: HTMLCanvasElement) => void, dependencies: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const render = () => draw(canvas);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  return ref;
}

export function WaveformPlot({ samples, sampleRate, segments = [], compact = false }: { samples: Float32Array; sampleRate: number; segments?: Segment[]; compact?: boolean }) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.clearRect(0, 0, width, height);
    context.fillStyle = compact ? '#102d3b' : '#fbfbfa';
    context.fillRect(0, 0, width, height);

    if (!compact) {
      context.strokeStyle = '#eceef0';
      context.lineWidth = 1;
      for (let row = 1; row < 4; row += 1) {
        context.beginPath();
        context.moveTo(0, row * height / 4 + .5);
        context.lineTo(width, row * height / 4 + .5);
        context.stroke();
      }
      const duration = samples.length / sampleRate;
      for (const segment of segments) {
        context.fillStyle = SEGMENT_COLORS[segment.classId];
        context.fillRect(segment.start / duration * width, 0, Math.max(1, (segment.end - segment.start) / duration * width), height);
      }
    }

    context.strokeStyle = compact ? '#fb897a' : '#173f51';
    context.lineWidth = compact ? 1 : 1.15;
    context.beginPath();
    const columns = Math.max(1, Math.floor(width));
    const block = Math.max(1, Math.floor(samples.length / columns));
    for (let x = 0; x < columns; x += 1) {
      let min = 1;
      let max = -1;
      const start = x * block;
      const end = Math.min(samples.length, start + block);
      for (let index = start; index < end; index += 1) {
        min = Math.min(min, samples[index]);
        max = Math.max(max, samples[index]);
      }
      const y1 = (1 - max) * height / 2;
      const y2 = (1 - min) * height / 2;
      context.moveTo(x + .5, y1);
      context.lineTo(x + .5, Math.max(y1 + .6, y2));
    }
    context.stroke();

    if (!compact) {
      context.strokeStyle = '#aeb5ba';
      context.beginPath();
      context.moveTo(0, height / 2 + .5);
      context.lineTo(width, height / 2 + .5);
      context.stroke();
    }
  }, [samples, sampleRate, segments, compact]);

  return <canvas ref={canvasRef} className={compact ? 'mini-wave-canvas' : 'plot-canvas'} aria-label={`Waveform, ${samples.length} samples at ${sampleRate} hertz`} />;
}

function fftMagnitudes(source: Float32Array, fftSize: number) {
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  for (let index = 0; index < fftSize; index += 1) real[index] = source[index] || 0;

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
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let offset = 0; offset < fftSize; offset += length) {
      let wr = 1;
      let wi = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const even = offset + index;
        const odd = even + length / 2;
        const tr = wr * real[odd] - wi * imaginary[odd];
        const ti = wr * imaginary[odd] + wi * real[odd];
        real[odd] = real[even] - tr;
        imaginary[odd] = imaginary[even] - ti;
        real[even] += tr;
        imaginary[even] += ti;
        const nextWr = wr * cosine - wi * sine;
        wi = wr * sine + wi * cosine;
        wr = nextWr;
      }
    }
  }
  return Float32Array.from({ length: fftSize / 2 }, (_, index) => Math.hypot(real[index], imaginary[index]));
}

export function SpectrogramPlot({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#0d2632';
    context.fillRect(0, 0, width, height);
    const fftSize = 512;
    const columns = Math.max(32, Math.floor(width));
    const frame = new Float32Array(fftSize);
    for (let x = 0; x < columns; x += 1) {
      const center = Math.floor(x / Math.max(1, columns - 1) * Math.max(0, samples.length - 1));
      const start = center - fftSize / 2;
      for (let index = 0; index < fftSize; index += 1) {
        const sourceIndex = start + index;
        const window = .5 - .5 * Math.cos(2 * Math.PI * index / (fftSize - 1));
        frame[index] = (sourceIndex >= 0 && sourceIndex < samples.length ? samples[sourceIndex] : 0) * window;
      }
      const spectrum = fftMagnitudes(frame, fftSize);
      for (let bin = 0; bin < spectrum.length; bin += 1) {
        const db = 20 * Math.log10(Math.max(spectrum[bin] / fftSize, 1e-6));
        const intensity = Math.max(0, Math.min(1, (db + 80) / 65));
        const hue = 205 - intensity * 185;
        const lightness = 10 + intensity * 58;
        context.fillStyle = `hsl(${hue} 72% ${lightness}%)`;
        const y = height - (bin + 1) / spectrum.length * height;
        context.fillRect(x * width / columns, y, Math.ceil(width / columns) + .5, height / spectrum.length + 1);
      }
    }
    context.fillStyle = 'rgba(255,255,255,.65)';
    context.font = '9px ui-monospace, monospace';
    context.fillText(`${Math.round(sampleRate / 2000)} kHz`, 7, 12);
    context.fillText('0 Hz', 7, height - 7);
  }, [samples, sampleRate]);
  return <canvas ref={canvasRef} className="plot-canvas spectrogram-canvas" aria-label={`Spectrogram up to ${sampleRate / 2} hertz`} />;
}

export function FeaturePlot({ frames }: { frames: FrameFeature[] }) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#fbfbfa';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#eceef0';
    for (let row = 1; row < 4; row += 1) {
      context.beginPath();
      context.moveTo(0, row * height / 4);
      context.lineTo(width, row * height / 4);
      context.stroke();
    }
    const series = [
      { color: '#ef6f5e', values: frames.map((frame) => (frame.rmsDb + 80) / 80) },
      { color: '#4e82a6', values: frames.map((frame) => frame.periodicity) },
      { color: '#c89245', values: frames.map((frame) => Math.min(1, frame.zcr * 8)) },
    ];
    for (const item of series) {
      context.strokeStyle = item.color;
      context.lineWidth = 1.5;
      context.beginPath();
      item.values.forEach((value, index) => {
        const x = index / Math.max(1, item.values.length - 1) * width;
        const y = height - Math.max(0, Math.min(1, value)) * height;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
    }
  }, [frames]);
  return <canvas ref={canvasRef} className="plot-canvas" aria-label="Frame-level energy, periodicity, and zero-crossing rate plot" />;
}
