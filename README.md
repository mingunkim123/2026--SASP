# SASP Lab

브라우저에서 바로 사용하는 범용 음성·오디오 신호 처리 대시보드입니다. 2026 Speech and Audio Signal Processing 과제의 녹음, 다운샘플링 비교, 신호 시각화, voiced/unvoiced/background 분류와 결과 내보내기를 한 화면에서 수행합니다.

## 주요 기능

- 마이크 녹음: `48 kHz · mono` 제약을 요청하고, 녹음 완료 후 정확한 48 kHz mono PCM으로 표준화
- 오디오 가져오기: 브라우저가 디코딩할 수 있는 WAV, MP3, M4A, AAC, OGG, WebM, FLAC 파일 지원
- 다운샘플링: 48/16/8/2 kHz 버전을 anti-alias resampling으로 생성하고 즉시 비교 재생 및 WAV 저장. Web Audio가 직접 허용하지 않는 2 kHz는 windowed-sinc 변환 및 호환 재생 경로 사용
- 신호 분석: 파형, 스펙트로그램, RMS, peak dBFS, median pitch, spectral centroid, noise floor 표시
- 자동 분할: background(0), unvoiced(1), voiced(2) 구간 및 confidence 생성
- 수동 교정: 각 구간의 시작/끝 시각과 class ID를 표에서 수정하거나 새 구간 추가/삭제
- 처리 도구: normalize, DC 제거, pre-emphasis, reverse, undo
- 내보내기: 48 kHz mono WAV, 구간 CSV, 전체 분석 JSON, 과제 제출용 TXT report
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
3. waveform/spectrogram/features 탭에서 신호를 확인합니다.
4. 자동 분할 결과를 듣고 표에서 경계와 class를 교정합니다.
5. `TXT Assignment report`와 필요 시 CSV/JSON/WAV를 내려받습니다.

## 자동 분할 알고리즘

기본 분석 단위는 25 ms frame, 10 ms hop입니다.

1. 각 frame의 RMS energy와 zero-crossing rate(ZCR)를 계산합니다.
2. 정규화 autocorrelation에서 70–400 Hz 범위의 최적 lag를 찾아 periodicity와 pitch를 추정합니다.
3. frame energy의 20 percentile을 robust noise floor로 사용해 입력마다 speech threshold를 적응시킵니다.
4. threshold 아래는 background(0), 충분히 periodic하고 pitch 범위가 타당한 speech는 voiced(2), 나머지 speech는 unvoiced(1)로 분류합니다.
5. 5-frame local voting을 두 번 적용해 짧은 label flicker를 줄입니다.

Energy margin과 voicing periodicity는 UI에서 조절할 수 있습니다. 이 방법은 설명 가능한 DSP baseline이며 음소 인식 모델이 아닙니다. 음악, 잔향, clipping, 여러 화자, 시간에 따라 달라지는 잡음에서는 오차가 커질 수 있으므로 최종 제출 전 사람이 파형·스펙트로그램·재생 결과로 경계를 확인해야 합니다.

## 기술 구성

- Vinext / React / TypeScript
- Web Audio API, MediaRecorder API, OfflineAudioContext
- Canvas 기반 waveform, spectrogram, feature plot
- 외부 분석 API 및 서버 저장소 없음

핵심 DSP 구현은 [`app/dsp.ts`](app/dsp.ts), canvas plot은 [`app/plots.tsx`](app/plots.tsx), 대시보드 UI와 녹음 흐름은 [`app/page.tsx`](app/page.tsx)에 있습니다.
