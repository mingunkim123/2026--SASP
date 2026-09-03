'use client';

import { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject, useEffect, useRef, useState } from 'react';
import type { FrameFeature, Segment } from './dsp';
import type { FormantFrame, MfccFrame, PitchFrame } from './advanced-dsp';

const SEGMENT_COLORS = ['rgba(118, 124, 132, .12)', 'rgba(235, 180, 86, .18)', 'rgba(79, 141, 170, .17)'];
const MIN_VIEW_SPAN = 0.005;

export type PlotView = { start: number; end: number };
type InteractivePlotProps = { view?: PlotView; onViewChange?: (view: PlotView) => void };
type PlotSelection = { left: number; width: number };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fitView(start: number, span: number): PlotView {
  const fittedSpan = clamp(span, MIN_VIEW_SPAN, 1);
  const fittedStart = clamp(start, 0, 1 - fittedSpan);
  return { start: fittedStart, end: fittedStart + fittedSpan };
}

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

function usePlotNavigation(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  view: PlotView,
  onViewChange?: (view: PlotView) => void,
) {
  const viewRef = useRef(view);
  const onViewChangeRef = useRef(onViewChange);
  const dragRef = useRef<{ pointerId: number; x: number; view: PlotView } | null>(null);
  const [selection, setSelection] = useState<PlotSelection | null>(null);
  const navigationEnabled = Boolean(onViewChange);

  useEffect(() => {
    viewRef.current = view;
    onViewChangeRef.current = onViewChange;
  }, [view, onViewChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onViewChangeRef.current) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      const current = viewRef.current;
      const span = current.end - current.start;
      const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1);
      const nextSpan = clamp(span * Math.exp(delta * 0.0015), MIN_VIEW_SPAN, 1);
      const anchorTime = current.start + anchor * span;
      onViewChangeRef.current?.(fitView(anchorTime - anchor * nextSpan, nextSpan));
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasRef, navigationEnabled]);

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!onViewChange || event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, view: viewRef.current };
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1) * 100;
    setSelection({ left: anchor, width: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('selecting');
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const start = clamp((drag.x - rect.left) / rect.width, 0, 1);
    const end = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    setSelection({ left: Math.min(start, end) * 100, width: Math.abs(end - start) * 100 });
  }

  function finishSelection(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = clamp((drag.x - rect.left) / rect.width, 0, 1);
    const end = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    if (Math.abs(event.clientX - drag.x) >= 6 && onViewChange) {
      const left = Math.min(start, end);
      const selectedSpan = Math.abs(end - start);
      const viewSpan = drag.view.end - drag.view.start;
      onViewChange(fitView(drag.view.start + left * viewSpan, selectedSpan * viewSpan));
    }
    dragRef.current = null;
    setSelection(null);
    event.currentTarget.classList.remove('selecting');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function cancelSelection(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setSelection(null);
    event.currentTarget.classList.remove('selecting');
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    if (!onViewChange) return;
    const current = viewRef.current;
    const span = current.end - current.start;
    let next: PlotView | null = null;
    if (event.key === '+' || event.key === '=') next = fitView(current.start + span * .1, span * .8);
    if (event.key === '-' || event.key === '_') next = fitView(current.start - span * .125, span * 1.25);
    if (event.key === 'ArrowLeft') next = fitView(current.start - span * .1, span);
    if (event.key === 'ArrowRight') next = fitView(current.start + span * .1, span);
    if (event.key === '0' || event.key === 'Home') next = { start: 0, end: 1 };
    if (!next) return;
    event.preventDefault();
    onViewChange(next);
  }

  return {
    selection,
    navigation: onViewChange ? {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: finishSelection,
      onPointerCancel: cancelSelection,
      onDoubleClick: () => onViewChange({ start: 0, end: 1 }),
      onKeyDown: handleKeyDown,
      tabIndex: 0,
      title: 'Drag to select a zoom window, scroll to zoom, double-click to reset',
    } : {},
  };
}

function SelectionOverlay({ selection }: { selection: PlotSelection | null }) {
  return selection ? <span className="plot-selection" style={{ left: `${selection.left}%`, width: `${selection.width}%` }} aria-hidden="true" /> : null;
}

export function WaveformPlot({ samples, sampleRate, segments = [], compact = false, view = { start: 0, end: 1 }, onViewChange }: { samples: Float32Array; sampleRate: number; segments?: Segment[]; compact?: boolean } & InteractivePlotProps) {
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
      const visibleStart = view.start * duration;
      const visibleDuration = (view.end - view.start) * duration;
      for (const segment of segments) {
        const clippedStart = Math.max(segment.start, visibleStart);
        const clippedEnd = Math.min(segment.end, visibleStart + visibleDuration);
        if (clippedEnd <= clippedStart) continue;
        context.fillStyle = SEGMENT_COLORS[segment.classId];
        context.fillRect((clippedStart - visibleStart) / visibleDuration * width, 0, Math.max(1, (clippedEnd - clippedStart) / visibleDuration * width), height);
      }
    }

    context.strokeStyle = compact ? '#fb897a' : '#173f51';
    context.lineWidth = compact ? 1 : 1.15;
    context.beginPath();
    const columns = Math.max(1, Math.floor(width));
    const visibleSampleStart = Math.floor(view.start * samples.length);
    const visibleSampleEnd = Math.max(visibleSampleStart + 1, Math.ceil(view.end * samples.length));
    const visibleSampleCount = visibleSampleEnd - visibleSampleStart;
    for (let x = 0; x < columns; x += 1) {
      let min = 1;
      let max = -1;
      const start = Math.min(samples.length - 1, visibleSampleStart + Math.floor(x / columns * visibleSampleCount));
      const end = Math.min(samples.length, Math.max(start + 1, visibleSampleStart + Math.floor((x + 1) / columns * visibleSampleCount)));
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
  }, [samples, sampleRate, segments, compact, view.start, view.end]);

  const { navigation, selection } = usePlotNavigation(canvasRef, view, compact ? undefined : onViewChange);

  return <><canvas ref={canvasRef} className={compact ? 'mini-wave-canvas' : 'plot-canvas interactive-plot'} aria-label={`Waveform, ${samples.length} samples at ${sampleRate} hertz`} {...navigation} /><SelectionOverlay selection={selection} /></>;
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

export function SpectrogramPlot({ samples, sampleRate, view = { start: 0, end: 1 }, onViewChange }: { samples: Float32Array; sampleRate: number } & InteractivePlotProps) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#0d2632';
    context.fillRect(0, 0, width, height);
    const fftSize = 512;
    const columns = Math.max(32, Math.floor(width));
    const frame = new Float32Array(fftSize);
    const visibleSampleStart = Math.floor(view.start * Math.max(0, samples.length - 1));
    const visibleSampleEnd = Math.ceil(view.end * Math.max(0, samples.length - 1));
    for (let x = 0; x < columns; x += 1) {
      const center = Math.floor(visibleSampleStart + x / Math.max(1, columns - 1) * Math.max(0, visibleSampleEnd - visibleSampleStart));
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
  }, [samples, sampleRate, view.start, view.end]);
  const { navigation, selection } = usePlotNavigation(canvasRef, view, onViewChange);
  return <><canvas ref={canvasRef} className="plot-canvas spectrogram-canvas interactive-plot" aria-label={`Spectrogram up to ${sampleRate / 2} hertz`} {...navigation} /><SelectionOverlay selection={selection} /></>;
}

export function FeaturePlot({ frames, view = { start: 0, end: 1 }, onViewChange }: { frames: FrameFeature[] } & InteractivePlotProps) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#fbfbfa';
    context.fillRect(0, 0, width, height);
    if (!frames.length) return;
    context.strokeStyle = '#eceef0';
    for (let row = 1; row < 4; row += 1) {
      context.beginPath();
      context.moveTo(0, row * height / 4);
      context.lineTo(width, row * height / 4);
      context.stroke();
    }
    const series: { color: string; value: (frame: FrameFeature) => number }[] = [
      { color: '#ef6f5e', value: (frame) => (frame.rmsDb + 80) / 80 },
      { color: '#4e82a6', value: (frame) => frame.periodicity },
      { color: '#c89245', value: (frame) => Math.min(1, frame.zcr * 8) },
    ];
    const finalIndex = Math.max(1, frames.length - 1);
    const firstVisibleIndex = Math.max(0, Math.floor(view.start * finalIndex));
    const lastVisibleIndex = Math.min(frames.length - 1, Math.ceil(view.end * finalIndex));
    for (const item of series) {
      context.strokeStyle = item.color;
      context.lineWidth = 1.5;
      context.beginPath();
      for (let index = firstVisibleIndex; index <= lastVisibleIndex; index += 1) {
        const value = item.value(frames[index]);
        const x = (index / finalIndex - view.start) / (view.end - view.start) * width;
        const y = height - Math.max(0, Math.min(1, value)) * height;
        if (index === firstVisibleIndex) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
  }, [frames, view.start, view.end]);
  const { navigation, selection } = usePlotNavigation(canvasRef, view, onViewChange);
  return <><canvas ref={canvasRef} className="plot-canvas interactive-plot" aria-label="Frame-level energy, periodicity, and zero-crossing rate plot" {...navigation} /><SelectionOverlay selection={selection} /></>;
}

export function PitchContourPlot({ frames, duration, view = { start: 0, end: 1 }, onViewChange }: { frames: PitchFrame[]; duration: number } & InteractivePlotProps) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#fbfbfa';
    context.fillRect(0, 0, width, height);
    const minimumPitch = 70;
    const maximumPitch = 400;
    const visibleStart = duration * view.start;
    const visibleDuration = Math.max(1e-9, duration * (view.end - view.start));

    context.strokeStyle = '#e8eaeb';
    context.lineWidth = 1;
    for (const pitch of [100, 200, 300, 400]) {
      const y = height - (pitch - minimumPitch) / (maximumPitch - minimumPitch) * height;
      context.beginPath();
      context.moveTo(0, y + .5);
      context.lineTo(width, y + .5);
      context.stroke();
    }

    context.strokeStyle = '#ef6f5e';
    context.lineWidth = 2;
    context.lineJoin = 'round';
    context.beginPath();
    let drawing = false;
    let previousTime = -Infinity;
    for (const frame of frames) {
      if (frame.time < visibleStart || frame.time > visibleStart + visibleDuration || frame.pitchHz === null) {
        drawing = false;
        continue;
      }
      const x = (frame.time - visibleStart) / visibleDuration * width;
      const y = height - clamp((frame.pitchHz - minimumPitch) / (maximumPitch - minimumPitch), 0, 1) * height;
      if (!drawing || frame.time - previousTime > .025) context.moveTo(x, y); else context.lineTo(x, y);
      drawing = true;
      previousTime = frame.time;
    }
    context.stroke();

    context.fillStyle = '#767d82';
    context.font = '9px ui-monospace, monospace';
    context.fillText('400 Hz', 7, 12);
    context.fillText('70 Hz', 7, height - 7);
  }, [frames, duration, view.start, view.end]);
  const { navigation, selection } = usePlotNavigation(canvasRef, view, onViewChange);
  return <><canvas ref={canvasRef} className="plot-canvas interactive-plot" aria-label="Fundamental frequency contour from 70 to 400 hertz; gaps indicate unvoiced or unreliable frames" {...navigation} /><SelectionOverlay selection={selection} /></>;
}

export function FormantPlot({ frames, duration, view = { start: 0, end: 1 }, onViewChange }: { frames: FormantFrame[]; duration: number } & InteractivePlotProps) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#fbfbfa';
    context.fillRect(0, 0, width, height);
    const visibleStart = duration * view.start;
    const visibleDuration = Math.max(1e-9, duration * (view.end - view.start));

    context.strokeStyle = '#e8eaeb';
    for (let frequency = 1000; frequency < 5000; frequency += 1000) {
      const y = height - frequency / 5000 * height;
      context.beginPath();
      context.moveTo(0, y + .5);
      context.lineTo(width, y + .5);
      context.stroke();
    }

    const series: { key: 'f1Hz' | 'f2Hz' | 'f3Hz'; color: string }[] = [
      { key: 'f1Hz', color: '#ef6f5e' },
      { key: 'f2Hz', color: '#4e82a6' },
      { key: 'f3Hz', color: '#c89245' },
    ];
    const allowedGap = Math.max(.04, duration / Math.max(1, frames.length) * 2.5);
    for (const item of series) {
      context.strokeStyle = item.color;
      context.fillStyle = item.color;
      context.lineWidth = 1.35;
      context.beginPath();
      let drawing = false;
      let previousTime = -Infinity;
      for (const frame of frames) {
        const frequency = frame[item.key];
        if (frame.time < visibleStart || frame.time > visibleStart + visibleDuration || frequency === null) {
          drawing = false;
          continue;
        }
        const x = (frame.time - visibleStart) / visibleDuration * width;
        const y = height - clamp(frequency / 5000, 0, 1) * height;
        if (!drawing || frame.time - previousTime > allowedGap) context.moveTo(x, y); else context.lineTo(x, y);
        context.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        drawing = true;
        previousTime = frame.time;
      }
      context.stroke();
    }
    context.fillStyle = '#767d82';
    context.font = '9px ui-monospace, monospace';
    context.fillText('5 kHz', 7, 12);
    context.fillText('0 Hz', 7, height - 7);
  }, [frames, duration, view.start, view.end]);
  const { navigation, selection } = usePlotNavigation(canvasRef, view, onViewChange);
  return <><canvas ref={canvasRef} className="plot-canvas interactive-plot" aria-label="LPC formant tracks F1, F2, and F3 up to 5 kilohertz" {...navigation} /><SelectionOverlay selection={selection} /></>;
}

export type MfccMode = 'coefficients' | 'delta' | 'deltaDelta';

export function MfccPlot({ frames, duration, mode, view = { start: 0, end: 1 }, onViewChange }: { frames: MfccFrame[]; duration: number; mode: MfccMode } & InteractivePlotProps) {
  const canvasRef = useCanvas((canvas) => {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { context, width, height } = prepared;
    context.fillStyle = '#102d3b';
    context.fillRect(0, 0, width, height);
    if (!frames.length) return;
    const visibleStart = duration * view.start;
    const visibleEnd = duration * view.end;
    const visibleDuration = Math.max(1e-9, visibleEnd - visibleStart);
    const valuesFor = (frame: MfccFrame) => frame[mode];
    const coefficientCount = valuesFor(frames[0]).length;
    // Keep one color scale for the complete recording so zooming never changes
    // the meaning of an already-rendered MFCC color.
    const source = frames;
    const bounds = Array.from({ length: coefficientCount }, (_, coefficient) => {
      const sorted = source.map((frame) => valuesFor(frame)[coefficient]).filter(Number.isFinite).sort((a, b) => a - b);
      if (!sorted.length) return { middle: 0, span: 1 };
      const low = sorted[Math.floor((sorted.length - 1) * .05)];
      const high = sorted[Math.ceil((sorted.length - 1) * .95)];
      return { middle: (low + high) / 2, span: Math.max(1e-6, (high - low) / 2) };
    });

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      const nextTime = frames[Math.min(frames.length - 1, frameIndex + 1)].time;
      const previousTime = frames[Math.max(0, frameIndex - 1)].time;
      const halfStep = Math.max(.0025, (nextTime - previousTime) / 4);
      const frameStart = frame.time - halfStep;
      const frameEnd = frame.time + halfStep;
      if (frameEnd < visibleStart || frameStart > visibleEnd) continue;
      const x = (Math.max(frameStart, visibleStart) - visibleStart) / visibleDuration * width;
      const right = (Math.min(frameEnd, visibleEnd) - visibleStart) / visibleDuration * width;
      const values = valuesFor(frame);
      for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
        const normalized = clamp((values[coefficient] - bounds[coefficient].middle) / bounds[coefficient].span, -1, 1);
        const magnitude = Math.abs(normalized);
        context.fillStyle = normalized >= 0
          ? `hsl(7 76% ${94 - magnitude * 39}%)`
          : `hsl(201 48% ${94 - magnitude * 51}%)`;
        const rowHeight = height / coefficientCount;
        context.fillRect(x, coefficient * rowHeight, Math.max(1, right - x + .5), rowHeight + .5);
      }
    }
    context.fillStyle = 'rgba(255,255,255,.75)';
    context.font = '9px ui-monospace, monospace';
    context.fillText('C0', 7, 12);
    context.fillText(`C${coefficientCount - 1}`, 7, height - 7);
  }, [frames, duration, mode, view.start, view.end]);
  const { navigation, selection } = usePlotNavigation(canvasRef, view, onViewChange);
  const label = mode === 'coefficients' ? 'static MFCC' : mode === 'delta' ? 'MFCC delta' : 'MFCC delta-delta';
  return <><canvas ref={canvasRef} className="plot-canvas mfcc-canvas interactive-plot" aria-label={`${label} heatmap with 13 cepstral coefficients`} {...navigation} /><SelectionOverlay selection={selection} /></>;
}
