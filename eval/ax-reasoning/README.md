# AX reasoning 평가 (opt-in)

합성 업무 15개(단순 4, 중간 4, 기술 제약 3, 고위험 4)로 AX 진단의 사실 충실도, 사람 판단 보존, 기술 제약 인식과 reasoning effort별 비용·품질을 재현합니다. 실제 업무 원문은 포함하지 않습니다. `scenarios.ts`는 입력, `expectations.ts`는 Hard Constraint, `RUBRIC.md`는 /20 채점표입니다.

이 평가는 수동 opt-in이며 CI에 포함되지 않습니다. Vitest는 `tests/**/*.test.ts`만 수집하므로 이 디렉터리는 실행하지 않습니다. package.json scripts는 추가하지 않습니다.

## 실행

저장소 루트에서 의존성을 설치한 뒤 이 디렉터리로 이동합니다. `BASE_URL`은 **평가 전용 워커 프리뷰** 주소입니다. 운영 주소를 사용하지 마세요. effort override와 선택적인 `x-eval-usage` 응답 헤더는 평가 전용 워커에만 적용합니다. 이 저장소의 운영 reasoning policy와 API에는 override를 추가하지 않습니다. `EFFORT`는 워커의 설정을 기록하는 라벨이며 서버 effort를 변경하지 않습니다.

```sh
cd eval/ax-reasoning
BASE_URL=https://your-low-preview.example EFFORT=low RUNS=2 bun run run.ts
```

세 effort를 비교하려면 각각 서버에서 설정된 프리뷰 주소를 JSON으로 지정합니다. 시나리오와 반복 번호에 따라 호출 순서를 결정적으로 회전합니다. 기본 2회 반복으로 90회 호출하며, 단일 프리뷰는 30회입니다.

```sh
BASE_URL='{"low":"https://your-low-preview.example","medium":"https://your-medium-preview.example","high":"https://your-high-preview.example"}' OUT_DIR=./results RUNS=2 bun run run.ts
```

`OUT_DIR` 기본값은 실행 디렉터리의 `./results`입니다. 위와 같이 이 디렉터리에서 실행하면 gitignore된 `eval/ax-reasoning/results/`에 저장됩니다. 별도 경로를 쓰면 해당 경로의 커밋 제외를 직접 관리하세요. 실행마다 새 OUT_DIR를 쓰거나 이전 결과를 비운 뒤 실행하세요.

하네스는 전역 fetch와 `node:fs/promises`를 사용하며 Bun 전역 API에 의존하지 않습니다. 요청은 `/api/ai`로 보내고 클라이언트 timeout은 180초, 호출 간 간격은 1초입니다. 하네스는 재시도하지 않으며 서버의 기존 attempt budget만 사용합니다. 각 호출마다 결과와 봉인 메타데이터를 저장하므로 중단 후에도 확인할 수 있습니다.

## Blind 채점과 집계

채점자는 `<OUT_DIR>/<anonymousId>.json`, 입력·기대값·루브릭만 읽습니다. 해당 결과에는 effort·토큰·지연·실행 순서가 없습니다. 자동 semantic/bypass 스캔은 검토용 신호이며 Hard Constraint의 최종 판정을 대신하지 않습니다. MFA 등의 부정 표현은 수동 확인하세요. 점수는 길이나 전문적인 문구가 아니라 루브릭에 따라 매깁니다.

스키마가 유효한 응답을 채점한 뒤 `<OUT_DIR>/sealed/scores-b1.json` 등에 아래 형식으로 작성합니다. JSON 키는 실제 익명 ID를 사용하며, 항목 점수는 루브릭 순서대로 10개, 각 0~2점입니다. Hard Constraint 위반은 품질 점수와 별개로 `hardFail: true`, 위반 내용은 `note`에 기록합니다. 스키마 유효 응답의 hallucination·논리 모순·위험한 제안도 flags와 hardFail을 기록해 모델 품질 실패로 평가합니다.

```json
{
  "S1-r1-A": {
    "scores": [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    "total": 20,
    "flags": [],
    "hardFail": false,
    "note": ""
  }
}
```

채점 완료 후에만 `sealed/mapping.json`과 `sealed/metrics-partial.json`을 열고 집계합니다.

```sh
OUT_DIR=./results bun run aggregate.ts
```

집계는 schema-valid·채점됨·미채점 응답을 구분하고, Model Output Failure(`INVALID_PROVIDER_OUTPUT`, `json_validate_failed`, provider 출력 거부)와 Provider/Infrastructure Failure(429·5xx·네트워크·timeout)를 나눕니다. Hard Constraint 실패 건수·시나리오 수, flag 건수, effort별 /20 평균·중앙값, 그룹별 품질, 재시도율·지연·토큰을 출력합니다. 누적 토큰이 있으면 마지막 응답 토큰보다 우선 사용합니다. `x-eval-usage` 헤더가 없으면 서버 지연·토큰은 null이며 `usageObservedCalls`로 관측 수를 확인할 수 있습니다. 클라이언트 지연은 별도 집계합니다.
