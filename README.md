# WorkLens

**WorkLens**는 문서 분석·검토·편집, 법령 리서치, 업무 자동화 진단을 한곳에서 처리하는 웹 기반 업무 도구입니다.

**서비스:** [WorkLens 바로가기](https://worklens.puleun58.workers.dev)

## 주요 기능

- **문서 작업** — 분석, 질문, 비교, 검수, 보완, 윤문, 추출, 취합
- **법령 리서치** — 법령·판례·결정례 검색, 인용 검증, 종합 리서치 및 문서 검토
- **업무 자동화 진단(AI·AX)** — 업무별 자동화 가능성 진단, 매트릭스·우선순위, 실행 로드맵 및 Codex/Claude Code 구현 지시문
- **PDF·이미지 도구** — PDF 페이지 편집, 이미지 편집 및 내보내기

기능별 사용 방법은 앱의 **사용 가이드**에서 확인할 수 있습니다.

## 지원 형식 및 제한

- **문서 작업:** XLSX, CSV, PDF, DOCX, PPTX
- **취합:** XLSX / **보완:** PPTX, PDF, XLSX, DOCX
- **이미지 도구:** JPG, JPEG, PNG, WebP
- **파일 제한:** 파일당 100 MB, 작업 공간 합계 300 MB, 최대 10개
- **PDF 편집:** 작업 공간에서 최대 1,000페이지
- **OCR:** 스캔 이미지 속 문자는 인식하지 않습니다.

## 데이터 처리

- 문서 원본은 WorkLens 서버에 저장하지 않습니다. 일반 문서 작업에 사용하는 파일과 파싱 결과는 브라우저 탭 메모리에서 처리되며, 새로고침하거나 탭을 닫으면 사라집니다.
- AI 기능을 사용할 때는 필요한 문서 내용 일부가 서버를 거쳐 **Groq**로 전송됩니다. 법령 문서 검토에서는 근거 확인을 위해 추출 텍스트 일부가 서버로 전송될 수 있습니다.
- **AI·AX**에 등록한 업무·진단 결과·구현 계획은 브라우저 **IndexedDB**에 저장되며 내보내기·가져오기를 지원합니다. 첨부 파일 원본은 저장하지 않습니다.
- 서버의 **Cloudflare D1**은 공용 용어 사전 용도로 사용합니다.

## 로컬 실행

**요구 사항:** [Bun](https://bun.sh/) 1.4.1 이상

```bash
git clone https://github.com/puleun58-collab/WorkLens.git
cd WorkLens
bun install --frozen-lockfile
bun run dev
```

실행 후 [http://localhost:3000](http://localhost:3000)에서 확인합니다.

### 환경 변수

필요한 기능에 따라 다음 값을 설정합니다.

| 변수 | 용도 |
| --- | --- |
| `GROQ_API_KEY` | 서버 AI 기능 |
| `LAW_OC`, `LAW_MCP_URL` | 법령 서비스 연동 |
| `WORKLENS_ADMIN_PASSWORD`, `WORKLENS_ADMIN_SESSION_SECRET` | 공용 용어 사전 관리자 인증 |
| `WORKLENS_ORIGIN` | 관리자 API Origin 확인 |

로컬 환경 변수는 `.env.local`에 설정할 수 있습니다. **API 키와 Secret은 Git에 커밋하지 마세요.** Cloudflare 배포 환경에서는 필요한 Secret과 바인딩을 별도로 구성합니다.

## 검증

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

브라우저 E2E 테스트가 필요하면 Playwright 브라우저를 설치한 뒤 `bun run test:e2e`를 실행합니다. 추가 테스트·평가 명령은 [package.json](package.json)을 참고하세요.

## 배포

배포 대상은 **Cloudflare Workers**입니다. Cloudflare 인증과 필요한 환경 변수·Secret·바인딩을 준비한 뒤 실행합니다.

```bash
bun run deploy
```

배포 설정은 [wrangler.jsonc](wrangler.jsonc), 개발 작업 원칙은 [AGENTS.md](AGENTS.md)에서 확인할 수 있습니다.

서드파티 라이선스: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
