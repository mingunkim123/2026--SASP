# SASP Lab

브라우저에서 바로 사용하는 범용 음성·오디오 신호 처리 대시보드입니다. 2026 Speech and Audio Signal Processing 과제의 녹음, 다운샘플링 비교, 신호 시각화, voiced/unvoiced/background 분류와 결과 내보내기를 한 화면에서 수행합니다.

## 주요 기능

- 마이크 녹음: `48 kHz · mono` 제약을 요청하고, 최대 2분에서 자동 종료한 뒤 정확한 48 kHz mono PCM으로 표준화
- 오디오 가져오기: 브라우저가 디코딩할 수 있는 WAV, MP3, M4A, AAC, OGG, WebM, FLAC 파일을 최대 2분까지 지원
- 다운샘플링: 48/16/8/2 kHz 버전을 anti-alias resampling으로 생성하고 즉시 비교 재생 및 WAV 저장. Web Audio가 직접 허용하지 않는 2 kHz는 windowed-sinc 변환 및 호환 재생 경로 사용
- 신호 분석: 파형, 스펙트로그램, RMS, peak dBFS, median pitch, spectral centroid, noise floor 표시. 드래그 구간 확대, 휠 확대, 키보드 이동을 모든 시간축 그래프에서 동기화
- 고급 음성 분석: 연속 F0 contour, cycle-synchronous local jitter/shimmer, HNR, voiced ratio
- 성도·특징 분석: order-18 LPC 기반 F1/F2/F3 formant track과 13차 MFCC, Δ, Δ² cepstrogram
- 자동 분할: background(0), unvoiced(1), voiced(2) 구간 및 confidence 생성
- 수동 교정: 각 구간의 시작/끝 시각과 class ID를 표에서 수정하거나 새 구간 추가/삭제
- 처리 도구: normalize, DC 제거, pre-emphasis, reverse, 4차 Butterworth high/low/band-pass, attack/release noise gate, 최근 4단계 undo
- 내보내기: 48 kHz mono WAV, 구간 CSV, 고급 frame feature를 포함한 전체 분석 JSON, 과제 제출용 TXT report
- 개인정보 보호: 녹음, 분석, 변환, 파일 생성이 모두 브라우저 안에서 실행되며 오디오 서버 업로드 없음

## 실행

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 마이크 녹음은 브라우저 권한과 secure context(`localhost` 또는 HTTPS)가 필요합니다.
내장 미리보기 브라우저에서 마이크 입력을 제공하지 않는 경우 Chrome 또는 Edge에서 같은 주소를 열거나 `Upload audio`를 사용하세요.

프로덕션 빌드:

```bash
npm run lint
npm run build
npm run start
```

## 과제 사용 순서

1. 화면의 **Assignment recording script**를 열고 `Start recording`을 눌러 문장을 읽습니다.
2. 48, 16, 8, 2 kHz 카드를 차례로 재생합니다. Nyquist bandwidth와 sample count, 파일 크기 차이를 함께 기록합니다.
3. waveform/spectrogram/features 탭에서 신호를 확인하고 필요한 구간을 드래그해 확대합니다.
4. Advanced DSP의 Voice/F0, LPC formants, MFCC-13 탭에서 운율·음질·성도 공명·음향 특징을 비교합니다.
5. 자동 분할 결과를 듣고 표에서 경계와 class를 교정합니다.
6. 필요하면 speech-band filter나 noise gate를 적용한 뒤 `TXT Assignment report`와 CSV/JSON/WAV를 내려받습니다.

## 자동 분할 알고리즘

기본 분석 단위는 25 ms frame, 10 ms hop입니다.

1. 각 frame의 RMS energy와 zero-crossing rate(ZCR)를 계산합니다.
2. 정규화 autocorrelation에서 70–400 Hz 범위의 최적 lag를 찾아 periodicity와 pitch를 추정합니다.
3. frame energy의 20 percentile을 robust noise floor로 사용해 입력마다 speech threshold를 적응시킵니다.
4. threshold 아래는 background(0), 충분히 periodic하고 pitch 범위가 타당한 speech는 voiced(2), 나머지 speech는 unvoiced(1)로 분류합니다.
5. 5-frame local voting을 두 번 적용해 짧은 label flicker를 줄입니다.

Energy margin과 voicing periodicity는 UI에서 조절할 수 있습니다. 이 방법은 설명 가능한 DSP baseline이며 음소 인식 모델이 아닙니다. 음악, 잔향, clipping, 여러 화자, 시간에 따라 달라지는 잡음에서는 오차가 커질 수 있으므로 최종 제출 전 사람이 파형·스펙트로그램·재생 결과로 경계를 확인해야 합니다.

## 고급 분석 알고리즘

고급 분석은 anti-alias resampling으로 만든 16 kHz wideband 신호를 기준으로 하며, jitter와 shimmer의 pitch mark만 48 kHz 원 신호에서 추적합니다.

- **F0 / HNR**: 40 ms frame, 10 ms hop에서 YIN cumulative mean normalized difference의 첫 신뢰 가능한 minimum을 포물선 보간하고 normalized autocorrelation으로 검증합니다. 이 방식은 배음·subharmonic에 의한 octave error를 줄입니다. 신뢰도가 낮거나 에너지가 부족한 frame은 F0를 그리지 않으며 HNR은 검증된 lag의 자기상관비에서 계산합니다.
- **Jitter / shimmer**: 연속 voiced run 안에서 예상 pitch period 주변의 peak mark를 추적해 cycle period와 peak-to-peak amplitude의 국소 변동률을 구합니다. 유효 cycle이 부족하면 숫자 0 대신 `Not reliable`을 표시합니다.
- **LPC formants**: 0.97 pre-emphasis와 25 ms Hamming window, order-18 Levinson–Durbin LPC를 사용하고 spectral envelope의 타당한 peak를 F1–F3로 추적합니다.
- **MFCC-13**: 25 ms frame, 10 ms hop, 512-point FFT, 26개 mel triangular filter, log energy, orthonormal DCT-II로 C0–C12를 만들고 Δ와 Δ²를 함께 계산합니다.
- **필터링**: 4차 Butterworth는 서로 다른 Q의 두 biquad pole pair를 cascade합니다. Noise gate는 5 ms attack과 120 ms release envelope로 hard switching click을 줄입니다.

Jitter, shimmer, HNR과 formant는 녹음 상태에 민감한 공학적 추정치이며 의료·임상 진단값이 아닙니다.

## 검증

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

DSP 테스트는 seeded silence/voiced/noise 분류, 70–400 Hz F0 경계와 octave 회피, fractional-lag HNR, 알려진 cycle perturbation의 jitter/shimmer와 다중 voiced-run 정규화, MFCC 이득 법칙과 native-hop Δ/Δ², LPC formant 복원, Butterworth 대역 억제·선형성, noise-gate attack/release, 2 kHz Web Audio 호환 resampling을 확인합니다.

## 기술 구성

- Vinext / React / TypeScript
- Web Audio API, MediaRecorder API, OfflineAudioContext
- Canvas 기반 waveform, spectrogram, F0/formant/MFCC feature plot
- 외부 분석 API 및 서버 저장소 없음

기본 DSP는 [`app/dsp.ts`](app/dsp.ts), 고급 분석·필터는 [`app/advanced-dsp.ts`](app/advanced-dsp.ts), canvas plot은 [`app/plots.tsx`](app/plots.tsx), 대시보드 UI와 녹음 흐름은 [`app/page.tsx`](app/page.tsx)에 있습니다.
