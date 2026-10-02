# WorkLens

WorkLens는 XLSX, CSV, PDF, DOCX, PPTX 파일을 브라우저에서 읽어 분석·질문·비교·검수·윤문·추출·취합하는 임시 문서 작업 공간입니다. 원본 문서는 서버에 저장하지 않으며, AI가 필요한 기능만 제한된 근거를 서버 AI로 보냅니다.

**Production:** https://worklens.puleun58.workers.dev

## 주요 기능

- **분석** — 핵심 요약, 주요 내용, 확인된 수치를 근거와 함께 정리
- **질문** — 선택한 파일을 근거로 답변
- **비교** — 두 버전의 변경 사항, 여러 파일의 값 일치 확인
- **검수** — 문장·일관성·데이터·개인정보·보안정보 점검
- **보완** — PPTX, PDF, XLSX, DOCX 보고자료에서 빠진 비교 기준·원인·영향·대응·담당·일정·결론 근거를 찾고, 예상 질문과 분석 범위를 함께 표시
  - 실행 정보의 누락은 AI가 `found`로 응답해도 인용 원문이 금액·기한·특정 담당·구체 범위를 실제 제공할 때만 해소합니다. 근거 없는 응답이나 견적·협의 후 확정한다는 언급만 있으면 확인 필요로 보존합니다.
- **윤문** — 파일 또는 붙여넣은 텍스트의 문장 다듬기
- **추출** — 항목과 값을 표로 정리해 CSV/XLSX로 내보내기
- **취합** — 여러 XLSX의 반복 표를 첫 번째 파일 서식 기준으로 하나의 XLSX로 취합
- **법령** — 법령·판례·결정례 검색, 인용 검증, 종합 리서치. 문서 검토는 선택한 작업 파일 전체를 브라우저에서 검토 후보 탐색한 뒤, 후보 조항과 고르게 선택한 범위의 원문만 서버에서 다시 검토하고 검토 범위·원문 위치·확인된 법령 근거를 표시합니다. 원본 문서 뷰어가 없는 형식은 위치만 표시합니다.
- **PDF 도구 / 이미지 도구** — 페이지·이미지 편집과 내보내기. 이미지 도구에서는 체크한 여러 이미지의 크기와 회전을 일괄 변경할 수 있습니다. 비율 유지는 각 이미지의 현재 비율을 따르며, 자르기·모자이크는 미리보기의 한 이미지에만 적용됩니다.

기능별 사용 순서는 앱의 `사용 가이드`에서 확인할 수 있습니다.

## 데이터 처리

- 파일 원본과 파싱 결과는 브라우저 탭 메모리에서만 처리하며, 새로고침하거나 탭을 닫으면 사라집니다.
- 문서 본문, 분석 결과, 질문과 답변은 브라우저 저장소에 저장하지 않습니다. `localStorage`에는 개인 사전 단어와 무시한 규칙 ID만 저장합니다.
- AI 기능(분석 보강, 질문, 윤문, AI 문장 검수, 추출 보조, 보완 재확인)은 문서 전체가 아니라 필요한 근거 일부만 서버를 거쳐 Groq로 전송합니다. WorkLens는 이를 저장하지 않습니다.
- 법령 검색은 검색어와 조회 조건만 법령 서비스로 전송합니다. 문서 검토는 선택한 파일에서 추출한 텍스트 중 최대 100,000자와 위치 문자열·문서 ID/버전을 작업 서버에 보내 근거를 조회합니다. 원본 파일 바이너리와 브라우저 내부 SourceRef는 보내지 않습니다. 검토에서 제외된 범위와 텍스트를 읽지 못한 페이지는 결과에 표시합니다.
- 서버 저장소는 공용 용어 사전(Cloudflare D1)뿐입니다.

## 지원 형식

| 기능 | 지원 형식 |
| --- | --- |
| 문서 작업 | XLSX, CSV, PDF, DOCX, PPTX |
| 취합 | XLSX |
| 보완 | PPTX, PDF, XLSX, DOCX |
| PDF 도구 | 입력 PDF · 출력 PDF, JPG, PNG |
| 이미지 도구 | 입력 JPG, JPEG, PNG, WebP · 출력 JPG, PNG, WebP, PDF |

파일당 최대 100 MB, 작업 공간 합계 최대 300 MB, 최대 10개 파일입니다. 스캔 PDF의 이미지 속 글자는 읽지 않습니다(OCR 없음).
PDF 도구는 이 파일·용량 제한에 더해 작업 공간에서 최대 1,000페이지까지 편집할 수 있습니다.

## 개발 실행

요구 사항: Bun 1.4.1 이상.

```bash
git clone https://github.com/puleun58-collab/WorkLens.git
cd WorkLens
bun install
bun run dev      # http://localhost:3000
```

프로덕션 빌드는 `bun run build` 후 `bun run start`로 실행합니다.

### 환경 변수

| 변수 | 설명 |
| --- | --- |
| `GROQ_API_KEY` | 서버 AI 사용. 없으면 AI 기능만 비활성 |
| `GROQ_EVAL_API_KEY` | `eval:supplement:live` 전용 키. 운영 키(`GROQ_API_KEY`)는 모델별 일일 토큰 한도를 운영 AI 기능과 공유하므로 평가에는 쓰지 않으며, 꼭 필요하면 `--shared-key`로 명시 |
| `LAW_OC`, `LAW_MCP_URL` | 법령 서비스 인증키와 주소. 없으면 법령 기능 비활성 |
| `WORKLENS_ADMIN_PASSWORD` | 공용 용어 관리자 로그인 |
| `WORKLENS_ADMIN_SESSION_SECRET` | 관리자 세션 서명 키 |
| `WORKLENS_ORIGIN` | 관리자 API의 origin 검사 기준(기본값: 요청 origin) |

Secret은 Git에 저장하지 않고 로컬은 `.env.local`(Next) / `.dev.vars`(Wrangler), 프로덕션은 Cloudflare Secrets를 사용합니다.

## 검증

```bash
bun run lint
bun run typecheck
bun run test
bun run test:e2e              # 최초 1회: bunx playwright install chromium firefox
bun run test:e2e:cloudflare
bun run test:regression       # 전체 제품 회귀 (결과 요약: bun run test:regression:report)
bun run test:law-regression   # 배포된 API 대상 법령 실데이터 회귀
bun run eval:document-review          # 문서 검토 개발 사례: 오프라인 결정적 법령 소스
bun run eval:document-review:holdout  # 별도 홀드아웃 사례
bun run eval:document-review:live --endpoint http://localhost:3000  # 설정된 실데이터 서버 대상
```

일반 PR CI는 lint, 타입 검사, 단위 테스트, E2E를 실행합니다. 전체 제품 회귀와 법령 실데이터 회귀는 릴리스 전 수동으로 실행합니다. 배포 후 점검은 `WORKLENS_SMOKE_URL=<url> bun run test:smoke`입니다.

문서 검토는 `candidate-scan-v2`로 원문 후보와 분산 범위를 선택하고 서버가 받은 원문만으로 유형·이슈·법령 대상을 판정합니다. 긴 문서의 선택 범위 밖에 있는 초반 유형 신호를 위해 짧은 원문 `classificationContext`만 보내며, 후보·분산 범위와 같은 100,000자/2,000개 segment 및 HTTP body 한도를 공유합니다. 클라이언트 profile/issue/severity 판단은 API strict schema에서 허용하지 않습니다.

문서 검토 개발 세트 26건의 baseline은 `document-review-v3`입니다. 홀드아웃 11건은 일반 `bun run test`와 coverage/CI에서 제외되며 명시적인 holdout 명령으로만 실행합니다(홀드아웃 baseline 없음). live eval은 harness와 품질 지표를 공유하며 전부 완료·무오류는 exit 0, 품질 오류는 exit 1, 조회 소스 실패·네트워크·timeout·잘못된 응답·case 미완료는 exit 2입니다. selector FN/review FN은 전체 FN의 원인 분해이므로 중복 집계하지 않습니다.

대용량 처리 검증은 `bun run bench:large`로 CSV 2만 행·XLSX 2만 셀·PDF/PPTX 120페이지·DOCX 3천 문단·비교·취합을 별도 프로세스에서 실행합니다. 파서는 실제 병합 셀 참조에 필요한 ID만 사전 계산하고, 검수의 날짜·형식·중복 그룹은 기존 배열에 추가하여 반복 복사를 피합니다. 원문 ID·해시·위치, 판정 규칙과 입력 한도는 유지합니다. benchmark의 RSS는 Bun 프로세스 측정이며 브라우저 메모리 한도를 보장하지 않습니다.

## 배포

Cloudflare Workers에 배포합니다.

```bash
bun run build:vinext
bunx wrangler secret put GROQ_API_KEY --config dist/server/wrangler.json   # 최초 1회, 다른 secret도 동일
bun run deploy
```

서드파티 라이선스는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 참고하세요.
