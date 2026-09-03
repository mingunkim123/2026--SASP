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
import { FeaturePlot, SpectrogramPlot, WaveformPlot } from './plots';

const TARGET_RATES = [48000, 16000, 8000, 2000] as const;
type TargetRate = (typeof TARGET_RATES)[number];
type PlotMode = 'waveform' | 'spectrogram' | 'features';
type SectionId = 'workspace' | 'record' | 'analysis' | 'segments' | 'export';

type AudioAsset = {
  name: string;
  samples: Float32Array;
  sampleRate: number;
  sourceRate: number;
  sourceChannels: number;
};

const ASSIGNMENT_TEXT = 'Speech has evolved as a primary form of communication between humans. The topic of this class, “discrete-time speech signal processing” can be defined as the manipulation of sampled speech signals by a digital processor to obtain a new signal with some desired properties.';

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

function DownloadAction({ prepare, className, children, stopPropagation = false }: { prepare: () => { blob: Blob; filename: string } | null; className?: string; children: ReactNode; stopPropagation?: boolean }) {
  function handleClick(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (stopPropagation) event.stopPropagation();
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

  return <a href="#export" className={className} download onClick={handleClick}>{children}</a>;
}

export default function Home() {
  const [asset, setAsset] = useState<AudioAsset | null>(null);
  const [versions, setVersions] = useState<Map<TargetRate, Float32Array>>(new Map());
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedRate, setSelectedRate] = useState<TargetRate>(48000);
  const [plotMode, setPlotMode] = useState<PlotMode>('waveform');
  const [energyMargin, setEnergyMargin] = useState(9);
  const [voicingThreshold, setVoicingThreshold] = useState(0.42);
  const [isBusy, setIsBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [liveLevel, setLiveLevel] = useState(0);
  const [playingRate, setPlayingRate] = useState<TargetRate | null>(null);
  const [status, setStatus] = useState('Ready for a 48 kHz mono recording');
  const [showHelp, setShowHelp] = useState(false);
  const [history, setHistory] = useState<AudioAsset[]>([]);
  const [activeSection, setActiveSection] = useState<SectionId>('workspace');
  const [microphoneSupported, setMicrophoneSupported] = useState<boolean | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveAnimationRef = useRef<number | null>(null);
  const playbackRef = useRef<{ context: AudioContext; source: AudioBufferSourceNode } | null>(null);
  const manualNavigationUntilRef = useRef(0);

  const activeSamples = versions.get(selectedRate) ?? null;
  const duration = asset ? asset.samples.length / asset.sampleRate : 0;
  const classDurations = useMemo(() => {
    const totals: Record<SegmentClass, number> = { 0: 0, 1: 0, 2: 0 };
    for (const segment of segments) totals[segment.classId] += Math.max(0, segment.end - segment.start);
    return totals;
  }, [segments]);

  useEffect(() => () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    if (liveAnimationRef.current) cancelAnimationFrame(liveAnimationRef.current);
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

  async function buildAsset(nextAsset: AudioAsset, message = 'Analysis complete') {
    setIsBusy(true);
    setStatus('Resampling and extracting speech features…');
    try {
      const reference = await resampleAudio(nextAsset.samples, nextAsset.sampleRate, 48000);
      const [wideband, telephone] = await Promise.all([
        resampleAudio(reference, 48000, 16000),
        resampleAudio(reference, 48000, 8000),
      ]);
      const narrowband = await resampleAudio(telephone, 8000, 2000);
      const nextVersions = new Map<TargetRate, Float32Array>([
        [48000, reference],
        [16000, wideband],
        [8000, telephone],
        [2000, narrowband],
      ]);
      const nextAnalysis = analyzeSpeech(nextVersions.get(48000)!, 48000, energyMargin, voicingThreshold);
      setAsset({ ...nextAsset, samples: nextVersions.get(48000)!, sampleRate: 48000 });
      setVersions(nextVersions);
      setAnalysis(nextAnalysis);
      setSegments(nextAnalysis.segments);
      setSelectedRate(48000);
      setStatus(message);
    } catch (error) {
      console.error(error);
      setStatus('Could not process this audio. Try WAV, MP3, M4A, OGG, or WebM.');
    } finally {
      setIsBusy(false);
    }
  }

  async function decodeBlob(blob: Blob, name: string) {
    setIsBusy(true);
    setStatus('Decoding audio…');
    let context: AudioContext | null = null;
    try {
      context = new AudioContext({ sampleRate: 48000 });
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      const sourceRate = decoded.sampleRate;
      const sourceChannels = decoded.numberOfChannels;
      const mono = mixToMono(decoded);
      const at48k = await resampleAudio(mono, sourceRate, 48000);
      await buildAsset({ name, samples: at48k, sampleRate: 48000, sourceRate, sourceChannels }, 'Loaded, standardized to 48 kHz mono, and segmented');
      setHistory([]);
    } catch (error) {
      console.error(error);
      setStatus('Audio decoding failed. Try a different file format.');
      setIsBusy(false);
    } finally {
      await context?.close();
    }
  }

  function handleFile(file?: File) {
    if (!file) return;
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

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('Microphone recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, sampleSize: 16, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        void decodeBlob(blob, `speech-recording-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);
      setStatus('Recording in mono — read the passage at a natural pace');
      const startedAt = performance.now();
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((performance.now() - startedAt) / 1000), 100);

      const monitor = new AudioContext({ sampleRate: 48000 });
      const source = monitor.createMediaStreamSource(stream);
      const analyser = monitor.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let square = 0;
        for (const value of buffer) square += value * value;
        setLiveLevel(Math.min(1, Math.sqrt(square / buffer.length) * 7));
        liveAnimationRef.current = requestAnimationFrame(tick);
      };
      tick();
      recorder.addEventListener('stop', () => {
        if (liveAnimationRef.current) cancelAnimationFrame(liveAnimationRef.current);
        void monitor.close();
        setLiveLevel(0);
      });
    } catch (error) {
      console.error(error);
      setStatus('Microphone access was unavailable. Check browser permission or upload a file.');
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    setIsRecording(false);
    setStatus('Finalizing the recording…');
  }

  function stopPlayback() {
    try { playbackRef.current?.source.stop(); } catch { /* already stopped */ }
    void playbackRef.current?.context.close();
    playbackRef.current = null;
    setPlayingRate(null);
  }

  async function play(rate: TargetRate) {
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
    if (!reference) return;
    setIsBusy(true);
    setStatus('Updating automatic segmentation…');
    window.setTimeout(() => {
      const result = analyzeSpeech(reference, 48000, energyMargin, voicingThreshold);
      setAnalysis(result);
      setSegments(result.segments);
      setStatus(`Automatic segmentation updated: ${result.segments.length} regions`);
      setIsBusy(false);
    }, 0);
  }

  async function applyProcessing(label: string, operation: (samples: Float32Array) => Float32Array) {
    if (!asset) return;
    setHistory((current) => [...current, asset]);
    const processed = operation(asset.samples);
    await buildAsset({ ...asset, name: `${stem(asset.name)}-${label}.wav`, samples: processed, sourceRate: 48000, sourceChannels: 1 }, `${label} applied`);
  }

  async function undoProcessing() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    await buildAsset(previous, 'Last processing step undone');
  }

  function updateSegment(id: string, field: 'start' | 'end' | 'classId', value: number) {
    setSegments((current) => current.map((segment) => segment.id === id ? {
      ...segment,
      [field]: field === 'classId' ? value as SegmentClass : Math.max(0, Math.min(duration, value)),
      confidence: field === 'classId' ? 1 : segment.confidence,
    } : segment).sort((a, b) => a.start - b.start));
  }

  function addSegment() {
    const lastEnd = segments.at(-1)?.end ?? 0;
    setSegments((current) => [...current, { id: `manual-${Date.now()}`, start: lastEnd, end: Math.min(duration, lastEnd + .1), classId: 0, confidence: 1 }]);
  }

  function prepareSegmentExport(format: 'csv' | 'json' | 'txt') {
    if (!asset || !analysis) return null;
    const basename = stem(asset.name);
    if (format === 'csv') {
      const body = ['start_sec,end_sec,class_id,class_label,confidence', ...segments.map((segment) => `${segment.start.toFixed(4)},${segment.end.toFixed(4)},${segment.classId},${CLASS_META[segment.classId].label},${segment.confidence.toFixed(3)}`)].join('\n');
      return { blob: new Blob([body], { type: 'text/csv;charset=utf-8' }), filename: `${basename}-segments.csv` };
    } else if (format === 'json') {
      return { blob: new Blob([JSON.stringify({ source: asset.name, sampleRate: 48000, channels: 1, thresholds: { energyMarginDb: energyMargin, voicingPeriodicity: voicingThreshold }, metrics: analysis, segments }, null, 2)], { type: 'application/json' }), filename: `${basename}-analysis.json` };
    } else {
      const rows = segments.map((segment) => `${segment.start.toFixed(3)} ~ ${segment.end.toFixed(3)} sec: ${CLASS_META[segment.classId].label} (${segment.classId})`).join('\n');
      const report = `SASP LAB — Speech Signal Analysis Report\n\nInput: ${asset.name}\nStandardized format: 48 kHz, mono\nDuration: ${duration.toFixed(3)} sec\nPeak: ${analysis.peakDbfs.toFixed(2)} dBFS\nRMS: ${analysis.meanRmsDb.toFixed(2)} dBFS\nMedian voiced pitch: ${analysis.estimatedPitchHz?.toFixed(1) ?? 'N/A'} Hz\nSpectral centroid: ${analysis.spectralCentroidHz.toFixed(1)} Hz\n\nSEGMENTATION\n${rows}\n\nAUTOMATIC SEGMENTATION METHOD\n25 ms frames and 10 ms hops are analyzed for RMS energy, zero-crossing rate, and normalized autocorrelation. A robust noise floor (20th percentile) creates an adaptive speech threshold. Frames below it are background (0); energetic, periodic frames with plausible pitch are voiced (2); remaining speech frames are unvoiced (1). A two-pass local vote suppresses isolated label flips. Thresholds remain visible and adjustable, and every result can be manually corrected before export.\n\nLIMITATIONS\nThis signal-processing baseline is explainable rather than phoneme-aware. Music, reverberation, clipping, overlapping speakers, and non-stationary noise can reduce accuracy. Confirm boundaries by listening and inspecting the spectrogram.`;
      return { blob: new Blob([report], { type: 'text/plain;charset=utf-8' }), filename: `${basename}-report.txt` };
    }
  }

  function clearWorkspace() {
    stopPlayback();
    setAsset(null);
    setVersions(new Map());
    setAnalysis(null);
    setSegments([]);
    setHistory([]);
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
          <div className="top-actions"><span className="mono-pill">48 kHz · MONO</span>{asset && <button className="quiet-button" onClick={clearWorkspace}>New session</button>}<button className="icon-button" onClick={() => setShowHelp(true)} aria-label="Open help">?</button></div>
        </header>

        <div className="content" id="workspace">
          <section className={`hero-card ${isRecording ? 'recording' : ''}`} id="record" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <div className="hero-copy">
              <span className="step-label">01 / CAPTURE</span>
              <h2>{isRecording ? 'Recording your voice' : asset ? 'Signal ready to inspect' : 'Bring in a voice'}</h2>
              <p>{asset ? `${asset.name} is standardized to the assignment format and processed entirely on this device.` : 'Record the assignment passage at 48 kHz mono, or drop in an existing audio file to begin.'}</p>
              <div className="button-row">
                {isRecording ? <button className="primary-button stop-button" onClick={stopRecording}><span className="stop-square" /> Stop · {formatTime(recordingSeconds, 1)}</button> : <button className="primary-button" id="start-recording" onClick={startRecording} disabled={isBusy}><span className="record-dot" /> Start recording</button>}
                <label className={`secondary-button ${isBusy ? 'disabled' : ''}`}>Upload audio<input type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm,.flac" onChange={onFileInput} hidden disabled={isBusy} /></label>
                {asset && <button className="secondary-button" onClick={() => void play(48000)}>{playingRate === 48000 ? '■ Stop' : '▶ Play source'}</button>}
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
              <div className="rate-grid">
                {TARGET_RATES.map((rate) => {
                  const samples = versions.get(rate)!;
                  return <article className={`rate-card ${selectedRate === rate ? 'selected' : ''}`} key={rate} onClick={() => { setSelectedRate(rate); if (rate !== 48000 && plotMode === 'features') setPlotMode('waveform'); }}>
                    <div className="rate-head"><div><strong>{rate / 1000} kHz</strong><span>{rate === 48000 ? 'REFERENCE' : `${rate / 2000} kHz NYQUIST`}</span></div><button onClick={(event) => { event.stopPropagation(); void play(rate); }} aria-label={`${rate / 1000} kilohertz ${playingRate === rate ? 'stop' : 'play'}`}>{playingRate === rate ? '■' : '▶'}</button></div>
                    <WaveformPlot samples={samples} sampleRate={rate} compact />
                    <p><strong>{RATE_NOTES[rate].title}</strong>{RATE_NOTES[rate].note}</p>
                    <div className="rate-meta"><span>{samples.length.toLocaleString()} samples</span><span>{prettyBytes(44 + samples.length * 2)}</span></div>
                    <DownloadAction className="download-link" stopPropagation prepare={() => ({ blob: encodeWav(samples, rate), filename: `${stem(asset.name)}-${rate / 1000}khz.wav` })}>Download WAV ↓</DownloadAction>
                  </article>;
                })}
              </div>
            </section>

            <section className="analysis-card">
              <div className="section-heading">
                <div><span className="step-label">03 / ANALYZE</span><h2>Signal inspector</h2><p>Viewing the {selectedRate / 1000} kHz version · Nyquist {selectedRate / 2000} kHz</p></div>
                <div className="tab-list" role="tablist" aria-label="Plot type">
                  {(['waveform', 'spectrogram', 'features'] as PlotMode[]).map((mode) => <button key={mode} className={plotMode === mode ? 'active' : ''} onClick={() => setPlotMode(mode)} disabled={mode === 'features' && selectedRate !== 48000}>{mode}</button>)}
                </div>
              </div>
              <div className="plot-wrap">
                {plotMode === 'waveform' && <WaveformPlot samples={activeSamples} sampleRate={selectedRate} segments={selectedRate === 48000 ? segments : []} />}
                {plotMode === 'spectrogram' && <SpectrogramPlot samples={activeSamples} sampleRate={selectedRate} />}
                {plotMode === 'features' && <FeaturePlot frames={analysis.frames} />}
                <div className="plot-axis"><span>0.00 s</span><span>{(duration / 2).toFixed(2)} s</span><span>{duration.toFixed(2)} s</span></div>
              </div>
              {plotMode === 'features' && <div className="feature-key"><span className="energy-key" />Energy <span className="periodicity-key" />Periodicity <span className="zcr-key" />ZCR × 8</div>}
              <div className="metric-grid">
                <div><small>RMS level</small><strong>{analysis.meanRmsDb.toFixed(1)} dBFS</strong></div>
                <div><small>Median pitch</small><strong>{analysis.estimatedPitchHz ? `${analysis.estimatedPitchHz.toFixed(1)} Hz` : 'Not detected'}</strong></div>
                <div><small>Spectral centroid</small><strong>{analysis.spectralCentroidHz.toFixed(0)} Hz</strong></div>
                <div><small>Noise floor</small><strong>{analysis.noiseFloorDb.toFixed(1)} dBFS</strong></div>
              </div>
            </section>

            <section className="analysis-card" id="segments">
              <div className="section-heading">
                <div><span className="step-label">04 / SEGMENT</span><h2>Speech regions</h2><p>Automatic labels are editable. Class IDs: background 0, unvoiced 1, voiced 2.</p></div>
                <button className="outline-button" onClick={addSegment}>＋ Add region</button>
              </div>
              <div className="segment-summary">
                {([0, 1, 2] as SegmentClass[]).map((classId) => <div key={classId} className={`summary-${classId}`}><span>{classId}</span><div><small>{CLASS_META[classId].label}</small><strong>{classDurations[classId].toFixed(2)} s</strong></div></div>)}
              </div>
              <div className="threshold-panel">
                <label><span>Energy above noise <strong>{energyMargin} dB</strong></span><input type="range" min="3" max="20" step="1" value={energyMargin} onChange={(event) => setEnergyMargin(Number(event.target.value))} /></label>
                <label><span>Voicing periodicity <strong>{voicingThreshold.toFixed(2)}</strong></span><input type="range" min="0.2" max="0.8" step="0.02" value={voicingThreshold} onChange={(event) => setVoicingThreshold(Number(event.target.value))} /></label>
                <button className="primary-button dark" onClick={rerunSegmentation} disabled={isBusy}>Run automatic segmentation</button>
              </div>
              <div className="segment-table-wrap">
                <table className="segment-table">
                  <thead><tr><th>#</th><th>Start (s)</th><th>End (s)</th><th>Class</th><th>Confidence</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{segments.map((segment, index) => <tr key={segment.id}>
                    <td>{String(index + 1).padStart(2, '0')}</td>
                    <td><input aria-label={`Segment ${index + 1} start`} type="number" min="0" max={duration} step="0.01" value={segment.start.toFixed(2)} onChange={(event) => updateSegment(segment.id, 'start', Number(event.target.value))} /></td>
                    <td><input aria-label={`Segment ${index + 1} end`} type="number" min="0" max={duration} step="0.01" value={segment.end.toFixed(2)} onChange={(event) => updateSegment(segment.id, 'end', Number(event.target.value))} /></td>
                    <td><select aria-label={`Segment ${index + 1} class`} value={segment.classId} onChange={(event) => updateSegment(segment.id, 'classId', Number(event.target.value))}><option value="0">0 · Background</option><option value="1">1 · Unvoiced</option><option value="2">2 · Voiced</option></select></td>
                    <td><span className={`confidence confidence-${segment.classId}`}>{Math.round(segment.confidence * 100)}%</span></td>
                    <td><button className="delete-button" aria-label={`Delete segment ${index + 1}`} onClick={() => setSegments((current) => current.filter((item) => item.id !== segment.id))}>×</button></td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section>

            <section className="dual-grid">
              <article className="analysis-card process-card">
                <div><span className="step-label">TOOLS</span><h2>Quick processing</h2><p>Apply common sample-domain transforms, with one-step-at-a-time undo history.</p></div>
                <div className="tool-grid">
                  <button onClick={() => void applyProcessing('normalized', normalize)}><span>↥</span><strong>Normalize</strong><small>Peak to −0.18 dBFS</small></button>
                  <button onClick={() => void applyProcessing('dc-removed', removeDc)}><span>≋</span><strong>Remove DC</strong><small>Center around zero</small></button>
                  <button onClick={() => void applyProcessing('pre-emphasis', (samples) => preEmphasis(samples, .97))}><span>⤴</span><strong>Pre-emphasis</strong><small>y[n]=x[n]−.97x[n−1]</small></button>
                  <button onClick={() => void applyProcessing('reversed', reverseAudio)}><span>↔</span><strong>Reverse</strong><small>Flip sample order</small></button>
                </div>
                <button className="undo-button" onClick={() => void undoProcessing()} disabled={!history.length}>↶ Undo processing ({history.length})</button>
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
                <DownloadAction prepare={() => ({ blob: encodeWav(asset.samples, 48000), filename: `${stem(asset.name)}-48khz-mono.wav` })}>WAV <span>48 kHz source</span></DownloadAction>
                <DownloadAction prepare={() => prepareSegmentExport('csv')}>CSV <span>Timing labels</span></DownloadAction>
                <DownloadAction prepare={() => prepareSegmentExport('json')}>JSON <span>Full analysis</span></DownloadAction>
                <DownloadAction prepare={() => prepareSegmentExport('txt')}>TXT <span>Assignment report</span></DownloadAction>
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
