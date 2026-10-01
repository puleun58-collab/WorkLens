# WorkLens

WorkLens는 XLSX, CSV, PDF, DOCX, PPTX 파일을 브라우저에서 읽어 분석·질문·비교·검수·윤문·추출·취합하는 임시 문서 작업 공간입니다. 원본 문서는 서버에 저장하지 않으며, AI가 필요한 기능만 제한된 근거를 서버 AI로 보냅니다.

**Production:** https://worklens.puleun58.workers.dev

## 주요 기능

- **분석** — 핵심 요약, 주요 내용, 확인된 수치를 근거와 함께 정리
- **질문** — 선택한 파일을 근거로 답변
- **비교** — 두 버전의 변경 사항, 여러 파일의 값 일치 확인
- **검수** — 문장·일관성·데이터·개인정보·보안정보 점검
- **보완** — 보고자료에서 빠진 비교 기준·원인·영향·대응·담당·일정·결론 근거를 찾고, 예상 질문과 분석 범위를 표시
- **윤문** — 파일 또는 붙여넣은 텍스트의 문장 다듬기
- **추출** — 항목과 값을 표로 정리해 CSV/XLSX로 내보내기
- **취합** — 여러 XLSX의 반복 표를 첫 번째 파일 서식 기준으로 하나의 XLSX로 취합
- **법령** — 법령·판례·결정례 검색, 인용 검증, 종합 리서치
- **PDF 도구 / 이미지 도구** — 페이지·이미지 편집과 내보내기

기능별 사용 순서는 앱의 `사용 가이드`에서 확인할 수 있습니다.

## 데이터 처리

- 파일 원본과 파싱 결과는 브라우저 탭 메모리에서만 처리하며, 새로고침하거나 탭을 닫으면 사라집니다.
- 문서 본문, 분석 결과, 질문과 답변은 브라우저 저장소에 저장하지 않습니다. `localStorage`에는 개인 사전 단어와 무시한 규칙 ID만 저장합니다.
- AI 기능(분석 보강, 질문, 윤문, AI 문장 검수, 추출 보조, 보완 재확인)은 문서 전체가 아니라 필요한 근거 일부만 서버를 거쳐 Groq로 전송합니다. WorkLens는 이를 저장하지 않습니다.
- 법령 기능은 검색어와 조회 조건만 법령 서비스로 전송합니다.
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
```

일반 PR CI는 lint, 타입 검사, 단위 테스트, E2E를 실행합니다. 전체 제품 회귀와 법령 실데이터 회귀는 릴리스 전 수동으로 실행합니다. 배포 후 점검은 `WORKLENS_SMOKE_URL=<url> bun run test:smoke`입니다.

## 배포

Cloudflare Workers에 배포합니다.

```bash
bun run build:vinext
bunx wrangler secret put GROQ_API_KEY --config dist/server/wrangler.json   # 최초 1회, 다른 secret도 동일
bun run deploy
```

서드파티 라이선스는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 참고하세요.
