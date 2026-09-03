'use client';

import { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  AnalysisResult,
  CLASS_META,
  Segment,
  SegmentClass,
  analyzeSpeech,
  encodeWav,
  formatTime,
  mixToMono,
  normalize,
  preEmphasis,
  removeDc,
  resampleAudio,
  reverseAudio,
} from './dsp';
import {
  AdvancedAnalysisResult,
  analyzeAdvancedSpeech,
  butterworthFilter,
  noiseGate,
  speechBandFilter,
} from './advanced-dsp';
import { FeaturePlot, FormantPlot, MfccMode, MfccPlot, PitchContourPlot, PlotView, SpectrogramPlot, WaveformPlot } from './plots';

const TARGET_RATES = [48000, 16000, 8000, 2000] as const;
type TargetRate = (typeof TARGET_RATES)[number];
type PlotMode = 'waveform' | 'spectrogram' | 'features';
type AdvancedMode = 'voice' | 'formants' | 'mfcc';
type FilterMode = 'highpass' | 'lowpass' | 'bandpass';
type SectionId = 'workspace' | 'record' | 'analysis' | 'segments' | 'export';

type AudioAsset = {
  name: string;
  samples: Float32Array;
  sampleRate: number;
  sourceRate: number;
  sourceChannels: number;
};

type SegmentationThresholds = { energyMarginDb: number; voicingPeriodicity: number };
type ProcessingSnapshot = {
  asset: AudioAsset;
  segments: Segment[];
  segmentsEdited: boolean;
  processingSteps: string[];
  thresholds: SegmentationThresholds;
};

type BuildOptions = {
  generation?: number;
  preservedSegments?: Segment[];
  segmentsEdited?: boolean;
  thresholds?: SegmentationThresholds;
};

const ASSIGNMENT_TEXT = 'Speech has evolved as a primary form of communication between humans. The topic of this class, “discrete-time speech signal processing” can be defined as the manipulation of sampled speech signals by a digital processor to obtain a new signal with some desired properties.';
const MAX_DURATION_SECONDS = 120;

const RATE_NOTES: Record<TargetRate, { title: string; note: string }> = {
  48000: { title: 'Studio reference', note: 'Full reference bandwidth up to 24 kHz.' },
  16000: { title: 'Wideband speech', note: 'Natural speech quality; most consonant detail remains.' },
  8000: { title: 'Telephone band', note: '4 kHz ceiling makes fricatives and brightness softer.' },
  2000: { title: 'Severely limited', note: '1 kHz ceiling removes crucial intelligibility cues.' },
};

const NAV_ITEMS: { id: SectionId; icon: string; label: string }[] = [
  { id: 'workspace', icon: '⌁', label: 'Workspace' },
  { id: 'record', icon: '◉', label: 'Record' },
  { id: 'analysis', icon: '⌇', label: 'Analysis' },
  { id: 'segments', icon: '▤', label: 'Segments' },
  { id: 'export', icon: '⇩', label: 'Export' },
];

const prettyBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9가-힣_-]+/gi, '-');
const metric = (value: number | null, unit: string, digits = 1) => value === null ? 'Not reliable' : `${value.toFixed(digits)} ${unit}`;

function DownloadAction({ prepare, className, children, stopPropagation = false, disabled = false }: { prepare: () => { blob: Blob; filename: string } | null; className?: string; children: ReactNode; stopPropagation?: boolean; disabled?: boolean }) {
  function handleClick(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (stopPropagation) event.stopPropagation();
    if (disabled) {
      event.preventDefault();
      return;
    }
    const download = prepare();
    if (!download) {
      event.preventDefault();
      return;
    }
    const anchor = event.currentTarget;
    const previousUrl = anchor.dataset.objectUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const url = URL.createObjectURL(download.blob);
    anchor.href = url;
    anchor.download = download.filename;
    anchor.dataset.objectUrl = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  const classes = [className, disabled ? 'disabled' : ''].filter(Boolean).join(' ');
  return <a href="#export" className={classes || undefined} download aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} onClick={handleClick}>{children}</a>;
}

export default function Home() {
  const [asset, setAsset] = useState<AudioAsset | null>(null);
  const [versions, setVersions] = useState<Map<TargetRate, Float32Array>>(new Map());
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [advancedAnalysis, setAdvancedAnalysis] = useState<AdvancedAnalysisResult | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedRate, setSelectedRate] = useState<TargetRate>(48000);
  const [plotMode, setPlotMode] = useState<PlotMode>('waveform');
  const [advancedMode, setAdvancedMode] = useState<AdvancedMode>('voice');
  const [mfccMode, setMfccMode] = useState<MfccMode>('coefficients');
  const [plotView, setPlotView] = useState<PlotView>({ start: 0, end: 1 });
  const [energyMargin, setEnergyMargin] = useState(9);
  const [voicingThreshold, setVoicingThreshold] = useState(0.42);
  const [appliedThresholds, setAppliedThresholds] = useState<SegmentationThresholds>({ energyMarginDb: 9, voicingPeriodicity: .42 });
  const [segmentsEdited, setSegmentsEdited] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [liveLevel, setLiveLevel] = useState(0);
  const [playingRate, setPlayingRate] = useState<TargetRate | null>(null);
  const [status, setStatus] = useState('Ready for a 48 kHz mono recording');
  const [showHelp, setShowHelp] = useState(false);
  const [history, setHistory] = useState<ProcessingSnapshot[]>([]);
  const [activeSection, setActiveSection] = useState<SectionId>('workspace');
  const [microphoneSupported, setMicrophoneSupported] = useState<boolean | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('bandpass');
  const [lowCutoff, setLowCutoff] = useState('80');
  const [highCutoff, setHighCutoff] = useState('8000');
  const [gateThreshold, setGateThreshold] = useState(-45);
  const [processingSteps, setProcessingSteps] = useState<string[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const monitorContextRef = useRef<AudioContext | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveAnimationRef = useRef<number | null>(null);
  const playbackRef = useRef<{ context: AudioContext; source: AudioBufferSourceNode } | null>(null);
  const manualNavigationUntilRef = useRef(0);
  const processingGenerationRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeSamples = versions.get(selectedRate) ?? null;
  const duration = asset ? asset.samples.length / asset.sampleRate : 0;
  const controlsLocked = isBusy || isRecording;
  const segmentationSettingsPending = energyMargin !== appliedThresholds.energyMarginDb || voicingThreshold !== appliedThresholds.voicingPeriodicity;
  const classDurations = useMemo(() => {
    const totals: Record<SegmentClass, number> = { 0: 0, 1: 0, 2: 0 };
    for (const segment of segments) totals[segment.classId] += Math.max(0, segment.end - segment.start);
    return totals;
  }, [segments]);

  useEffect(() => () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    if (liveAnimationRef.current) cancelAnimationFrame(liveAnimationRef.current);
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* recorder already stopped */ }
      }
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    void monitorContextRef.current?.close();
    playbackRef.current?.source.stop();
    playbackRef.current?.context.close();
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMicrophoneSupported(Boolean(window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined'));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const updateActiveSection = () => {
      if (Date.now() < manualNavigationUntilRef.current) return;
      let current: SectionId = window.scrollY < 80 ? 'workspace' : 'record';
      for (const id of ['analysis', 'segments', 'export'] as SectionId[]) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= window.innerHeight * 0.32) current = id;
      }
      if (document.getElementById('export') && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 32) current = 'export';
      setActiveSection(current);
    };
    window.addEventListener('scroll', updateActiveSection, { passive: true });
    updateActiveSection();
    return () => window.removeEventListener('scroll', updateActiveSection);
  }, [asset]);

  async function buildAsset(nextAsset: AudioAsset, message = 'Analysis complete', options: BuildOptions = {}) {
    const generation = options.generation ?? ++processingGenerationRef.current;
    if (generation !== processingGenerationRef.current) return false;
    const thresholds = options.thresholds ?? { energyMarginDb: energyMargin, voicingPeriodicity: voicingThreshold };
    setIsBusy(true);
    setStatus('Resampling and extracting speech features…');
    try {
      const reference = await resampleAudio(nextAsset.samples, nextAsset.sampleRate, 48000);
      if (generation !== processingGenerationRef.current) return false;
      const [wideband, telephone] = await Promise.all([
        resampleAudio(reference, 48000, 16000),
        resampleAudio(reference, 48000, 8000),
      ]);
      if (generation !== processingGenerationRef.current) return false;
      const narrowband = await resampleAudio(telephone, 8000, 2000);
      if (generation !== processingGenerationRef.current) return false;
      const nextVersions = new Map<TargetRate, Float32Array>([
        [48000, reference],
        [16000, wideband],
        [8000, telephone],
        [2000, narrowband],
      ]);
      const nextAnalysis = analyzeSpeech(nextVersions.get(48000)!, 48000, thresholds.energyMarginDb, thresholds.voicingPeriodicity);
      setStatus('Extracting F0, voice quality, LPC formants, and MFCC…');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (generation !== processingGenerationRef.current) return false;
      const nextAdvancedAnalysis = analyzeAdvancedSpeech(wideband, 16000, reference, 48000);
      if (generation !== processingGenerationRef.current) return false;
      setAsset({ ...nextAsset, samples: nextVersions.get(48000)!, sampleRate: 48000 });
      setVersions(nextVersions);
      setAnalysis(nextAnalysis);
      setAdvancedAnalysis(nextAdvancedAnalysis);
      setSegments(options.preservedSegments?.map((segment) => ({ ...segment })) ?? nextAnalysis.segments);
      setSegmentsEdited(options.preservedSegments ? Boolean(options.segmentsEdited) : false);
      setAppliedThresholds(thresholds);
      setSelectedRate(48000);
      setPlotView({ start: 0, end: 1 });
      setStatus(message);
      return true;
    } catch (error) {
      if (generation === processingGenerationRef.current) {
        console.error(error);
        setStatus('Could not process this audio. Try WAV, MP3, M4A, OGG, or WebM.');
      }
      return false;
    } finally {
      if (generation === processingGenerationRef.current) setIsBusy(false);
    }
  }

  async function decodeBlob(blob: Blob, name: string, trimRecordingToLimit = false) {
    const generation = ++processingGenerationRef.current;
    stopPlayback();
    setIsBusy(true);
    setStatus('Decoding audio…');
    let context: AudioContext | null = null;
    try {
      context = new AudioContext({ sampleRate: 48000 });
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (generation !== processingGenerationRef.current) return;
      if (decoded.duration > MAX_DURATION_SECONDS && !trimRecordingToLimit) {
        setStatus(`Please use audio up to ${MAX_DURATION_SECONDS / 60} minutes so frame analysis stays responsive.`);
        setIsBusy(false);
        return;
      }
      const sourceRate = decoded.sampleRate;
      const sourceChannels = decoded.numberOfChannels;
      const decodedMono = mixToMono(decoded);
      const maximumSourceSamples = Math.floor(sourceRate * MAX_DURATION_SECONDS);
      const mono = trimRecordingToLimit && decodedMono.length > maximumSourceSamples
        ? decodedMono.slice(0, maximumSourceSamples)
        : decodedMono;
      const at48k = await resampleAudio(mono, sourceRate, 48000);
      if (generation !== processingGenerationRef.current) return;
      const message = trimRecordingToLimit && decoded.duration > MAX_DURATION_SECONDS
        ? `Recording capped at ${MAX_DURATION_SECONDS / 60} minutes, standardized, and segmented`
        : 'Loaded, standardized to 48 kHz mono, and segmented';
      const committed = await buildAsset({ name, samples: at48k, sampleRate: 48000, sourceRate, sourceChannels }, message, { generation });
      if (committed) {
        setHistory([]);
        setProcessingSteps([]);
      }
    } catch (error) {
      if (generation === processingGenerationRef.current) {
        console.error(error);
        setStatus('Audio decoding failed. Try a different file format.');
        setIsBusy(false);
      }
    } finally {
      await context?.close();
    }
  }

  function handleFile(file?: File) {
    if (!file) return;
    if (isRecording) {
      setStatus('Stop the current recording before loading another file.');
      return;
    }
    if (isBusy) {
      setStatus('Please wait for the current analysis to finish before loading another file.');
      return;
    }
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|ogg|webm|flac)$/i.test(file.name)) {
      setStatus('Please choose an audio file.');
      return;
    }
    void decodeBlob(file, file.name);
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    handleFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    handleFile(event.dataTransfer.files?.[0]);
  }

  function cancelRecording() {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    if (liveAnimationRef.current) cancelAnimationFrame(liveAnimationRef.current);
    liveAnimationRef.current = null;

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* recorder already stopped */ }
      }
    }
    const stream = recordingStreamRef.current ?? recorder?.stream ?? null;
    recordingStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    const monitor = monitorContextRef.current;
    monitorContextRef.current = null;
    if (monitor) void monitor.close().catch(() => undefined);
    setIsRecording(false);
    setRecordingSeconds(0);
    setLiveLevel(0);
  }

  async function startRecording() {
    if (isBusy || isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('Microphone recording is not supported in this browser.');
      return;
    }
    stopPlayback();
    setIsBusy(true);
    setStatus('Requesting microphone access…');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, sampleSize: 16, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const activeStream = stream;
      recordingStreamRef.current = activeStream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      const monitor = new AudioContext({ sampleRate: 48000 });
      monitorContextRef.current = monitor;
      const source = monitor.createMediaStreamSource(activeStream);
      const analyser = monitor.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);

      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        activeStream.getTracks().forEach((track) => track.stop());
        if (recordingStreamRef.current === activeStream) recordingStreamRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        if (liveAnimationRef.current) cancelAnimationFrame(liveAnimationRef.current);
        liveAnimationRef.current = null;
        if (monitorContextRef.current === monitor) monitorContextRef.current = null;
        void monitor.close().catch(() => undefined);
        setIsRecording(false);
        setLiveLevel(0);
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size) {
          void decodeBlob(blob, `speech-recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`, true);
        } else {
          setIsBusy(false);
          setStatus('No audio was captured. Please try recording again.');
        }
      };
      recorder.start(250);
      setIsBusy(false);
      setIsRecording(true);
      setRecordingSeconds(0);
      setStatus('Recording in mono — read the passage at a natural pace');
      const startedAt = performance.now();
      recordingTimerRef.current = setInterval(() => {
        const elapsed = (performance.now() - startedAt) / 1000;
        setRecordingSeconds(Math.min(elapsed, MAX_DURATION_SECONDS));
        if (elapsed >= MAX_DURATION_SECONDS) stopRecording(`Reached the ${MAX_DURATION_SECONDS / 60}-minute limit — finalizing the recording…`);
      }, 100);

      const tick = () => {
        if (recorder.state !== 'recording') return;
        analyser.getFloatTimeDomainData(buffer);
        let square = 0;
        for (const value of buffer) square += value * value;
        setLiveLevel(Math.min(1, Math.sqrt(square / buffer.length) * 7));
        liveAnimationRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      cancelRecording();
      console.error(error);
      setIsBusy(false);
      setStatus('Microphone access was unavailable. Check browser permission or upload a file.');
    }
  }

  function stopRecording(message = 'Finalizing the recording…') {
    if (recorderRef.current?.state === 'recording') {
      setIsBusy(true);
      recorderRef.current.stop();
    }
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    setIsRecording(false);
    setStatus(message);
  }

  function stopPlayback() {
    try { playbackRef.current?.source.stop(); } catch { /* already stopped */ }
    void playbackRef.current?.context.close();
    playbackRef.current = null;
    setPlayingRate(null);
  }

  async function play(rate: TargetRate) {
    if (isBusy || isRecording) return;
    if (playingRate === rate) { stopPlayback(); return; }
    stopPlayback();
    const samples = versions.get(rate);
    if (!samples) return;
    try {
      const context = new AudioContext();
      // Web Audio also rejects AudioBuffer rates below 3 kHz. Upsampling for
      // playback preserves the 1 kHz-limited signal while satisfying the API.
      const playbackRate = rate < 3000 ? 8000 : rate;
      const playbackSamples = rate < 3000 ? await resampleAudio(samples, rate, playbackRate) : samples;
      const buffer = context.createBuffer(1, playbackSamples.length, playbackRate);
      buffer.getChannelData(0).set(playbackSamples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (playbackRef.current?.source === source) {
          void context.close();
          playbackRef.current = null;
          setPlayingRate(null);
        }
      };
      playbackRef.current = { context, source };
      setPlayingRate(rate);
      setStatus(`Playing the ${rate / 1000} kHz version`);
      source.start();
    } catch (error) {
      console.error(error);
      setPlayingRate(null);
      setStatus(`Could not play the ${rate / 1000} kHz version in this browser.`);
    }
  }

  function rerunSegmentation() {
    const reference = versions.get(48000);
    if (!reference || isBusy || isRecording) return;
    if (segmentsEdited && !window.confirm('Running automatic segmentation will replace your manual segment edits. Continue?')) return;
    const generation = ++processingGenerationRef.current;
    setIsBusy(true);
    setStatus('Updating automatic segmentation…');
    window.setTimeout(() => {
      if (generation !== processingGenerationRef.current) return;
      const result = analyzeSpeech(reference, 48000, energyMargin, voicingThreshold);
      if (generation !== processingGenerationRef.current) return;
      setAnalysis(result);
      setSegments(result.segments);
      setSegmentsEdited(false);
      setAppliedThresholds({ energyMarginDb: energyMargin, voicingPeriodicity: voicingThreshold });
      setStatus(`Automatic segmentation updated: ${result.segments.length} regions`);
      setIsBusy(false);
    }, 0);
  }

  async function applyProcessing(label: string, operation: (samples: Float32Array) => Float32Array, transformSegments?: (items: Segment[]) => Segment[]) {
    if (!asset || isBusy || isRecording) return;
    const generation = ++processingGenerationRef.current;
    stopPlayback();
    const segmentSnapshot = segments.map((segment) => ({ ...segment }));
    const historyEntry: ProcessingSnapshot = {
      asset,
      segments: segmentSnapshot,
      segmentsEdited,
      processingSteps: [...processingSteps],
      thresholds: appliedThresholds,
    };
    const processed = operation(asset.samples);
    const preservedSegments = segmentsEdited ? (transformSegments ? transformSegments(segmentSnapshot) : segmentSnapshot) : undefined;
    const committed = await buildAsset(
      { ...asset, name: `${stem(asset.name)}-${label}.wav`, samples: processed, sourceRate: 48000, sourceChannels: 1 },
      `${label} applied${preservedSegments ? ' · manual segment edits preserved' : ''}`,
      { generation, preservedSegments, segmentsEdited, thresholds: appliedThresholds },
    );
    if (committed) {
      setHistory((current) => [...current, historyEntry].slice(-4));
      setProcessingSteps([...processingSteps, label]);
    }
  }

  async function undoProcessing() {
    const previous = history.at(-1);
    if (!previous || isBusy || isRecording) return;
    const generation = ++processingGenerationRef.current;
    stopPlayback();
    const committed = await buildAsset(previous.asset, 'Last processing step undone', {
      generation,
      preservedSegments: previous.segments,
      segmentsEdited: previous.segmentsEdited,
      thresholds: previous.thresholds,
    });
    if (committed) {
      setHistory((current) => current.slice(0, -1));
      setProcessingSteps(previous.processingSteps);
      setEnergyMargin(previous.thresholds.energyMarginDb);
      setVoicingThreshold(previous.thresholds.voicingPeriodicity);
    }
  }

  function applySelectedFilter() {
    if (isBusy || isRecording) return;
    const parsedLowCutoff = Number(lowCutoff);
    const parsedHighCutoff = Number(highCutoff);
    const lowInvalid = filterMode !== 'lowpass' && (!Number.isFinite(parsedLowCutoff) || parsedLowCutoff < 20 || parsedLowCutoff > 5000);
    const highInvalid = filterMode !== 'highpass' && (!Number.isFinite(parsedHighCutoff) || parsedHighCutoff < 200 || parsedHighCutoff > 22000);
    if (lowInvalid || highInvalid) {
      setStatus('Enter filter cutoffs within the displayed valid ranges.');
      return;
    }
    if (filterMode === 'bandpass' && parsedLowCutoff >= parsedHighCutoff) {
      setStatus('Band-pass requires the low cutoff to be below the high cutoff.');
      return;
    }
    const label = filterMode === 'highpass'
      ? `highpass-${parsedLowCutoff}hz`
      : filterMode === 'lowpass'
        ? `lowpass-${parsedHighCutoff}hz`
        : `bandpass-${parsedLowCutoff}-${parsedHighCutoff}hz`;
    const operation = filterMode === 'highpass'
      ? (samples: Float32Array) => butterworthFilter(samples, 48000, parsedLowCutoff, 'highpass')
      : filterMode === 'lowpass'
        ? (samples: Float32Array) => butterworthFilter(samples, 48000, parsedHighCutoff, 'lowpass')
        : (samples: Float32Array) => speechBandFilter(samples, 48000, parsedLowCutoff, parsedHighCutoff);
    void applyProcessing(label, operation);
  }

  function updateSegment(id: string, field: 'start' | 'end' | 'classId', value: number) {
    if (!Number.isFinite(value)) return;
    setSegmentsEdited(true);
    setSegments((current) => current.map((segment) => {
      if (segment.id !== id) return segment;
      if (field === 'classId') return { ...segment, classId: value as SegmentClass, confidence: 1 };
      const boundary = Math.max(0, Math.min(duration, value));
      return field === 'start'
        ? { ...segment, start: Math.min(boundary, segment.end) }
        : { ...segment, end: Math.max(boundary, segment.start) };
    }).sort((a, b) => a.start - b.start));
  }

  function addSegment() {
    const lastEnd = segments.at(-1)?.end ?? 0;
    setSegmentsEdited(true);
    setSegments((current) => [...current, { id: `manual-${Date.now()}`, start: lastEnd, end: Math.min(duration, lastEnd + .1), classId: 0, confidence: 1 }]);
  }

  function prepareSegmentExport(format: 'csv' | 'json' | 'txt') {
    if (!asset || !analysis || isBusy || isRecording) return null;
    const basename = stem(asset.name);
    if (format === 'csv') {
      const body = ['start_sec,end_sec,class_id,class_label,confidence', ...segments.map((segment) => `${segment.start.toFixed(4)},${segment.end.toFixed(4)},${segment.classId},${CLASS_META[segment.classId].label},${segment.confidence.toFixed(3)}`)].join('\n');
      return { blob: new Blob([body], { type: 'text/csv;charset=utf-8' }), filename: `${basename}-segments.csv` };
    } else if (format === 'json') {
      return { blob: new Blob([JSON.stringify({ schemaVersion: 2, source: asset.name, sampleRate: 48000, channels: 1, thresholds: appliedThresholds, processingSteps, segmentsManuallyEdited: segmentsEdited, metrics: { ...analysis, segments: undefined }, advancedAnalysis, segments }, null, 2)], { type: 'application/json' }), filename: `${basename}-analysis.json` };
    } else {
      const rows = segments.map((segment) => `${segment.start.toFixed(3)} ~ ${segment.end.toFixed(3)} sec: ${CLASS_META[segment.classId].label} (${segment.classId})`).join('\n');
      const quality = advancedAnalysis?.voiceQuality;
      const formants = advancedAnalysis?.formantMediansHz;
      const report = `SASP LAB — Speech Signal Analysis Report\n\nInput: ${asset.name}\nStandardized format: 48 kHz, mono\nDuration: ${duration.toFixed(3)} sec\nPeak: ${analysis.peakDbfs.toFixed(2)} dBFS\nRMS: ${analysis.meanRmsDb.toFixed(2)} dBFS\nSpectral centroid: ${analysis.spectralCentroidHz.toFixed(1)} Hz\nProcessing: ${processingSteps.length ? processingSteps.join(' → ') : 'None'}\n\nADVANCED SPEECH ANALYSIS\nF0/HNR/formant/MFCC reference: 16 kHz wideband\nJitter/shimmer cycle marks: 48 kHz source\nMedian F0: ${quality?.medianF0Hz?.toFixed(1) ?? 'N/A'} Hz\nF0 range: ${quality?.minF0Hz?.toFixed(1) ?? 'N/A'}–${quality?.maxF0Hz?.toFixed(1) ?? 'N/A'} Hz\nLocal jitter: ${quality?.jitterLocalPercent?.toFixed(3) ?? 'N/A'} %\nLocal shimmer: ${quality?.shimmerLocalPercent?.toFixed(3) ?? 'N/A'} %\nMedian HNR: ${quality?.hnrDb?.toFixed(1) ?? 'N/A'} dB\nLPC formants (F1/F2/F3): ${formants?.map((value) => value?.toFixed(0) ?? 'N/A').join(' / ') ?? 'N/A'} Hz\nMFCC: 13 static coefficients with Δ and Δ², ${advancedAnalysis?.mfccFrames.length ?? 0} stored frames\n\nSEGMENTATION\nApplied energy margin: ${appliedThresholds.energyMarginDb.toFixed(1)} dB\nApplied voicing periodicity: ${appliedThresholds.voicingPeriodicity.toFixed(2)}\nManual edits: ${segmentsEdited ? 'Yes (preserved)' : 'No'}\n${rows}\n\nAUTOMATIC SEGMENTATION METHOD\n25 ms frames and 10 ms hops are analyzed for RMS energy, zero-crossing rate, and normalized autocorrelation. A robust noise floor (20th percentile) creates an adaptive speech threshold. Frames below it are background (0); energetic, periodic frames with plausible pitch are voiced (2); remaining speech frames are unvoiced (1). A two-pass local vote suppresses isolated label flips. Thresholds remain visible and adjustable, and every result can be manually corrected before export.\n\nADVANCED METHOD\nF0 uses the first reliable YIN cumulative-mean-normalized-difference minimum and normalized autocorrelation confidence on 40 ms frames. HNR uses the accepted pitch lag. Jitter and shimmer use cycle-synchronous pitch marks from the 48 kHz waveform. Formants use pre-emphasized 25 ms frames, order-18 LPC, and spectral-envelope peaks. MFCC-13 uses a 26-band mel filterbank and orthonormal DCT-II; first and second temporal derivatives are included.\n\nLIMITATIONS\nAll results are descriptive DSP estimates, not medical measurements. Music, reverberation, clipping, overlapping speakers, and non-stationary noise can reduce accuracy. Confirm boundaries and unreliable values by listening and inspecting the plots.`;
      return { blob: new Blob([report], { type: 'text/plain;charset=utf-8' }), filename: `${basename}-report.txt` };
    }
  }

  function clearWorkspace() {
    processingGenerationRef.current += 1;
    cancelRecording();
    stopPlayback();
    setIsBusy(false);
    setAsset(null);
    setVersions(new Map());
    setAnalysis(null);
    setAdvancedAnalysis(null);
    setSegments([]);
    setSegmentsEdited(false);
    setEnergyMargin(9);
    setVoicingThreshold(.42);
    setAppliedThresholds({ energyMarginDb: 9, voicingPeriodicity: .42 });
    setPlotView({ start: 0, end: 1 });
    setHistory([]);
    setProcessingSteps([]);
    setStatus('Ready for a 48 kHz mono recording');
    setActiveSection('workspace');
  }

  function navigateTo(section: SectionId) {
    manualNavigationUntilRef.current = Date.now() + 800;
    if (!asset && (section === 'segments' || section === 'export')) {
      setStatus(`${section === 'segments' ? 'Segment editing' : 'Export tools'} unlocks after you record or upload audio.`);
      setActiveSection('record');
      document.getElementById('record')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.history.replaceState(null, '', '#record');
      window.setTimeout(() => document.getElementById('start-recording')?.focus(), 350);
      return;
    }

    const target = document.getElementById(section === 'workspace' ? 'top' : section);
    if (!target) return;
    setActiveSection(section);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${section}`);
    if (section === 'record') window.setTimeout(() => document.getElementById('start-recording')?.focus(), 350);
  }

  const liveBars = Array.from({ length: 90 }, (_, index) => {
    const idle = .1 + Math.abs(Math.sin(index * 1.73)) * .3;
    const envelope = Math.sin((index / 89) * Math.PI) ** .4;
    return Math.max(3, Math.round((isRecording ? liveLevel * envelope * (0.45 + Math.abs(Math.sin(index * 2.17)) * .55) : idle * envelope) * 78));
  });

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => navigateTo('workspace')} aria-label="SASP Lab home"><span className="brand-mark" aria-hidden="true">S</span><span>SASP LAB</span></button>
        <nav className="nav-list" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => <button
            key={item.id}
            type="button"
            className={`nav-item ${activeSection === item.id ? 'active' : ''}`}
            onClick={() => navigateTo(item.id)}
            aria-current={activeSection === item.id ? 'page' : undefined}
            title={!asset && (item.id === 'segments' || item.id === 'export') ? `${item.label} — load audio first` : item.label}
          ><span aria-hidden="true">{item.icon}</span>{item.label}{!asset && (item.id === 'segments' || item.id === 'export') && <i className="nav-lock" aria-hidden="true">•</i>}</button>)}
        </nav>
        <div className="sidebar-note"><span className="status-dot" aria-hidden="true" /><div><strong>Local processing</strong><small>Your audio stays on this device.</small></div></div>
      </aside>

      <section className="main-column" id="top">
        <header className="topbar">
          <div><span className="eyebrow">Speech signal workspace</span><h1>Hear the signal. See the structure.</h1></div>
          <div className="top-actions"><span className="mono-pill">48 kHz · MONO</span>{asset && <button className="quiet-button" onClick={clearWorkspace} disabled={controlsLocked}>New session</button>}<button className="icon-button" onClick={() => setShowHelp(true)} aria-label="Open help">?</button></div>
        </header>

        <div className="content" id="workspace">
          <section className={`hero-card ${isRecording ? 'recording' : ''}`} id="record" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <div className="hero-copy">
              <span className="step-label">01 / CAPTURE</span>
              <h2>{isRecording ? 'Recording your voice' : asset ? 'Signal ready to inspect' : 'Bring in a voice'}</h2>
              <p>{asset ? `${asset.name} is standardized to the assignment format and processed entirely on this device.` : 'Record the assignment passage at 48 kHz mono, or drop in an existing audio file to begin.'}</p>
              <div className="button-row">
                {isRecording ? <button className="primary-button stop-button" onClick={() => stopRecording()}><span className="stop-square" /> Stop · {formatTime(recordingSeconds, 1)}</button> : <button className="primary-button" id="start-recording" onClick={startRecording} disabled={isBusy}><span className="record-dot" /> Start recording</button>}
                <label
                  className={`secondary-button ${controlsLocked ? 'disabled' : ''}`}
                  role="button"
                  tabIndex={controlsLocked ? -1 : 0}
                  aria-disabled={controlsLocked}
                  onKeyDown={(event) => {
                    if (controlsLocked || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }}
                >Upload audio<input ref={fileInputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm,.flac" onChange={onFileInput} hidden disabled={controlsLocked} /></label>
                {asset && <button className="secondary-button" onClick={() => void play(48000)} disabled={controlsLocked}>{playingRate === 48000 ? '■ Stop' : '▶ Play source'}</button>}
              </div>
              {microphoneSupported === false && <p className="microphone-note">Microphone capture is unavailable in this preview browser. Open the local URL in Chrome/Edge or use Upload audio.</p>}
              <details className="script-panel"><summary>Assignment recording script</summary><p>{ASSIGNMENT_TEXT}</p></details>
            </div>
            <div className="live-card" aria-label="Input monitor">
              <div className="live-head"><span>{asset ? asset.name.toUpperCase().slice(0, 34) : 'INPUT PREVIEW'}</span><span className={`live-badge ${isRecording ? 'hot' : ''}`}>{isRecording ? 'REC' : isBusy ? 'PROCESSING' : asset ? 'READY' : 'IDLE'}</span></div>
              {asset ? <WaveformPlot samples={asset.samples} sampleRate={48000} compact /> : <div className="waveform-demo" aria-hidden="true">{liveBars.map((height, index) => <i key={index} style={{ height }} />)}</div>}
              <div className="time-row"><span>{isRecording ? formatTime(recordingSeconds, 1) : asset ? formatTime(duration, 1) : '00:00.0'}</span><span>{asset && analysis ? `${analysis.peakDbfs.toFixed(1)} dBFS` : '48 kHz / 1 ch'}</span></div>
            </div>
          </section>

          <div className={`status-strip ${isBusy ? 'busy' : ''}`} role="status" aria-live="polite"><span />{status}</div>

          <section className="stat-grid" aria-label="Signal summary">
            <article className="stat-card"><span className="stat-icon coral">ƒ</span><div><small>Sample rate</small><strong>{asset ? '48,000' : '—'} <em>Hz</em></strong></div></article>
            <article className="stat-card"><span className="stat-icon blue">◫</span><div><small>Duration</small><strong>{asset ? formatTime(duration, 2) : '00:00.00'}</strong></div></article>
            <article className="stat-card"><span className="stat-icon green">◒</span><div><small>Channels</small><strong>{asset ? 'Mono' : '—'}</strong></div></article>
            <article className="stat-card"><span className="stat-icon amber">∿</span><div><small>Peak level</small><strong>{analysis ? analysis.peakDbfs.toFixed(1) : '—'} <em>dBFS</em></strong></div></article>
          </section>

          {asset && analysis && activeSamples ? <>
            <section className="analysis-card" id="analysis">
              <div className="section-heading">
                <div><span className="step-label">02 / COMPARE</span><h2>Downsampling lab</h2><p>Listen for bandwidth loss while sample count and PCM size fall.</p></div>
                <span className="method-chip">Anti-alias resampling</span>
              </div>
              <div className="rate-grid" role="radiogroup" aria-label="Downsampled signal version">
                {TARGET_RATES.map((rate) => {
                  const samples = versions.get(rate)!;
                  const selectRate = () => { if (controlsLocked) return; setSelectedRate(rate); if (rate !== 48000 && plotMode === 'features') setPlotMode('waveform'); };
                  return <article className={`rate-card ${selectedRate === rate ? 'selected' : ''}`} key={rate} onClick={selectRate}>
                    <div className="rate-head">
                      <label className={`rate-choice ${controlsLocked ? 'disabled' : ''}`} onClick={(event) => event.stopPropagation()}>
                        <input className="sr-only" type="radio" name="signal-rate" value={rate} checked={selectedRate === rate} onChange={selectRate} disabled={controlsLocked} />
                        <span><strong>{rate / 1000} kHz</strong><span>{rate === 48000 ? 'REFERENCE' : `${rate / 2000} kHz NYQUIST`}</span></span>
                      </label>
                      <button className="rate-play" onClick={(event) => { event.stopPropagation(); void play(rate); }} aria-label={`${rate / 1000} kilohertz ${playingRate === rate ? 'stop' : 'play'}`} disabled={controlsLocked}>{playingRate === rate ? '■' : '▶'}</button>
                    </div>
                    <WaveformPlot samples={samples} sampleRate={rate} compact />
                    <p><strong>{RATE_NOTES[rate].title}</strong>{RATE_NOTES[rate].note}</p>
                    <div className="rate-meta"><span>{samples.length.toLocaleString()} samples</span><span>{prettyBytes(44 + samples.length * 2)}</span></div>
                    <DownloadAction className="download-link" stopPropagation disabled={controlsLocked} prepare={() => ({ blob: encodeWav(samples, rate), filename: `${stem(asset.name)}-${rate / 1000}khz.wav` })}>Download WAV ↓</DownloadAction>
                  </article>;
                })}
              </div>
            </section>

            <section className="analysis-card">
              <div className="section-heading">
                <div><span className="step-label">03 / ANALYZE</span><h2>Signal inspector</h2><p>Viewing the {selectedRate / 1000} kHz version · Nyquist {selectedRate / 2000} kHz</p></div>
                <div className="tab-list" role="tablist" aria-label="Plot type">
                  {(['waveform', 'spectrogram', 'features'] as PlotMode[]).map((mode) => <button
                    id={`signal-tab-${mode}`}
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={plotMode === mode}
                    aria-controls="signal-plot-panel"
                    tabIndex={plotMode === mode ? 0 : -1}
                    className={plotMode === mode ? 'active' : ''}
                    onClick={() => setPlotMode(mode)}
                    disabled={mode === 'features' && selectedRate !== 48000}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const modes: PlotMode[] = selectedRate === 48000 ? ['waveform', 'spectrogram', 'features'] : ['waveform', 'spectrogram'];
                      const direction = event.key === 'ArrowRight' ? 1 : -1;
                      const nextMode = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes.at(-1)! : modes[(modes.indexOf(mode) + direction + modes.length) % modes.length];
                      setPlotMode(nextMode);
                      window.requestAnimationFrame(() => document.getElementById(`signal-tab-${nextMode}`)?.focus());
                    }}
                  >{mode}</button>)}
                </div>
              </div>
              <div className="plot-wrap" id="signal-plot-panel" role="tabpanel" aria-labelledby={`signal-tab-${plotMode}`}>
                <div className="plot-stage">
                  {plotMode === 'waveform' && <WaveformPlot samples={activeSamples} sampleRate={selectedRate} segments={selectedRate === 48000 ? segments : []} view={plotView} onViewChange={setPlotView} />}
                  {plotMode === 'spectrogram' && <SpectrogramPlot samples={activeSamples} sampleRate={selectedRate} view={plotView} onViewChange={setPlotView} />}
                  {plotMode === 'features' && <FeaturePlot frames={analysis.frames} view={plotView} onViewChange={setPlotView} />}
                  <span className="plot-gesture-hint" aria-hidden="true">Drag a window to zoom · scroll to zoom</span>
                  {(plotView.start > 0 || plotView.end < 1) && <button className="plot-reset" type="button" onClick={() => setPlotView({ start: 0, end: 1 })}>Reset view</button>}
                </div>
                <div className="plot-axis"><span>{(duration * plotView.start).toFixed(2)} s</span><span>{(duration * (plotView.start + plotView.end) / 2).toFixed(2)} s</span><span>{(duration * plotView.end).toFixed(2)} s</span></div>
              </div>
              {plotMode === 'features' && <div className="feature-key"><span className="energy-key" />Energy <span className="periodicity-key" />Periodicity <span className="zcr-key" />ZCR × 8</div>}
              <div className="metric-grid">
                <div><small>RMS level</small><strong>{analysis.meanRmsDb.toFixed(1)} dBFS</strong></div>
                <div><small>Median pitch</small><strong>{analysis.estimatedPitchHz ? `${analysis.estimatedPitchHz.toFixed(1)} Hz` : 'Not detected'}</strong></div>
                <div><small>Spectral centroid</small><strong>{analysis.spectralCentroidHz.toFixed(0)} Hz</strong></div>
                <div><small>Noise floor</small><strong>{analysis.noiseFloorDb.toFixed(1)} dBFS</strong></div>
              </div>
            </section>

            {advancedAnalysis && <section className="analysis-card advanced-card" aria-labelledby="advanced-title">
              <div className="section-heading">
                <div><span className="step-label">ADVANCED DSP</span><h2 id="advanced-title">Voice & vocal-tract analysis</h2><p>F0, HNR, formants, and MFCC use 16 kHz wideband audio; cycle perturbation tracks the 48 kHz source.</p></div>
                <div className="advanced-heading-actions">
                  <span className="method-chip">16 kHz analysis reference</span>
                  <div className="tab-list advanced-tabs" role="tablist" aria-label="Advanced analysis type">
                    {(['voice', 'formants', 'mfcc'] as AdvancedMode[]).map((mode) => <button
                      id={`advanced-tab-${mode}`}
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={advancedMode === mode}
                      tabIndex={advancedMode === mode ? 0 : -1}
                      aria-controls="advanced-panel"
                      className={advancedMode === mode ? 'active' : ''}
                      onClick={() => setAdvancedMode(mode)}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const modes: AdvancedMode[] = ['voice', 'formants', 'mfcc'];
                        const direction = event.key === 'ArrowRight' ? 1 : -1;
                        const nextMode = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes.at(-1)! : modes[(modes.indexOf(mode) + direction + modes.length) % modes.length];
                        setAdvancedMode(nextMode);
                        window.requestAnimationFrame(() => document.getElementById(`advanced-tab-${nextMode}`)?.focus());
                      }}
                    >{mode === 'voice' ? 'Voice / F0' : mode === 'formants' ? 'LPC formants' : 'MFCC-13'}</button>)}
                  </div>
                </div>
              </div>

              <div id="advanced-panel" role="tabpanel" aria-labelledby={`advanced-tab-${advancedMode}`}>
                {advancedMode === 'voice' && <>
                  <div className="plot-wrap">
                    <div className="plot-stage">
                      <PitchContourPlot frames={advancedAnalysis.pitchFrames} duration={duration} view={plotView} onViewChange={setPlotView} />
                      <span className="plot-gesture-hint" aria-hidden="true">Gaps = unvoiced or unreliable · drag to zoom</span>
                      {(plotView.start > 0 || plotView.end < 1) && <button className="plot-reset" type="button" onClick={() => setPlotView({ start: 0, end: 1 })}>Reset view</button>}
                    </div>
                    <div className="plot-axis"><span>{(duration * plotView.start).toFixed(2)} s</span><span>{(duration * (plotView.start + plotView.end) / 2).toFixed(2)} s</span><span>{(duration * plotView.end).toFixed(2)} s</span></div>
                  </div>
                  <div className="advanced-metric-grid">
                    <div><small>Median F0</small><strong>{metric(advancedAnalysis.voiceQuality.medianF0Hz, 'Hz')}</strong></div>
                    <div><small>F0 range</small><strong>{advancedAnalysis.voiceQuality.minF0Hz === null || advancedAnalysis.voiceQuality.maxF0Hz === null ? 'Not reliable' : `${advancedAnalysis.voiceQuality.minF0Hz.toFixed(0)}–${advancedAnalysis.voiceQuality.maxF0Hz.toFixed(0)} Hz`}</strong></div>
                    <div><small>Local jitter</small><strong>{metric(advancedAnalysis.voiceQuality.jitterLocalPercent, '%', 3)}</strong></div>
                    <div><small>Local shimmer</small><strong>{metric(advancedAnalysis.voiceQuality.shimmerLocalPercent, '%', 3)}</strong></div>
                    <div><small>Median HNR</small><strong>{metric(advancedAnalysis.voiceQuality.hnrDb, 'dB')}</strong></div>
                    <div><small>Voiced frames</small><strong>{(advancedAnalysis.voiceQuality.voicedRatio * 100).toFixed(1)}%</strong></div>
                  </div>
                  <p className="analysis-caution">Jitter, shimmer, and HNR are engineering descriptors for this recording—not a medical or clinical diagnosis. “Not reliable” means too few valid voiced cycles.</p>
                </>}

                {advancedMode === 'formants' && <>
                  <div className="plot-wrap">
                    <div className="plot-stage">
                      <FormantPlot frames={advancedAnalysis.formantFrames} duration={duration} view={plotView} onViewChange={setPlotView} />
                      <span className="plot-gesture-hint" aria-hidden="true">Voiced frames only · drag to zoom</span>
                      {(plotView.start > 0 || plotView.end < 1) && <button className="plot-reset" type="button" onClick={() => setPlotView({ start: 0, end: 1 })}>Reset view</button>}
                    </div>
                    <div className="plot-axis"><span>{(duration * plotView.start).toFixed(2)} s</span><span>{(duration * (plotView.start + plotView.end) / 2).toFixed(2)} s</span><span>{(duration * plotView.end).toFixed(2)} s</span></div>
                  </div>
                  <div className="formant-key"><span className="f1-key" />F1 <span className="f2-key" />F2 <span className="f3-key" />F3</div>
                  <div className="advanced-metric-grid compact-metrics">
                    <div><small>Median F1</small><strong>{metric(advancedAnalysis.formantMediansHz[0], 'Hz', 0)}</strong></div>
                    <div><small>Median F2</small><strong>{metric(advancedAnalysis.formantMediansHz[1], 'Hz', 0)}</strong></div>
                    <div><small>Median F3</small><strong>{metric(advancedAnalysis.formantMediansHz[2], 'Hz', 0)}</strong></div>
                    <div><small>Valid F1/F2 frames</small><strong>{advancedAnalysis.validFormantFrames} / {advancedAnalysis.formantFrames.length}</strong></div>
                  </div>
                  <p className="analysis-caution">Order-18 LPC estimates resonances, not phoneme labels. Results are withheld when the spectral envelope has too few plausible peaks.</p>
                </>}

                {advancedMode === 'mfcc' && <>
                  <div className="subcontrol-row">
                    <p>13-coefficient cepstrogram</p>
                    <div className="mini-tab-list" role="group" aria-label="MFCC derivative order">
                      {([['coefficients', 'Static'], ['delta', 'Δ'], ['deltaDelta', 'Δ²']] as [MfccMode, string][]).map(([mode, label]) => <button type="button" key={mode} className={mfccMode === mode ? 'active' : ''} aria-pressed={mfccMode === mode} onClick={() => setMfccMode(mode)}>{label}</button>)}
                    </div>
                  </div>
                  <div className="plot-wrap">
                    <div className="plot-stage">
                      <MfccPlot frames={advancedAnalysis.mfccFrames} duration={duration} mode={mfccMode} view={plotView} onViewChange={setPlotView} />
                      <span className="plot-gesture-hint light-hint" aria-hidden="true">C0 energy → C12 fine spectral detail</span>
                      {(plotView.start > 0 || plotView.end < 1) && <button className="plot-reset" type="button" onClick={() => setPlotView({ start: 0, end: 1 })}>Reset view</button>}
                    </div>
                    <div className="plot-axis"><span>{(duration * plotView.start).toFixed(2)} s</span><span>{(duration * (plotView.start + plotView.end) / 2).toFixed(2)} s</span><span>{(duration * plotView.end).toFixed(2)} s</span></div>
                  </div>
                  <div className="advanced-metric-grid compact-metrics">
                    <div><small>Feature dimensions</small><strong>13 × 3</strong></div>
                    <div><small>Stored frames</small><strong>{advancedAnalysis.mfccFrames.length}</strong></div>
                    <div><small>Mel filters</small><strong>26 bands</strong></div>
                    <div><small>Frame / hop</small><strong>25 / 10 ms</strong></div>
                  </div>
                  <p className="analysis-caution">Each coefficient is contrast-normalized only for the heatmap. Exported JSON retains the raw static, Δ, and Δ² values.</p>
                </>}
              </div>
            </section>}

            <section className="analysis-card" id="segments">
              <div className="section-heading">
                <div><span className="step-label">04 / SEGMENT</span><h2>Speech regions</h2><p>Automatic labels are editable. Class IDs: background 0, unvoiced 1, voiced 2.</p></div>
                <div className="segment-heading-actions">{segmentsEdited && <span className="edit-protection-chip">Edits preserved by tools</span>}<button className="outline-button" onClick={addSegment} disabled={controlsLocked}>＋ Add region</button></div>
              </div>
              <div className="segment-summary">
                {([0, 1, 2] as SegmentClass[]).map((classId) => <div key={classId} className={`summary-${classId}`}><span>{classId}</span><div><small>{CLASS_META[classId].label}</small><strong>{classDurations[classId].toFixed(2)} s</strong></div></div>)}
              </div>
              <div className="threshold-panel">
                <label><span>Energy above noise <strong>{energyMargin} dB</strong></span><input type="range" min="3" max="20" step="1" value={energyMargin} onChange={(event) => setEnergyMargin(Number(event.target.value))} disabled={controlsLocked} /></label>
                <label><span>Voicing periodicity <strong>{voicingThreshold.toFixed(2)}</strong></span><input type="range" min="0.2" max="0.8" step="0.02" value={voicingThreshold} onChange={(event) => setVoicingThreshold(Number(event.target.value))} disabled={controlsLocked} /></label>
                <button className="primary-button dark" onClick={rerunSegmentation} disabled={controlsLocked}>{segmentationSettingsPending ? 'Apply threshold changes' : 'Run automatic segmentation'}</button>
              </div>
              <div className="segment-table-wrap">
                <table className="segment-table">
                  <thead><tr><th>#</th><th>Start (s)</th><th>End (s)</th><th>Class</th><th>Confidence</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{segments.map((segment, index) => <tr key={segment.id}>
                    <td>{String(index + 1).padStart(2, '0')}</td>
                    <td><input aria-label={`Segment ${index + 1} start`} type="number" min="0" max={segment.end} step="0.01" value={segment.start.toFixed(2)} onChange={(event) => updateSegment(segment.id, 'start', Number(event.target.value))} disabled={controlsLocked} /></td>
                    <td><input aria-label={`Segment ${index + 1} end`} type="number" min={segment.start} max={duration} step="0.01" value={segment.end.toFixed(2)} onChange={(event) => updateSegment(segment.id, 'end', Number(event.target.value))} disabled={controlsLocked} /></td>
                    <td><select aria-label={`Segment ${index + 1} class`} value={segment.classId} onChange={(event) => updateSegment(segment.id, 'classId', Number(event.target.value))} disabled={controlsLocked}><option value="0">0 · Background</option><option value="1">1 · Unvoiced</option><option value="2">2 · Voiced</option></select></td>
                    <td><span className={`confidence confidence-${segment.classId}`}>{Math.round(segment.confidence * 100)}%</span></td>
                    <td><button className="delete-button" aria-label={`Delete segment ${index + 1}`} disabled={controlsLocked} onClick={() => { setSegmentsEdited(true); setSegments((current) => current.filter((item) => item.id !== segment.id)); }}>×</button></td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section>

            <section className="dual-grid">
              <article className="analysis-card process-card">
                <div><span className="step-label">TOOLS</span><h2>Quick processing</h2><p>Apply common transforms with undo. Manually corrected segment times and classes are preserved.</p></div>
                <div className="tool-grid">
                  <button onClick={() => void applyProcessing('normalized', normalize)} disabled={controlsLocked}><span>↥</span><strong>Normalize</strong><small>Peak to −0.18 dBFS</small></button>
                  <button onClick={() => void applyProcessing('dc-removed', removeDc)} disabled={controlsLocked}><span>≋</span><strong>Remove DC</strong><small>Center around zero</small></button>
                  <button onClick={() => void applyProcessing('pre-emphasis', (samples) => preEmphasis(samples, .97))} disabled={controlsLocked}><span>⤴</span><strong>Pre-emphasis</strong><small>y[n]=x[n]−.97x[n−1]</small></button>
                  <button onClick={() => void applyProcessing('reversed', reverseAudio, (items) => items.map((segment) => ({ ...segment, start: duration - segment.end, end: duration - segment.start })).sort((a, b) => a.start - b.start))} disabled={controlsLocked}><span>↔</span><strong>Reverse</strong><small>Flip audio and edited regions</small></button>
                </div>
                <div className="filter-panel">
                  <div className="filter-head"><div><strong>Frequency shaping</strong><small>Cascaded Butterworth biquads</small></div><div className="mini-tab-list" role="group" aria-label="Filter type">
                    {(['highpass', 'lowpass', 'bandpass'] as FilterMode[]).map((mode) => <button type="button" key={mode} className={filterMode === mode ? 'active' : ''} aria-pressed={filterMode === mode} onClick={() => setFilterMode(mode)} disabled={controlsLocked}>{mode === 'highpass' ? 'HP' : mode === 'lowpass' ? 'LP' : 'Band'}</button>)}
                  </div></div>
                  <div className="filter-controls">
                    {filterMode !== 'lowpass' && <label><span>Low cutoff</span><input type="number" min="20" max="5000" step="10" value={lowCutoff} onChange={(event) => setLowCutoff(event.target.value)} disabled={controlsLocked} /><em>Hz</em></label>}
                    {filterMode !== 'highpass' && <label><span>High cutoff</span><input type="number" min="200" max="22000" step="100" value={highCutoff} onChange={(event) => setHighCutoff(event.target.value)} disabled={controlsLocked} /><em>Hz</em></label>}
                    <button className="filter-apply" type="button" onClick={applySelectedFilter} disabled={controlsLocked}>Apply filter</button>
                  </div>
                  <div className="gate-row">
                    <label><span>Noise gate</span><input type="range" min="-70" max="-20" step="1" value={gateThreshold} onChange={(event) => setGateThreshold(Number(event.target.value))} disabled={controlsLocked} /><strong>{gateThreshold} dBFS</strong></label>
                    <button type="button" onClick={() => void applyProcessing(`noise-gate-${Math.abs(gateThreshold)}db`, (samples) => noiseGate(samples, 48000, gateThreshold))} disabled={controlsLocked}>Apply gate</button>
                  </div>
                </div>
                <button className="undo-button" onClick={() => void undoProcessing()} disabled={!history.length || controlsLocked}>↶ Undo processing ({history.length}/4)</button>
              </article>

              <article className="analysis-card method-card">
                <div><span className="step-label">METHOD</span><h2>How auto-segmentation works</h2></div>
                <ol className="method-list">
                  <li><span>1</span><div><strong>Frame</strong><p>Split mono audio into 25 ms windows every 10 ms.</p></div></li>
                  <li><span>2</span><div><strong>Measure</strong><p>Compute RMS energy, zero-crossing rate, autocorrelation, and pitch.</p></div></li>
                  <li><span>3</span><div><strong>Decide</strong><p>Low energy → background; periodic speech → voiced; other speech → unvoiced.</p></div></li>
                  <li><span>4</span><div><strong>Smooth & review</strong><p>Local voting removes label flicker; a person confirms ambiguous boundaries.</p></div></li>
                </ol>
              </article>
            </section>

            <section className="export-card" id="export">
              <div><span className="step-label">05 / EXPORT</span><h2>Take the analysis with you</h2><p>Download the signal, editable labels, machine-readable features, or a ready-to-submit text report.</p></div>
              <div className="export-actions">
                <DownloadAction disabled={controlsLocked} prepare={() => ({ blob: encodeWav(asset.samples, 48000), filename: `${stem(asset.name)}-48khz-mono.wav` })}>WAV <span>48 kHz source</span></DownloadAction>
                <DownloadAction disabled={controlsLocked} prepare={() => prepareSegmentExport('csv')}>CSV <span>Timing labels</span></DownloadAction>
                <DownloadAction disabled={controlsLocked} prepare={() => prepareSegmentExport('json')}>JSON <span>Full analysis</span></DownloadAction>
                <DownloadAction disabled={controlsLocked} prepare={() => prepareSegmentExport('txt')}>TXT <span>Assignment report</span></DownloadAction>
              </div>
            </section>
          </> : <section className="analysis-card empty-card" id="analysis">
            <div className="section-heading"><div><span className="step-label">02 / INSPECT</span><h2>Signal overview</h2></div><div className="segmentation-key"><span><i className="key-bg" />Background</span><span><i className="key-unvoiced" />Unvoiced</span><span><i className="key-voiced" />Voiced</span></div></div>
            <div className="empty-analysis"><div className="empty-wave" aria-hidden="true">∿</div><strong>Your waveform will appear here</strong><p>Capture or upload a clip to inspect its waveform, spectrum, pitch, downsampled versions, and speech regions.</p></div>
          </section>}
        </div>
      </section>

      {showHelp && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setShowHelp(false)} aria-label="Close help">×</button><span className="step-label">QUICK START</span><h2 id="help-title">From microphone to report</h2><ol><li>Use headphones, choose a quiet room, and record the displayed passage once.</li><li>Listen to 48, 16, 8, and 2 kHz versions. Note loss of brightness and consonant detail.</li><li>Inspect waveform, spectrogram, and features. Adjust thresholds if the automatic labels look wrong.</li><li>Edit timing and class IDs directly in the table, then export TXT for the assignment and CSV/JSON for further work.</li></ol><p className="privacy-note">No upload server is used. Audio processing and exports happen locally in this browser tab.</p></section></div>}
    </main>
  );
}
