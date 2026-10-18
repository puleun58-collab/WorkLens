# AI•AX Live Eval (opt-in)

14개 실업무 시나리오 + PR #102 경계 케이스 3개(c15~c17)를 실제 배포 환경에서 끝까지 실행해 품질을 판정하는 평가 세트입니다. 2026-10-06 수동 평가에서 발견된 문제(technicalChecks "확인됨" 남발과 구체 기술 발명, systemAccess 방향 오류, 조직명 발명, needs-check 누락/과보정)를 회귀로 고정하는 것이 목적입니다.

이 평가는 수동 opt-in이며 CI에 포함되지 않습니다. Vitest는 `tests/**/*.test.ts`만 수집하므로 이 디렉터리는 실행하지 않고, package.json scripts도 추가하지 않습니다.

## 실행

```sh
cd eval/ax-live
BASE_URL=https://worklens.puleun58.workers.dev bun run run.ts
# 일부만: bun run run.ts c13-sparse-info,c16-three-core-missing (BASE_URL 필요)
```

`BASE_URL`이 없으면 SKIP 메시지를 출력하고 0으로 종료합니다(일반 CI를 실패시키지 않음). 결과는 `eval/ax-live/results/<timestamp>/`에 시나리오별 JSON과 `summary.md`로 저장되며 gitignore 됩니다.

## 평가 방식

각 시나리오를 등록 → 진단 → Factor/Level/Gate/Matrix/policy profile → (허용 시) Codex·Claude 계획 → 최종 올인원 지시문까지 실행합니다. 판정은 exact string 비교가 아니라 `checks.ts`의 의미 기반 규칙으로 합니다.

- "확인됨" 기술 확인에 입력에 없는 구체 기술(OAuth, LDAP, SMTP, 특정 endpoint 등)이 단정되면 FAIL
- 입력에 없는 조직명이 진단에 생성되면 ISSUE
- 최종 지시문에 근거 없는 % 수치가 있으면 FAIL
- 담당자 유지 단계가 계획 단계에서 사라지면 FAIL
- blocked인데 계획이 생성되면 FAIL, Level 0인데 전체 자동화를 주장하면 FAIL
- 정보 부족 시나리오가 sufficient면 FAIL, needs-check가 아니면 ISSUE; 정보 충분 시나리오가 needs-check면 ISSUE(과보정)
- 수기 접근만 가능한데 systemAccess가 높으면 FAIL, API 연동 확인인데 낮으면 FAIL
- API + 담당자 승인 케이스에서 systemAccess와 사람 판단이 분리되지 않으면 FAIL/ISSUE

판정은 PASS / PASS WITH ISSUE / FAIL이며, 자동 검사는 신호일 뿐 최종 의미 판단을 대신하지 않습니다. FAIL이 나오면 해당 시나리오만 고치고 끝내지 말고 공통 원인을 해당 레이어(prompt/schema/policy/guard)에서 최소 수정한 뒤 전체를 재실행하세요. 업무명 하드코딩은 금지입니다.

## 결정적 테스트와의 경계

schema·policy·Level·Gate·Matrix 좌표·plan guard 같은 결정적 동작은 `tests/`의 unit/E2E가 담당합니다. 이 Live Eval은 실제 AI 출력의 의미 품질만 평가하며, AI가 출력할 Factor 숫자를 unit test에서 흉내 내지 않습니다.

## 격리 코딩 에이전트 구현 검증

`agent-run.ts`는 위의 진단 품질 평가와 별도의 opt-in 실행입니다. **로컬 WorkLens 서버**(`bun run dev --port 3000`)와 로그인된 Codex CLI·Claude Code CLI가 필요합니다. 저장소 루트에서 `BASE_URL=http://localhost:3000 bun eval/ax-live/agent-run.ts`로 실행합니다. 기존 서비스의 비밀키나 실제 업무 데이터를 코딩 에이전트에게 전달하지 않습니다. 에이전트별로 새 OS 임시 디렉터리를 만들고, 등록 정보로 WorkLens `/api/ai` 진단·계획을 호출한 뒤 실제 `buildAllInOnePrompt` 출력만 stdin으로 전달합니다. 등록 및 HITL 검토 결과는 WorkLens v2 스키마·원본 대상/해시 유효성으로 검증해 기록하지만 **브라우저의 WorkLens 등록 화면을 실제 조작했다는 증거는 아닙니다**.

`agent-scenarios.ts`의 다섯 사례(브라우저 CSV 업로드/집계, 브라우저 CRUD 재로드 및 서버 재시작, 독립 로컬 HTTP API의 브라우저 표시, 다단계 분기/실패/재실행, 사람 검토 확정/보류/제외/보완/미확정)가 각각 Codex와 Claude의 독립 실행을 거칩니다. 격리 웹 프로젝트는 기존 Playwright 도구로 실제 브라우저에서 업로드·클릭·표시를 대조합니다. 평가기의 fixture를 수정하면 FAIL입니다. WorkLens의 실제 검토 액션 이름은 `keep/defer/exclude/supplement`이며 HITL 사례의 입력 파일 decision 값 `hold/amend`는 격리 프로젝트의 업무 데이터 표기입니다.

`eval/ax-live/results/agent-<timestamp>/agent-verification.json`에 PASS/FAIL/BLOCKED/NOT_RUN 10건과 입력·출력 검사 근거가 저장됩니다. 같은 디렉터리의 진단·계획·생성 지시문·에이전트 로그는 민감할 수 있어 gitignore 대상이며 공유 전에 확인해야 합니다. 로컬 통과는 운영 배포·Production 검증 통과를 의미하지 않습니다. 이 실행은 Git push나 배포를 하지 않습니다.

Codex·Claude Code CLI의 로그인 만료·미로그인(토큰 만료, 401 등)은 구현 실패가 아니라 BLOCKED로 기록합니다. 실행 전 `codex login status`와 `claude auth status`로 확인하고, 만료되었으면 `codex logout` 후 `codex login`, `claude auth login`으로 다시 로그인합니다.
