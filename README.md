# WorkLens

WorkLens는 XLSX, CSV, PDF, DOCX, PPTX 파일을 **브라우저 안에서** 분석·비교·검수·추출하는 임시 문서 작업 공간입니다.

- 파일 원본과 파싱 결과는 탭의 메모리에만 존재하며 서버로 업로드되지 않습니다.
- 새로고침하거나 탭을 닫으면 모든 작업 데이터가 즉시 사라집니다.
- 로그인, 서버 세션, 쿠키, localStorage, IndexedDB를 사용하지 않습니다.
- Analyze, Compare, Check, Extract, 내보내기는 Web Worker에서 AI 없이 동작합니다.
- Local AI는 선택 계층입니다. 외부 유료 AI API는 호출하지 않으며, 사용할 수 없으면 deterministic 기능만 계속 동작합니다.
- 모든 결과는 파일, 문서 버전, 노드, 원문 위치를 `SourceRef`로 보존합니다.

**프로덕션:** https://worklens.puleun58.workers.dev

## 1. 아키텍처

| 영역 | 실행 위치 | 비고 |
| --- | --- | --- |
| 파일 검증(확장자/매직/ZIP 구조) | 브라우저 Web Worker | `src/lib/upload.ts` |
| 파싱(XLSX·CSV·PDF·DOCX·PPTX) | 브라우저 Web Worker | `src/lib/parsers/*` |
| Analyze / Check / Extract / Compare | 브라우저 Web Worker | `src/lib/deterministic.ts`, `src/lib/check.ts`, `src/domain/compare.ts` |
| CSV·XLSX 내보내기 | 브라우저 Web Worker | `src/lib/export.ts` |
| Ask / Brief / Local AI 보조 | `POST /api/ai` (stateless) | 브라우저가 문서를 함께 보냄, 저장 없음 |
| 정적 호스팅 | Cloudflare Workers + Assets | KV·R2에 사용자 데이터 저장 없음 |

- 문서 처리기는 `src/client/document-worker.ts` 하나이며, 메인 스레드는 `src/client/document-client.ts`로만 통신합니다.
- 파싱된 문서는 워커 메모리의 `Map`에만 있고, "모두 삭제"는 워커를 종료(`terminate`)해 즉시 폐기합니다.
- `/api/ai`는 세션·쿠키·CSRF를 사용하지 않고, same-origin 검사와 8 MiB 본문 상한만 적용합니다. 모든 주장(claim)은 서버에서 문서 근거와 대조해 검증되며, 검증되지 않으면 결과 전체를 거부합니다.

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
bun run test         # vitest: 파서, 도메인, Check, AI grounding
bun run test:e2e     # Playwright: 업로드 → Analyze/Compare/Check/Extract → 근거 → 새로고침 폐기
```

## 5. Check 기능

Check는 제출 전 최종 검수 도구입니다. 네 영역을 한 번에 점검하고 Critical / Warning / Suggestion으로 분류합니다.

- **Writing**: 한글 오타·띄어쓰기, 영문 철자, 중복 단어·문자·문장부호, 비정상 공백, 긴 문장, 종결 어미 불일치, 중복 문장, placeholder(`TODO`, `TBD`, `Lorem ipsum` 등)
- **Consistency**: 용어 표기 혼용, 영문 대소문자 혼용, 슬라이드 제목 표기, DOCX heading 계층·번호 체계
- **Data**: 날짜 형식·불가능한 날짜·기준일/보고월 충돌, 통화·단위·백분율·천 단위 표기, 동일 항목 수치 충돌, 연속 데이터 누락, 합계 불일치, 중복 값, 빈 셀·빈 행
- **Privacy**: 이메일, 전화번호, 주민등록번호 형태, 계좌번호, 사번, 내부 URL, IP, 인증 토큰

각 Finding은 `issue`, `category`, `severity`, `reason`, `recommendation`, `source`, 가능한 경우 `originalText`/`suggestedText`를 포함하며, 같은 문제를 여러 규칙이 보고하면 하나로 병합합니다. 결과는 Severity·Category 필터가 있는 표로 표시되고 각 행에서 원문·추천 문구·근거 위치를 확인할 수 있습니다.

Local AI를 사용할 수 없으면 "문장/맞춤법 기반 고급 검수는 현재 사용할 수 없습니다"를 표시하고 deterministic 검수는 정상 수행합니다.

## 6. 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `WORKLENS_ORIGIN` | 요청 origin | `/api/ai`의 same-origin 검사 기준 |
| `WORKLENS_MAX_FILE_BYTES` | `52428800` | 파일당 상한. 형식별 상한(CSV 10 MiB, DOCX·PPTX 20 MiB, XLSX·PDF 50 MiB)과 함께 적용 |
| `WORKLENS_AI_URL` | 미설정 | Local AI 엔드포인트. loopback 또는 사설 대역만 허용 |
| `WORKLENS_AI_HOSTS` | 미설정 | 추가 허용 호스트 |
| `WORKLENS_AI_SERVICE_IDENTITY` | 미설정 | Local AI 상호 인증 식별자 |
| `WORKLENS_AI_MTLS_CERT_PEM` / `WORKLENS_AI_MTLS_KEY_PEM` | 미설정 | Local AI mTLS 자격 증명 |

Local AI 변수가 없으면 Ask/Brief/AI 보조는 503으로 degrade하고 나머지 기능은 그대로 동작합니다.

## 7. Cloudflare 배포

```bash
bun run deploy      # vinext 빌드 후 wrangler deploy
```

`wrangler.jsonc`는 정적 asset과 `/api/ai` 라우팅만 설정합니다. 사용자 파일·세션·작업 상태를 저장하는 바인딩은 사용하지 않습니다.

## 8. 브라우저 요구 사항

- ES module Web Worker 지원 브라우저(최신 Chrome, Edge, Firefox, Safari)
- 파일 크기가 클수록 탭 메모리를 사용합니다. 50 MiB 상한은 브라우저 메모리를 기준으로 정해져 있습니다.
