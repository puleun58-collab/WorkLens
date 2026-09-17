# WorkLens

WorkLens는 XLSX, CSV, PDF, DOCX, PPTX 파일을 **브라우저 안에서** 분석·비교·검수·윤문·추출하는 임시 문서 작업 공간입니다.

- 파일 원본과 파싱 결과는 탭의 메모리에만 존재하며 서버로 업로드되지 않습니다.
- 새로고침하거나 탭을 닫으면 모든 작업 데이터가 즉시 사라집니다.
- 로그인, 서버 세션, 쿠키, IndexedDB를 사용하지 않습니다. localStorage에는 사용자가 직접 등록한 개인 사전 단어, 무시한 규칙 ID, 브라우저 AI 모델 다운로드 동의 여부만 저장하며, 문서 본문·파싱 결과·Finding·근거·질문·답변은 저장하지 않습니다.
- Analyze, Compare, Check, Extract(자동/항목 지정 중 문서에 명시된 부분), 내보내기는 Web Worker에서 AI 없이 동작합니다.
- Ask / Brief / Polish / AI 문장 검수 / Extract 의미 기반 항목 탐색은 선택 계층이며 **브라우저 안의 AI 워커**에서 실행됩니다. 외부 유료 AI API도, 별도 AI 서버도 호출하지 않습니다.
- 모든 결과는 파일, 문서 버전, 노드, 원문 위치를 `SourceRef`로 보존합니다.

**프로덕션:** https://worklens.puleun58.workers.dev

## 1. 아키텍처

| 영역 | 실행 위치 | 비고 |
| --- | --- | --- |
| 파일 검증(확장자/매직/ZIP 구조) | 브라우저 Web Worker | `src/lib/upload.ts` |
| 파싱(XLSX·CSV·PDF·DOCX·PPTX) | 브라우저 Web Worker | `src/lib/parsers/*` |
| Analyze / Check / Extract / Compare | 브라우저 Web Worker | `src/lib/deterministic.ts`, `src/lib/check/`, `src/lib/extract/`, `src/domain/compare.ts` |
| CSV·XLSX 내보내기 | 브라우저 Web Worker | `src/lib/export.ts`, `src/lib/extract/export.ts` |
| Ask / Brief / Polish / AI 문장 검수 / Extract 항목 탐색 | 브라우저 AI Web Worker (WebLLM + WebGPU) | `src/client/browser-ai-worker.ts`, 모델은 장치 메모리에 따라 `Qwen3.5-4B-q4f16_1-MLC`(약 2,290 MB) 또는 `Qwen3.5-2B-q4f16_1-MLC`(약 1,320 MB), 최초 1회 다운로드 후 브라우저 캐시 재사용 |
| 정적 호스팅 | Cloudflare Workers + Assets | KV·R2에 사용자 데이터 저장 없음 |

- 문서 처리기는 `src/client/document-worker.ts` 하나이며, 메인 스레드는 `src/client/document-client.ts`로만 통신합니다.
- 파싱된 문서는 워커 메모리의 `Map`에만 있고, "모두 삭제"는 워커를 종료(`terminate`)해 즉시 폐기합니다.
- AI 워커는 문서 처리기와 분리되어 있습니다. 모델 로딩 중에도 Analyze·Compare·Check·Extract는 그대로 동작하고, "모두 삭제"는 두 워커를 함께 종료합니다.
- 근거 검색은 문서를 이미 들고 있는 문서 워커에서 수행합니다. 전체 근거 후보에 BM25-lite 점수(키워드·숫자·날짜·금액·시트/슬라이드/페이지 라벨)를 매기고, Brief·Analyze는 섹션 단위로 균형 있게 뽑은 뒤(`src/lib/ai/retrieval.ts`) 프롬프트 창 한도를 적용합니다. "먼저 자르고 검색"하지 않습니다.
- AI 워커에는 전체 문서가 아니라 핸들과 텍스트만 담긴 압축 근거 창(최대 40개 · 5,000자)이 전달됩니다. 메인 스레드는 id만 중계하고 문서 본문을 React state에 담지 않습니다.
- 모델은 `E1`, `E2` 같은 핸들만 보고, 모델 응답의 핸들은 문서 워커에서 canonical 근거 토큰으로 되돌린 뒤 검증합니다(`src/lib/ai/grounding.ts`). 하나라도 검증되지 않으면 결과 전체를 거부합니다.
- 브라우저 캐시에는 모델 weight·런타임 asset만 남고, 업무 문서·파싱 결과·질문·Finding·근거는 어디에도 저장하지 않습니다.
- 최초 실행은 opt-in입니다. WebGPU 어댑터를 실제로 요청해 확인한 뒤 다운로드 동의를 받고, 다운로드 취소(워커 종료)와 생성 중지(`interruptGenerate`)를 구분합니다. WebGPU가 없으면 AI만 조용히 비활성화되고 deterministic 기능은 정상 동작합니다.
- 응답 헤더의 CSP(`next.config.ts`)는 브라우저 AI의 전제 조건입니다. MLC 런타임은 `WebAssembly.instantiate`로 컴파일되므로 `script-src`에 `'wasm-unsafe-eval'`이 필요하고, weight와 `model_lib` WASM은 `huggingface.co`(LFS/Xet CDN 리다이렉트 포함)와 `raw.githubusercontent.com`에서 받으므로 `connect-src`에 해당 호스트가 필요합니다. 두 directive 중 하나라도 빠지면 WebGPU가 정상이어도 모델 로드가 시작 전에 실패합니다(`tests/browser-ai-model.test.ts`가 고정).

## 2. 설치

요구 사항: Bun 1.4.1 이상, Git. E2E 테스트에는 Playwright 브라우저가 필요합니다.

```bash
git clone https://github.com/puleun58-collab/WorkLens.git
cd WorkLens
bun install
bunx playwright install chromium firefox   # E2E 실행 시에만
```

## 3. 실행

```bash
bun run dev      # http://localhost:3000
bun run build    # 프로덕션 빌드
bun run start
```

`assets:pdf` 스크립트가 먼저 실행되어 `pdfjs-dist`의 워커 파일을 `public/pdf.worker.mjs`로 복사합니다. 브라우저 파서가 이 파일을 로드합니다.

## 4. 검증

```bash
bun run typecheck
bun run lint
bun run test                 # vitest: 파서, 도메인, Check, AI grounding, 근거 검색
bun run test:eval:retrieval  # 고정 평가셋 Recall@5/10/20, 답변 불가 질문 누출 검사
bun run test:eval:grounding  # 근거 복원·숫자/날짜 정확도·허위 답변 거부율
bun run test:e2e             # Playwright: 업로드 → Analyze/Compare/Check/Extract → 근거 → 새로고침 폐기
bun run bench:large          # 저부하 문서 단계별 시간(파싱/근거/검색/연산) 측정, 케이스별 자식 프로세스
bun run bench:stress -- --format=xlsx --size=50   # 수동 전용 상한 벤치(50/75/100 MiB). 인자 없이 실행하면 사용법만 출력
bun run test:ai:model        # 선택: 최초 모델 다운로드 → 캐시 재사용까지 단계별 계측
bun run test:ai:smoke        # 선택: 캐시된 모델로 Ask/Brief/문장 검수/근거/답변 불가/재사용 검증
bun run test:ai:all          # 선택: model → smoke 순서로 전체 검증(앞 단계 실패 시 중단)
bun run test:eval:ai         # 선택: 실제 WebGPU에서 고정 품질 평가셋 채점 → artifacts/ai-eval-<model>.json
```

`bench:stress`는 어떤 CI·검증 명령에도 연결되어 있지 않습니다. 한 케이스가 수 GiB를 점유할 수 있어 `--format`/`--size`로 하나씩 실행하거나 `--all`을 명시해야만 동작하고, 픽스처 생성 직후와 각 단계마다 RSS를 확인해 예산을 넘으면 즉시 중단합니다.

브라우저 AI 실행 검증은 세 명령으로 나뉩니다. `test:ai:model`은 빈 브라우저 프로필에서 시작해 최초 다운로드 비용을 한 번만 지불하고 캐시 재사용까지 확인합니다. `test:ai:smoke`는 그 프로필에 남은 캐시된 모델로 기능만 확인합니다. `test:ai:all`은 두 명령을 순서대로 실행하며 앞 단계가 실패하면 뒤를 실행하지 않습니다. 모든 단계(페이지 로드 · WebGPU 초기화 · 업로드/파싱 · 모델 ready · 생성 · 결과)마다 시작·소요 시간을 출력하고, 대기마다 개별 상한(`WORKLENS_AI_DOWNLOAD_TIMEOUT_MS`, `WORKLENS_AI_READY_TIMEOUT_MS`, `WORKLENS_AI_GENERATE_TIMEOUT_MS`, `WORKLENS_AI_DOCUMENT_TIMEOUT_MS`)을 둡니다. 결과와 구간 시간은 `artifacts/ai-model-download-<model>.json`, `artifacts/ai-smoke-<model>.json`에 모델 ID와 함께 남습니다.

테스트는 사용자 문구가 아니라 앱이 노출하는 상태값으로 AI를 판정합니다. 최상위 `.app-shell`이 `data-ai-state`(`idle`·`checking`·`awaiting-confirmation`·`loading`·`ready`·`failed`·`unsupported`)와 실패 시 `data-ai-error`(내부 오류 코드), 그리고 하이드레이션 완료 시 `data-hydrated="true"`를 표시합니다. 문구 assertion은 사용자에게 실제로 보여야 하는 메시지를 확인하는 테스트에만 남겨 두었습니다.

WebGPU가 없으면 AI 검증 명령은 **실패**합니다(navigator.gpu·adapter·device 획득 여부와 실패 단계를 출력). WebGPU가 원래 없는 환경은 `CI` 환경변수 또는 `WORKLENS_AI_ALLOW_NO_WEBGPU=1`이 있을 때만 skip으로 처리합니다. `WORKLENS_AI_MODEL`은 지원 모델(`Qwen3.5-4B-q4f16_1-MLC`, `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`)만 허용하며, 그 외 값은 조용히 기본 모델로 대체되지 않고 즉시 오류로 끝납니다.

브라우저 AI는 장치가 감당할 수 있는 모델을 **로드 전에** 고릅니다(`src/client/browser-ai-capability.ts`). 큰 모델을 먼저 올려 보고 실패하면 줄이는 방식은 쓰지 않습니다 — 내장 GPU 환경에서는 그 시점에 이미 브라우저가 아니라 PC 전체가 멈춥니다. 판단 근거는 `navigator.deviceMemory`와 WebGPU adapter limits이며, `deviceMemory`는 2의 거듭제곱으로 반올림되고 일부 브라우저에서 8 GiB로 상한이 걸리므로 "작다"는 신호만 신뢰하고 "크다"는 값은 상한을 넘겼을 때만 인정합니다.

| 장치 신호 | 사용 모델 | 최초 다운로드 |
| --- | --- | --- |
| 보고값 > 8 GiB (여유 확인됨) | `Qwen3.5-4B-q4f16_1-MLC` 표준 | 약 2,290 MB |
| 보고값 ≤ 8 GiB 또는 미보고 | `Qwen3.5-2B-q4f16_1-MLC` 경량 | 약 1,320 MB |
| WebGPU 사용 불가 | AI 비활성화 | 없음 |

두 모델 모두 `context_window_size: 2048`로 로드합니다(prebuilt 기본값 4,096). KV 캐시는 엔진 생성 시점에 이 값으로 할당되고, WorkLens는 문서 전체가 아니라 근거 창(최대 40개 · 5,000자)만 모델에 넣기 때문에 2,048로 충분합니다. 8 GiB로 보고되는 장치에서는 표준 모델이 선택 목록에도 오르지 않으며, 그 외 환경에서는 최초 사용 화면에서 경량/표준을 직접 고를 수 있습니다. 선택은 모델 ID별 consent·캐시 키와 함께 저장되므로 경량으로 전환한 장치가 이전에 받아 둔 4B 캐시를 자동으로 다시 로드하지 않습니다.

모델 로드는 단계별로 기록됩니다(`[AI][Load][download|cache|shader|gpu-allocate|ready]`). "다운로드 완료"와 "GPU 메모리 할당"이 분리되어 있어, 다운로드가 끝난 뒤 멈추는 증상이 어느 단계에서 발생하는지 로그로 구분할 수 있습니다.

평가셋은 `tests/eval/`에 있습니다. XLSX·CSV·PDF·DOCX·PPTX 5종의 업무 문서 fixture와 79개 고정 케이스(사실·숫자·날짜·백분율·시트/슬라이드/제목 지정·교차 구간·답변 불가)를 사용하며, 정답 근거의 위치와 값을 코드로 명시해 모델 판단 없이 채점합니다. Ask는 모델 호출 전에 관련성 게이트(`askRelevance`)를 통과해야 하며, 임계값은 이 평가셋에서 answerable recall을 100%로 유지하는 값으로 맞췄습니다. 실제 모델 품질 평가(`test:eval:ai`)와 기능 점검(`test:ai:smoke`)은 서로 다른 spec/config를 사용하고 WebGPU가 필요하므로 기본 CI에는 포함하지 않습니다.

## 5. Check 기능

Check는 제출 전 최종 검수 도구입니다. 네 영역을 한 번에 점검하고 Critical / Warning / Suggestion으로 분류합니다.

- **Writing**: 한글 오타·띄어쓰기, 영문 철자, 중복 단어·문자·문장부호, 비정상 공백, 긴 문장, 종결 어미 불일치, 중복 문장, placeholder(`TODO`, `TBD`, `Lorem ipsum` 등)
- **Consistency**: 용어 표기 혼용, 영문 대소문자 혼용, 슬라이드 제목 표기, DOCX heading 계층·번호 체계
- **Data**: 날짜 형식·불가능한 날짜·기준일/보고월 충돌, 통화·단위·백분율·천 단위 표기, 동일 항목 수치 충돌, 연속 데이터 누락, 합계 불일치, 중복 값, 빈 셀·빈 행
- **Privacy**: 이메일, 전화번호, 주민등록번호 형태, 계좌번호, 사번, 내부 URL, IP, 인증 토큰

각 Finding은 `issue`, `category`, `severity`, `confidence`, `ruleId`, `reason`, `recommendation`, `source`, 가능한 경우 `originalText`/`suggestedText`/`normalizedToken`을 포함하며, 같은 문제를 여러 규칙이 보고하면 하나로 병합합니다.

- **Severity와 Confidence는 별개입니다.** Severity는 문제의 중요도(Critical/Warning/Suggestion), Confidence는 판단의 확실성(High/Medium/Low)입니다. 정렬은 Severity → Confidence → 문서 순서이며, Low는 기본적으로 숨기고 "낮은 확신 포함"으로 볼 수 있습니다.
- **대용량 결과**: `CheckResult.summary`가 `totalFound`, `returned`, `truncated`와 severity/category/confidence별 집계를 제공합니다. 상한(500건)을 넘으면 "전체 N건 중 500건 표시" 안내가 나오고 목록은 50건 단위로 페이지 처리됩니다.
- **공용 사전(Company Terms)**: Cloudflare D1(`worklens-config`)에 저장되고 `/api/company-terms`로 모든 사용자에게 같은 목록을 제공합니다. `/admin`에서 추가·수정·비활성화하며, D1을 읽지 못하면 버전 관리되는 `src/config/company-terms.json` seed로 degrade합니다. 사내 약어·제품명을 spelling/terminology 오탐에서 제외합니다.
- **개인 사전**: 브라우저 `localStorage`(`worklens:user-dictionary:v1`)에만 저장되고 서버로 전송되지 않으며 다른 브라우저와 동기화되지 않습니다. Finding 상세의 "내 용어에 추가"로 등록하면 같은 단어 기반 Finding이 즉시 사라집니다.
- 사전은 spelling/terminology 오탐 억제에만 사용합니다. 사전에 있는 단어라도 중복 단어, 개인정보, 수치 오류는 계속 검출합니다.
- 규칙 계층: deterministic 규칙(`src/lib/check/{writing,terminology,data,privacy,structure}`) → 기본 언어 사전 → 공용 사전 → 개인 사전 → Browser Semantic Layer.

브라우저 AI를 사용할 수 없으면 상태 박스에 사유만 표시하고 deterministic 검수는 정상 수행합니다. 사용할 수 있으면 "AI 문장 검수" 결과가 Check 목록에 Suggestion으로 합쳐지며, 모델이 보고한 확신도(High/Medium/Low)를 그대로 사용합니다.

## 6. Polish 기능

Polish는 제출 전 문장을 다듬는 기능입니다. Check가 문제를 찾고, Polish가 문장을 고칩니다.

- 모드 3종: **기본 윤문**(최소 수정) · **간결하게**(중복·우회 표현 축소) · **업무 문체**(보고서·공지·메일 문장). 세 모드 모두 사실 보존 규칙은 같습니다.
- 문서 전체를 한 번에 재작성하지 않습니다. 문서 워커가 산문 노드만 골라내고(`src/lib/polish/candidates.ts`), 문장·문단 단위로 한 건씩 브라우저 AI에 보냅니다.
- 모든 결과는 `src/lib/polish/protect.ts`가 다시 검증합니다. 숫자·금액·비율·날짜·시간·단위·이메일·URL·코드가 달라지거나, 직접 인용이 바뀌거나, 가능성/의무/요청/예정/부정의 강도가 달라지거나, 원문이 절반 이상 사라지면 결과를 적용하지 않고 원문을 유지합니다.
- `changed: false`는 정상 결과입니다. 이미 자연스러운 문장은 그대로 둡니다.
- Ask·Brief 답변, Check 수정안, Extract 문단에서도 같은 엔진을 쓰는 `윤문` 인라인 액션을 제공합니다. SourceRef와 EvidenceBinding은 그대로 유지됩니다.
- 규칙 출처와 라이선스 고지는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다.

## 7. Extract 기능

Extract는 문서에서 필요한 정보를 필드/값으로 구조화해 표로 만드는 기능입니다.

- **자동 추출**: 문서가 명시한 라벨/값(문단의 `라벨: 값`, 2열 표)과 반복 표를 찾아 `FIELD / VALUE / TYPE / SOURCE`로 정리합니다. 반복 표는 필드로 쪼개지 않고 표 구조를 유지합니다.
- **항목 지정 추출**: 원하는 항목명을 직접 입력하면 같은 스키마로 여러 파일을 취합합니다. 결과는 한 파일 = 한 행 구조이며 XLSX에서 그대로 사용할 수 있습니다.
- **전체 텍스트 내보내기**: 기존의 문단·표 전체 덤프는 이 보조 모드로 이동했습니다.
- deterministic 우선: 문서가 명시한 값은 모델 없이 추출하고, 답이 없는 항목만 항목별 bounded 근거 창으로 브라우저 AI에 질의합니다. 근거 창에 없는 값은 버리고 `찾지 못함`으로 남깁니다.
- 원문 표기를 유지하고(`displayValue`), 해석이 확실한 경우에만 `normalizedValue`를 덧붙입니다. 만원·억원처럼 단위 해석이 필요한 금액은 변환하지 않습니다.
- XLSX는 `Extracted Data` + `Evidence`(+ 반복 표가 있으면 `Records`) 시트로 내보내고, CSV는 같은 표에 SOURCE 열을 포함합니다. 구조화 결과가 생성된 뒤에만 다운로드가 활성화됩니다.

## 8. 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `WORKLENS_ORIGIN` | 요청 origin | 관리자 API의 origin 검사 기준 |
| `WORKLENS_MAX_FILE_BYTES` | `104857600` | 파일당 상한(최대 100 MiB). 모든 형식에 동일하게 적용되며, 행·ZIP 엔트리·압축 해제 XML 같은 구조 한도는 별도로 강제 |
| `WORKLENS_ADMIN_PASSWORD` | 미설정 | 공용 용어 사전 관리자 로그인 |
| `WORKLENS_ADMIN_SESSION_SECRET` | 미설정 | 관리자 세션 서명 키 |

AI 전용 환경 변수는 없습니다. Ask/Brief/문장 검수는 브라우저에서 실행되므로 엔드포인트·mTLS 설정이 필요하지 않습니다.

### 데이터가 사는 곳

| 데이터 | 위치 | 비고 |
| --- | --- | --- |
| 업무 문서 원본·파싱 결과·근거 | 탭의 Web Worker 메모리 | 서버·D1·KV·R2·localStorage·IndexedDB에 저장하지 않음 |
| 공용 용어 | Cloudflare D1 (+ JSON seed fallback) | 용어 문자열만, 문서 내용 없음 |
| 개인 용어·무시한 규칙 ID | 브라우저 `localStorage` | 이 브라우저 전용, 동기화 없음 |
| 브라우저 AI 동의 | 브라우저 `localStorage` (`worklens:browser-ai-consent:v1:<model-id>`) | 모델별 다운로드 허용 여부만. 동의가 있어도 모델 캐시 존재를 가정하지 않고 항상 로드를 시도 |
| AI 모델 weight·런타임 asset | 브라우저 캐시 | 모델 파일만, 업무 데이터 없음 |

## 9. Cloudflare 배포

```bash
bun run deploy      # vinext 빌드 후 wrangler deploy
```

`wrangler.jsonc`는 정적 asset과 공용 용어 사전용 D1 바인딩만 설정합니다. 사용자 파일·세션·작업 상태를 저장하는 바인딩은 사용하지 않습니다.

## 10. 브라우저 요구 사항

- ES module Web Worker 지원 브라우저(최신 Chrome, Edge, Firefox, Safari)
- 파일 크기가 클수록 탭 메모리를 사용합니다. 파일당 100 MiB, 작업 공간 합계 300 MiB 상한은 브라우저 메모리를 기준으로 정해져 있습니다.
- 본문 폰트는 self-hosted Pretendard Variable(`public/fonts/pretendard/ + unicode-range 동적 서브셋`, SIL OFL 1.1)이며 외부 CDN을 사용하지 않습니다.

## 11. Testing

```bash
bun run test:e2e:cloudflare  # vinext build + local Wrangler Worker E2E
WORKLENS_SMOKE_URL=https://worklens.example.com bun run test:smoke
```
