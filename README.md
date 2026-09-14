**배포 주소:** https://worklens.puleun58.workers.dev

# WorkLens

WorkLens는 XLSX, CSV, PDF, DOCX, PPTX 파일을 브라우저에서 분석·비교·검사·추출하는 임시 문서 작업 공간입니다.

- 로그인 없이 익명 브라우저 세션 사용
- 세션별 원본·정규화 결과 격리
- 마지막 유효 활동 후 최대 2시간 보관
- Analyze, Compare, Check, Extract는 AI 없이 동작
- AI 기능은 내부 HTTPS 엔드포인트만 허용하며 외부 AI fallback 없음
- 결과의 파일, 문서 버전, 노드, 원문 위치를 `SourceRef`로 보존

> WorkLens 서버의 데이터는 임시 데이터입니다. 다운로드한 파일은 사용자 기기에서 별도로 관리해야 합니다.

## 1. 설치 방법

### 요구 사항

- Windows 11, macOS 또는 Linux
- [Bun](https://bun.sh/) 1.4.1 이상
- Git
- E2E 테스트 실행 시 Playwright 브라우저
- Valkey/MinIO 참조 인프라 실행 시 Docker Compose

버전을 확인합니다.

```bash
bun --version
git --version
```

저장소를 받은 뒤 의존성을 설치합니다.

```bash
git clone https://github.com/puleun58-collab/WorkLens.git
cd WorkLens
bun install
```

브라우저 테스트까지 실행하려면 Playwright 엔진을 한 번 설치합니다.

```bash
bunx playwright install chromium firefox
```

## 2. 실행 방법

### 개발 서버

```bash
bun run dev
```

`parser:build`가 먼저 실행되어 제한된 parser child bundle과 PDF assets를 `.worklens/`에 준비한 뒤 Next.js 개발 서버를 시작합니다.

브라우저에서 다음 주소를 엽니다.

```text
http://localhost:3000
```

### 로컬 production 빌드 확인

PowerShell:

```powershell
bun run build
$env:WORKLENS_ORIGIN = "http://localhost:3000"
$env:WORKLENS_ALLOW_LOCAL_EPHEMERAL = "true"
bun run start
```

Bash:

```bash
bun run build
WORKLENS_ORIGIN=http://localhost:3000 \
WORKLENS_ALLOW_LOCAL_EPHEMERAL=true \
bun run start
```

`WORKLENS_ALLOW_LOCAL_EPHEMERAL=true`는 단일 프로세스 참조 실행과 테스트에만 사용합니다. 이 모드는 프로세스 재시작 복구나 수평 확장을 제공하지 않습니다.

### 참조 Valkey/MinIO 인프라

`docker-compose.yml`은 persistence와 backup이 없는 사설 Valkey/MinIO 참조 구성을 제공합니다.

PowerShell:

```powershell
$env:WORKLENS_MINIO_ROOT_USER = "worklens"
$env:WORKLENS_MINIO_ROOT_PASSWORD = "충분히-긴-임의-비밀번호"
bun run ephemeral:up
```

종료:

```bash
bun run ephemeral:down
```

현재 애플리케이션의 단일 프로세스 저장 구현은 OS 임시 디렉터리를 사용합니다. `valkey-s3` profile은 운영 adapter가 충족해야 하는 capability와 설정 경계를 정의합니다. 실제 운영 배포에서는 해당 adapter 구현과 사설 TLS·인증·네트워크 정책을 함께 제공해야 합니다.

### Cloudflare Workers 배포

Cloudflare 배포는 Vinext, Wrangler, Workers KV를 사용합니다. 최초 한 번 로그인합니다.

```bash
bunx wrangler login
```

현재 `wrangler.jsonc`에는 WorkLens의 `VINEXT_KV_CACHE` namespace가 연결되어 있습니다. 다른 Cloudflare 계정으로 복제한 경우 새 namespace를 만들고 반환된 ID로 설정을 교체합니다.

```bash
bunx wrangler kv namespace create VINEXT_KV_CACHE
```

이후 빌드와 배포는 다음 명령 한 번으로 수행합니다.

```bash
npm run deploy
```

명령은 기존 `dist/`를 제거하고 Vinext Worker bundle을 새로 빌드한 뒤 Wrangler로 production Worker를 배포합니다.

현재 배포 URL:

```text
https://worklens.puleun58.workers.dev
```

Workers에서는 `child_process`를 사용할 수 없으므로 업로드 parser가 동일 요청 안에서 in-process 모드로 실행됩니다. 입력 크기와 parser/result resource ceiling은 그대로 적용되지만, 강한 프로세스 격리가 필요한 내부 운영 배포는 Node parser worker 또는 격리 컨테이너 profile을 사용해야 합니다.

## 3. 환경 변수

### 기본 서버

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `WORKLENS_TEMP_DIR` | OS temp의 `worklens-v1` | 세션별 임시 파일 저장 루트 |
| `WORKLENS_SESSION_TTL_MS` | `7200000` | sliding TTL. 0보다 크고 2시간 이하여야 함 |
| `WORKLENS_MAX_FILE_BYTES` | 50 MiB | 파일 업로드 상한. 최대 50 MiB |
| `WORKLENS_ORIGIN` | 개발 시 요청 origin | production에서 필수인 canonical browser origin |
| `WORKLENS_ALLOW_LOCAL_EPHEMERAL` | 미설정 | `true`일 때 production-mode 단일 프로세스 참조 실행 허용 |

### 내부 AI

| 변수 | 설명 |
|---|---|
| `WORKLENS_AI_URL` | 내부 HTTPS `/worklens/v1/generate` 서비스의 base URL |
| `WORKLENS_AI_HOSTS` | 쉼표로 구분한 내부 hostname allowlist |
| `WORKLENS_AI_SERVICE_IDENTITY` | 내부 서비스 identity |
| `WORKLENS_AI_MTLS_CERT_PEM` | mTLS client certificate PEM |
| `WORKLENS_AI_MTLS_KEY_PEM` | mTLS client private key PEM |
| `WORKLENS_AI_CA_PEM` | 선택적 사설 CA PEM |

AI가 설정되지 않았거나 사용할 수 없어도 deterministic Analyze, Compare, Check, Extract, export는 계속 동작합니다.

### 운영 ephemeral profile

| 변수 | 필수 값 또는 예시 |
|---|---|
| `WORKLENS_EPHEMERAL_ADAPTER` | `valkey-s3` |
| `WORKLENS_VALKEY_URL` | `rediss://...` |
| `WORKLENS_VALKEY_TLS` | `true` |
| `WORKLENS_VALKEY_PERSISTENCE_DISABLED` | `true` |
| `WORKLENS_VALKEY_BACKUP_DISABLED` | `true` |
| `WORKLENS_VALKEY_QUEUE` | `streams` |
| `WORKLENS_BLOB_ENDPOINT` | 사설 `https://...` endpoint |
| `WORKLENS_BLOB_BUCKET` | 임시 blob bucket |
| `WORKLENS_BLOB_TLS` | `true` |
| `WORKLENS_BLOB_VERSIONING_DISABLED` | `true` |
| `WORKLENS_BLOB_BACKUP_DISABLED` | `true` |

## 4. 폴더 구조

```text
WorkLens/
├─ src/
│  ├─ app/
│  │  ├─ api/                 # session, file, operation, AI API routes
│  │  ├─ page.tsx             # 파일 작업 공간 UI
│  │  └─ globals.css          # 전역 UI 스타일
│  ├─ domain/
│  │  ├─ document.ts          # Document, SourceRef, canonical locator
│  │  ├─ numeric.ts           # 보수적 숫자 파싱
│  │  ├─ compare.ts           # 구조·내용 비교와 bounded alignment
│  │  └─ ai.ts                # grounded AI 계약
│  └─ server/
│     ├─ parsers/             # 5개 형식 parser와 isolated runner
│     ├─ ai/                  # 내부 provider와 grounding 검증
│     ├─ workspace-store.ts   # 임시 workspace·TTL·resource ceilings
│     ├─ ephemeral-adapter.ts # 운영 ephemeral capability profile
│     ├─ session.ts           # 익명 session, CSRF, tab release
│     ├─ deterministic.ts     # AI 독립 Analyze/Check/Extract
│     └─ export.ts            # CSV/XLSX 안전 export
├─ scripts/
│  └─ build-parser.ts         # parser child와 PDF assets 사전 빌드
├─ tests/
│  ├─ e2e/                    # Playwright browser scenarios
│  └─ *.test.ts               # unit/integration/security tests
├─ docker-compose.yml         # Valkey/MinIO 참조 인프라
├─ playwright.config.ts
├─ vitest.config.mts
└─ package.json
```

생성 디렉터리인 `.next/`, `.worklens/`, `.playwright-tmp/`, `artifacts/`는 Git에 포함하지 않습니다.

## 5. 자동 실행 방법

### 제공되는 자동화 명령

```bash
bun run parser:build  # 격리 parser bundle 생성
bun run dev           # parser build 후 개발 서버
bun run build         # parser build 후 production build
bun run start         # 빌드된 Next.js 서버 실행
bun run test          # parser build 후 Vitest 전체 실행
bun run test:e2e      # Playwright 전체 프로젝트 실행
bun run ephemeral:up  # Valkey/MinIO 시작
bun run ephemeral:down
```

### Windows 로그인 시 자동 시작

1. 먼저 `bun run build`를 실행합니다.
2. Windows 작업 스케줄러에서 **로그온할 때** 트리거를 만듭니다.
3. 프로그램은 설치된 `bun.exe`의 절대 경로를 지정합니다.
4. 인수에 `run start`를 입력합니다.
5. **시작 위치**에 이 저장소의 절대 경로를 지정합니다.
6. `WORKLENS_ORIGIN`, `WORKLENS_ALLOW_LOCAL_EPHEMERAL`, `WORKLENS_TEMP_DIR`은 작업의 실행 계정 환경 변수로 설정합니다.

서비스 재시작이 필요한 운영 환경에서는 Windows Service wrapper, systemd, 컨테이너 orchestrator 같은 supervisor를 사용하고 종료 시 `SIGTERM` 전달, 임시 저장소 용량 제한, health monitoring을 함께 구성합니다.

## 6. 검증 방법

모든 정적·unit·integration gate:

```bash
bun run typecheck
bun run lint
bun run test
bun audit --production
bun run build
```

브라우저 E2E:

```bash
bun run test:e2e
```

현재 Playwright 구성은 다음 39개 조합을 실행합니다.

- Chromium desktop: 1440×900, 13 scenarios
- Chromium tablet: 768×1024, 13 scenarios
- Firefox desktop: 1440×900, 13 scenarios

## 7. 오류 대응 방법

### `EADDRINUSE` 또는 포트 3000 사용 중

다른 포트를 지정합니다.

```bash
bunx next dev --port 3001
```

production 실행에서는 `WORKLENS_ORIGIN`도 실제 포트와 일치시켜야 합니다.

### `WORKLENS_ORIGIN_REQUIRED` / `요청 출처가 일치하지 않습니다`

- `WORKLENS_ORIGIN`을 브라우저가 접근하는 origin과 정확히 맞춥니다.
- scheme, hostname, port 중 하나라도 다르면 mutation이 거부됩니다.
- reverse proxy 사용 시 외부 canonical origin을 설정합니다.

```powershell
$env:WORKLENS_ORIGIN = "https://worklens.internal"
```

### `LOCAL_ADAPTER_DISABLED`

production mode에서 단일 프로세스 저장소를 명시적으로 선택하지 않은 상태입니다.

로컬 reference 실행:

```powershell
$env:WORKLENS_ALLOW_LOCAL_EPHEMERAL = "true"
```

수평 확장 운영에서는 이 우회를 사용하지 말고 `valkey-s3` adapter와 필수 capability를 구현·검증합니다.

### `PARSER_OUTPUT_INVALID`, `PARSER_LIMIT`, `PARSER_CAPACITY`

1. `.worklens/` bundle을 다시 만듭니다.
2. 업로드 크기와 압축 해제 상한을 확인합니다.
3. 임시 디렉터리 read/write 권한과 여유 공간을 확인합니다.
4. 반복되면 파일이 손상됐거나 지원하지 않는 active content를 포함하는지 확인합니다.

```bash
bun run parser:build
bun run test
```

`.worklens/`를 직접 수정하지 않습니다. `parser:build`가 안전하게 다시 생성합니다.

### `CSRF_INVALID` / session 관련 401·403·410

- 쿠키 차단 여부를 확인합니다.
- application origin과 `WORKLENS_ORIGIN`을 일치시킵니다.
- 만료된 탭에서는 새로고침해 새 익명 세션을 만듭니다.
- 410은 세션 TTL 만료 또는 명시적 삭제를 의미합니다.

### `AI_UNAVAILABLE`

- deterministic 기능은 정상적으로 사용할 수 있습니다.
- `WORKLENS_AI_URL`이 HTTPS인지 확인합니다.
- hostname이 private/internal allowlist에 있는지 확인합니다.
- mTLS certificate, key, CA, service identity를 확인합니다.
- redirect, public DNS/IP, proxy fallback은 의도적으로 거부됩니다.

### Playwright browser executable 오류

```bash
bunx playwright install chromium firefox
bun run test:e2e
```

### 임시 파일이 남거나 디스크 사용량이 증가함

- 서버 시작과 주기 sweep이 만료 workspace를 정리합니다.
- `WORKLENS_TEMP_DIR` 경로와 권한을 확인합니다.
- 서버가 완전히 정지된 상태에서만 만료된 reference workspace를 수동 삭제합니다.
- 활성 서버의 임시 디렉터리를 임의로 삭제하면 진행 중 parser와 session이 실패할 수 있습니다.

### Docker Compose가 시작되지 않음

- Docker Desktop 또는 Docker Engine이 실행 중인지 확인합니다.
- `WORKLENS_MINIO_ROOT_USER`, `WORKLENS_MINIO_ROOT_PASSWORD`를 설정합니다.
- 상태 확인 후 다시 시작합니다.

```bash
docker compose ps
bun run ephemeral:down
bun run ephemeral:up
```
