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
