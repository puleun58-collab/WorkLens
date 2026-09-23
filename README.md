# WorkLens

WorkLens는 XLSX, CSV, PDF, DOCX, PPTX 파일을 브라우저에서 파싱하고, 필요한 경우에만 제한된 근거 창을 서버 AI로 보내 분석·질문·검수·윤문·추출하는 임시 문서 작업 공간입니다.

- 파일 원본과 파싱 결과는 탭의 Web Worker 메모리에만 존재하며 서버로 업로드되지 않습니다.
- 새로고침하거나 탭을 닫으면 모든 작업 데이터가 즉시 사라집니다.
- `localStorage`에는 개인 사전 단어와 무시한 규칙 ID만 저장합니다. 문서 본문·파싱 결과·Finding·근거·질문·답변은 저장하지 않습니다.
- Analyze, Compare, Check, Extract의 deterministic 경로와 내보내기는 브라우저 Web Worker에서 AI 없이 동작합니다.
- Analyze의 deterministic 결과는 브라우저 Web Worker에서 계산하고, 핵심 요약·관계형 인사이트는 필요한 경우 한 번의 서버 Groq `openai/gpt-oss-20b` 요청으로 보강합니다. Ask / Polish / AI 문장 검수 / Extract 의미 기반 항목 탐색도 서버 AI를 사용합니다. 문서 전체가 아니라 최대 40개의 검색된 근거만 전송하며, Ask·검수는 5,000자, Analyze는 10,000자 이내입니다.
- 모든 근거 기반 결과는 파일, 문서 버전, 노드, 원문 위치를 `SourceRef`로 보존합니다.

**프로덕션:** https://worklens.puleun58.workers.dev

## 1. 아키텍처

| 영역 | 실행 위치 | 비고 |
| --- | --- | --- |
| 파일 검증(확장자/매직/ZIP 구조) | 브라우저 Web Worker | `src/lib/upload.ts` |
| 파싱(XLSX·CSV·PDF·DOCX·PPTX) | 브라우저 Web Worker | `src/lib/parsers/*` |
| Analyze / Check / Extract / Compare | 브라우저 Web Worker | `src/lib/deterministic.ts`, `src/lib/check/`, `src/lib/extract/`, `src/domain/compare.ts` |
| CSV·XLSX 내보내기 | 브라우저 Web Worker | `src/lib/export.ts`, `src/lib/extract/export.ts` |
| 근거 검색·canonical grounding | 브라우저 Web Worker | `src/client/document-worker.ts`, `src/lib/ai/{retrieval,grounding}.ts` |
| Analyze 보강 / Ask / Polish / AI 문장 검수 / Extract 보조 탐색 | 동일 origin API → Groq | `src/app/api/ai/route.ts`, `src/server/groq.ts`, 고정 모델 `openai/gpt-oss-20b` |
| 호스팅 | Cloudflare Workers + Assets | D1은 공용 용어만 저장. 사용자 작업 데이터 저장 없음 |

- 파싱된 문서는 문서 워커 메모리의 `Map`에만 있고, "모두 삭제"는 워커를 종료해 즉시 폐기합니다.
- 근거 검색은 문서를 이미 들고 있는 문서 워커에서 수행합니다. 문서 전체를 순회해 최대 320개의 후보를 유지한 뒤 BM25-lite 점수와 출처 균형으로 관련 근거를 선택합니다. 앞부분 5,000개 노드에서 검색을 종료하지 않습니다.
- 모델은 `E1`, `E2` 같은 짧은 핸들과 텍스트만 봅니다. 파일 ID, 노드 ID, canonical 근거 토큰과 전체 문서는 전송하지 않습니다.
- 모델 응답의 핸들은 문서 워커에서 canonical 근거 토큰으로 되돌린 뒤 검증합니다. 알 수 없는·중복 근거, 프롬프트 주입 문구, 근거에 없는 숫자·날짜·금액·식별자가 하나라도 있으면 결과 전체를 거부합니다.
- `/api/ai`는 same-origin, JSON content type, 64 KiB 본문, 기능별 strict 요청 스키마, 프로세스 동시 작업 4개, IP별 분당 120회 한도를 강제합니다. 클라이언트는 provider URL·모델·임의 메시지를 지정할 수 없습니다.
- Groq 요청은 서버에서만 생성되고 API 키는 응답·클라이언트 번들·로그에 포함되지 않습니다. 로그에는 작업 종류, 지연 시간, 토큰 수만 기록합니다.

분석은 한 번 실행하면 근거가 연결된 **핵심 요약 → 문서 주요 내용·확인된 수치 → 분석 인사이트** 순서로 결과를 보여줍니다. 관계가 확인되지 않으면 인사이트 영역을 표시하지 않습니다. AI가 실패해도 deterministic 결과는 유지하며 `기본 분석 완료`로 상태를 표시합니다. 별도의 요약 메뉴나 요약 방식 선택은 없습니다.

## 2. 설치

요구 사항: Bun 1.4.1 이상, Git. E2E 테스트에는 Playwright 브라우저가 필요합니다.

```bash
git clone https://github.com/puleun58-collab/WorkLens.git
cd WorkLens
bun install
bunx playwright install chromium firefox   # E2E 실행 시에만
```

## 3. 실행

Next 개발 서버는 루트 `.env.local`을 읽습니다.

```bash
# .env.local (gitignore 대상)
GROQ_API_KEY=gsk_...

bun run dev      # http://localhost:3000
bun run build    # 프로덕션 빌드
bun run start
```

Cloudflare 로컬 런타임은 `.dev.vars`를 사용합니다.

```bash
# .dev.vars (gitignore 대상)
GROQ_API_KEY=gsk_...

bun run build:vinext
bun run start:vinext
```

`assets:pdf`가 `pdfjs-dist` 워커를 `public/pdf.worker.mjs`로 복사합니다. 브라우저 파서가 이 파일을 로드합니다.

## 4. 검증

```bash
bun run typecheck
bun run lint
bun run test
bunx vitest run tests/ai.test.ts tests/server-ai.test.ts
bun run test:eval:retrieval
bun run test:eval:grounding
bun run test:e2e
bun run bench:large
bun run bench:stress -- --format=xlsx --size=50
```

`tests/server-ai.test.ts`는 기능별 입력 제한, 임의 provider proxy 차단, 고정 모델, strict JSON Schema, 안전한 rate-limit 오류와 content-free 로그를 검증합니다. `tests/ai.test.ts`는 근거 토큰 복원, 프롬프트 주입 거부, 근거에 없는 숫자·날짜·금액·식별자의 원자적 거부를 검증합니다.

실제 Groq smoke는 로컬 서버에 최소 근거 1개를 보내 `/api/ai`의 200 응답과 근거 핸들을 확인합니다. 무료 플랜 한도를 소모하므로 기본 테스트에는 포함하지 않습니다.

`bench:stress`는 어떤 CI·검증 명령에도 연결되어 있지 않습니다. 8 GiB 워크스테이션에서는 브라우저 파싱·검색·deterministic 경로만 물리 메모리 검증 대상입니다. AI 모델은 서버에서 실행되므로 브라우저 GPU·WebGPU·모델 다운로드 검증은 없습니다.

평가셋은 `tests/eval/`에 있습니다. XLSX·CSV·PDF·DOCX·PPTX 업무 문서의 사실·숫자·날짜·백분율·위치 지정·답변 불가 케이스를 코드로 채점합니다. Ask는 모델 호출 전에 관련성 게이트를 통과해야 하고, grounding 평가는 canonical source와 값 보존을 별도로 측정합니다.

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
- 규칙 계층: deterministic 규칙(`src/lib/check/{writing,terminology,data,privacy,structure}`) → 기본 언어 사전 → 공용 사전 → 개인 사전 → Grounded Semantic Layer.

"AI 문장 검수" 결과는 Check 목록에 Suggestion으로만 합쳐지고 deterministic 결과보다 우선하지 않습니다. Provider 오류가 발생해도 기존 deterministic 검수 결과는 유지됩니다.

## 6. Polish 기능

Polish는 제출 전 문장을 다듬는 기능입니다. Check가 문제를 찾고, Polish가 문장을 고칩니다.

- 모드 3종: **기본 윤문**(최소 수정) · **간결하게**(중복·우회 표현 축소) · **업무 문체**(보고서·공지·메일 문장). 세 모드 모두 사실 보존 규칙은 같습니다.
- 문서 전체를 한 번에 재작성하지 않습니다. 문서 워커가 산문 노드만 골라내고(`src/lib/polish/candidates.ts`), 문장·문단 단위로 한 건씩 서버 AI에 보냅니다.
- 텍스트 윤문 입력은 최대 10,000자이며, 줄·문장별 최대 600자씩 나누어 처리합니다. 파일 윤문 후보 수 제한과 무관하고 목록 표시·빈 줄·원문 순서를 유지합니다.
- 모든 결과는 `src/lib/polish/protect.ts`가 다시 검증합니다. 숫자·금액·비율·날짜·시간·단위·이메일·URL·코드가 달라지거나, 직접 인용이 바뀌거나, 가능성/의무/요청/예정/부정의 강도가 달라지거나, 원문이 절반 이상 사라지면 결과를 적용하지 않고 원문을 유지합니다.
- `changed: false`는 정상 결과입니다. 이미 자연스러운 문장은 그대로 둡니다.
- Ask 답변, Analyze의 핵심 요약·인사이트, Check 수정안, Extract 문단에서도 같은 엔진을 쓰는 `윤문` 인라인 액션을 제공합니다. SourceRef와 EvidenceBinding은 그대로 유지됩니다.
- 규칙 출처와 라이선스 고지는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다.

## 7. Extract 기능

Extract는 문서에서 필요한 정보를 필드/값으로 구조화해 표로 만드는 기능입니다.

- **자동 추출**: 문서가 명시한 라벨/값(문단의 `라벨: 값`, 2열 표)과 반복 표를 찾아 `FIELD / VALUE / TYPE / SOURCE`로 정리합니다. 반복 표는 필드로 쪼개지 않고 표 구조를 유지합니다.
- **항목 지정 추출**: 원하는 항목명을 직접 입력하면 같은 스키마로 여러 파일을 취합합니다. 결과는 한 파일 = 한 행 구조이며 XLSX에서 그대로 사용할 수 있습니다.
- **전체 텍스트 내보내기**: 기존의 문단·표 전체 덤프는 이 보조 모드로 이동했습니다.
- deterministic 우선: 문서가 명시한 값은 모델 없이 추출하고, 답이 없는 항목만 항목별 bounded 근거 창으로 서버 AI에 질의합니다. 근거 창에 없는 값은 버리고 `찾지 못함`으로 남깁니다.
- 원문 표기를 유지하고(`displayValue`), 해석이 확실한 경우에만 `normalizedValue`를 덧붙입니다. 만원·억원처럼 단위 해석이 필요한 금액은 변환하지 않습니다.
- XLSX는 `Extracted Data` + `Evidence`(+ 반복 표가 있으면 `Records`) 시트로 내보내고, CSV는 같은 표에 SOURCE 열을 포함합니다. 구조화 결과가 생성된 뒤에만 다운로드가 활성화됩니다.

## 8. 취합 기능

취합은 선택한 XLSX·XLSM 파일의 반복 표를 같은 업무 구조별로 묶어 하나의 XLSX로 만듭니다. CSV·PDF·DOCX·PPTX는 취합 입력에서 제외하며, 다른 기능의 파일 지원은 그대로입니다.

- 병합된 다단 헤더는 `Figure > Before`처럼 부모·자식 항목을 구분합니다. 월·날짜 열만 달라지는 동일 표는 한 결과 시트에서 기간 열을 합치고, 구조가 다른 표는 분리합니다. 이름이 다른 확실한 매칭과 구조 충돌은 결과 화면에서 확인할 수 있습니다.
- 각 결과 시트는 선택 순서에서 처음 만난 호환 파일의 양식을 따릅니다. 본문에 출처·상태·이미지 전용 열을 추가하지 않고, 연결된 이미지는 해당 레코드의 원래 업무 열에 둡니다. 연결할 위치가 불명확한 이미지만 `첨부 이미지` 시트에 표시합니다.
- 날짜 형식이 확인된 값은 실제 Excel 날짜로 내보내고 첫 양식의 표시 형식(`m/d` 등)을 유지합니다. 일반 숫자는 날짜로 변환하지 않습니다. PNG·JPEG·GIF 이외의 이미지가 포함되면 누락된 결과를 다운로드시키지 않고 오류를 표시합니다.
- 레코드 이미지는 비율을 유지한 중앙 crop으로 셀 또는 병합 셀 전체를 채우며, 여러 장이면 여백 없는 타일로 배치합니다. 기준 표의 마지막 외곽 테두리는 레코드가 늘어나면 새 마지막 행으로 옮깁니다.
- 기준 열의 값이 안전한 연속 패턴(예: `BP-08-01`, `BP-08-02`)이면 헤더가 `R`이어도 추가 레코드에 순번을 이어 붙이고, 결과 미리보기에도 같은 번호를 표시합니다. 비연속 기준 값이나 날짜·금액·비율·수량·고유 ID·수식 결과는 자동 보정하지 않습니다. 기준 파일의 조건부 서식 규칙은 레코드 범위가 확장된 결과 XLSX에도 유지합니다.
- 원본 패키지를 복사하거나 매크로·외부 링크를 실행하지 않습니다. 저장된 값과 안전한 서식·이미지만 새 통합 문서에 재구성하며 취합 과정에 AI를 호출하지 않습니다.

## 9. 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GROQ_API_KEY` | 미설정 | 서버 전용 Groq API 키. 없으면 AI API는 `AI_NOT_CONFIGURED`로 실패 |
| `WORKLENS_ORIGIN` | 요청 origin | 관리자 API의 origin 검사 기준 |
| `WORKLENS_MAX_FILE_BYTES` | `104857600` | 파일당 상한(최대 100 MiB) |
| `WORKLENS_ADMIN_PASSWORD` | 미설정 | 공용 용어 사전 관리자 로그인 |
| `WORKLENS_ADMIN_SESSION_SECRET` | 미설정 | 관리자 세션 서명 키 |

`GROQ_API_KEY`를 `NEXT_PUBLIC_*`, `wrangler.jsonc`의 `vars`, Git 추적 파일에 넣지 않습니다. Next 로컬은 `.env.local`, Wrangler 로컬은 `.dev.vars`, 프로덕션은 Cloudflare secret을 사용합니다.

### 데이터가 사는 곳

| 데이터 | 위치 | 비고 |
| --- | --- | --- |
| 업무 문서 원본·파싱 결과·canonical 근거 | 탭의 Web Worker 메모리 | 서버·D1·KV·R2·localStorage·IndexedDB에 저장하지 않음 |
| AI 요청에 필요한 질문·문장·bounded 근거 | Groq API로 일시 전송 | WorkLens는 저장하지 않음. Groq 계정의 Data Controls/ZDR 설정 적용 |
| 공용 용어 | Cloudflare D1 (+ JSON seed fallback) | 용어 문자열만, 문서 내용 없음 |
| 개인 용어·무시한 규칙 ID | 브라우저 `localStorage` | 이 브라우저 전용, 동기화 없음 |

Groq는 추론 입력·출력을 기본적으로 영구 보관하지 않지만 서비스 안정성·오남용 탐지를 위해 최대 30일 임시 보관할 수 있습니다. Chat Completions는 Zero Data Retention 대상입니다. 운영 전 Groq Console의 Data Controls에서 실제 계정 설정을 확인합니다.

## 10. Cloudflare 배포

```bash
bun run build:vinext
bunx wrangler secret put GROQ_API_KEY --config dist/server/wrangler.json
bunx wrangler deploy --config dist/server/wrangler.json
```

이후에는 `bun run deploy`로 같은 Worker를 갱신합니다. `wrangler.jsonc`는 정적 asset, 공용 용어 D1, 비민감 origin 값만 선언합니다. 사용자 파일·세션·작업 상태를 저장하는 바인딩은 사용하지 않습니다.

## 11. 브라우저 요구 사항

- ES module Web Worker 지원 브라우저(최신 Chrome, Edge, Firefox, Safari)
- 파일 크기가 클수록 탭 메모리를 사용합니다. 파일당 100 MiB, 작업 공간 합계 300 MiB 상한은 브라우저 메모리를 기준으로 정해져 있습니다.
- 본문 폰트는 self-hosted Pretendard Variable(`public/fonts/pretendard/ + unicode-range 동적 서브셋`, SIL OFL 1.1)이며 외부 CDN을 사용하지 않습니다.

## 12. Testing

```bash
bun run test:e2e:cloudflare  # vinext build + local Wrangler Worker E2E
WORKLENS_SMOKE_URL=https://worklens.example.com bun run test:smoke
```
