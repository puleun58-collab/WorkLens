# 법령 운영 모니터링 런북 (8순위)

## 로그 확인

법령 API(`/api/law`, `/api/law/research`)는 매 요청마다 메타데이터만 한 줄 JSON으로 기록한다.
Cloudflare Workers Logs (`wrangler tail` 또는 대시보드 → Workers → Logs)에서 확인한다.

```json
{"scope":"law_request","durationMs":1234,"requestId":"…","task":"full_research","httpStatus":200,"outcome":"success","retries":0}
```

**기록 항목**: 요청ID, 작업 유형, 소요 시간, HTTP 상태, 결과 분류, 재시도 횟수, 오류 코드(실패 시).
**기록하지 않는 항목**: 질문 원문, 문서 내용, 인증 토큰, API 키, 법률 상담 내용.

## 결과 분류 (outcome)

| 분류 | 의미 | 장애율 포함 |
|------|------|-------------|
| success | 요청·검증 정상 완료 | — |
| no_data | 조회 정상, 해당 자료 없음 | 제외 (정상) |
| insufficient_relevance | 직접 근거로 채택 못함 | 제외 (정상) |
| partial | 일부 확인, 일부 실패 | 성공률 분자에 포함 |
| external_failure | MCP/API 외부 장애 | 장애 |
| timeout | 시간 예산 초과 | 장애 |
| internal_error | WorkLens 처리 오류 | 장애 |
| cancelled | 사용자·시스템 정상 취소 | 제외 (정상) |

**유효 성공률** = (success + partial) / (전체 − no_data − insufficient_relevance − cancelled)

## 봐야 할 지표

1. **유효 성공률 급락** — 평소 대비 5%p 이상 하락 시 원인 분류 확인
2. **external_failure 연속 발생** — 법제처/MCP 장애 가능성, `LAW_RATE_LIMITED` 증가는 429 대응 확인
3. **timeout 증가** — `LAW_UPSTREAM_TIMEOUT`, `OPERATION_CAPACITY` 코드 추이
4. **p95 응답 시간 급증** — 배포 직후 악화 시 롤백 검토
5. **partial 증가** — 일부 근거 조회 실패, 정상 근거는 유지되는지 확인

## 임계치 설정 원칙

임계치를 임의로 고정하지 않는다. 먼저 1~2주간 정상 운영 기준값을 측정한 뒤,
서비스 규모에 맞게 설정한다 (예: 평소 실패율의 3배를 알림 기준으로 시작).

### 1단계: 사건 기반 알림 임계치 (2026-10-31 적용, 구현: worklens-upstream-watch/state.ts)

- 알림 대상 (`REPORT_PENDING.md` 작성, 부모가 사용자에게 전달):
  - 동일 장애 이벤트에서 검증 FAIL이 연속 2회 이상 발생한 경우
  - 검증 시도 소진(3회) 시 최종 검증 결과가 FAIL인 경우
  - 상류 차단(`blocked_upstream`)이 시도 소진으로 확정된 경우
- 로그 전용 (`state.json`·`logs`·`artifacts`에만 기록, `REPORT_PENDING` 미작성):
  - 검증 PASS, 검증 PARTIAL — 단, `assemble.ts` 규칙상 어느 단계든 FAIL이면 전체가 `fail`이
    되므로 PARTIAL에는 회귀·스모크 FAIL이 포함될 수 없다 (PARTIAL = FAIL 단계 없음)
  - 단발성 검증 FAIL — 재검증 대기 경로로 간다 (30분 후 + 신선한 연속 성공 3회 후 재검증)
  - 단발성 실패 후 자가 회복, `monitor_error` 단독 발생, 검증 체계 `error`의 시도 소진
- 이 구분은 보고 필터이며, 판정 기준·evidence·프로브 분류를 바꾸지 않는다.
- 주의: 1단계 적용 이후 회복 검증 PASS는 사용자에게 별도 보고되지 않는다.
  회복 여부는 `state.json`·`artifacts/<eventId>/`에서 확인한다.

### 보류: 숫자 임계치 (Workers Logs 집계 후 설정)

- 유효 성공률 하락폭(평소 대비 5%p), 실패율 배수(평소의 3배) 등 숫자 기준은 아직 설정하지 않았다.
- 사유: VM에서 2주간 Workers Logs 요청 메타데이터를 집계할 수단이 없다.
  `wrangler tail`은 실시간 스트리밍 전용이고, Logpush·대시보드 내보내기는 구성돼 있지 않다.
  기준값 숫자를 임의로 만들지 않는다.
- 설정에 필요한 것: Cloudflare 대시보드 Workers Observability에서 기간별 요청 메타데이터
  조회·내보내기, 또는 Logpush 구성 후 집계. 집계가 확보되면 그때 숫자 임계치를 정한다.
  (감시 프로브 누적치 `probeTotals`는 장애 기간을 포함한 누적값이라 정상 기준값이 아니다.)

## 관련성·추가 조회 상태 확인

- 검색 후보와 채택 근거는 구분한다. 종합 리서치의 `evidence.issues`가 쟁점별 상태·자료 연결의 기준이며, AI가 제시한 쟁점은 사용자가 제공한 사실관계가 아니다.
- `enrichment.adoptionReviews`에는 쟁점별로 채택을 검토한 조문·판례·결정례의 원문, 식별자, 조회 단계, 역할·인용 및 미채택 사유가 남는다. 원질문의 당사자·법률관계와 맞지 않아 제외한 자료는 조회 실패나 자료 부존재로 취급하지 않는다.
- `followup.unavailable[].reason === "limited"`는 실제 미조회다. `missing`·조회 실패와 구분하며, 사용자 화면에서 미확보로 단정하거나 내부 검색 한도를 표시하지 않는다. 원문을 확보했지만 관련성이 낮은 자료 역시 미확보가 아니다.
- 응답의 원문·쟁점별 검토 내용은 요청 메타데이터 로그와 별개다. 질문·법률 상담 내용이 포함될 수 있으므로 응답 전체를 Workers Logs에 기록하지 않는다.
- 종합 리서치의 공식 원문·출처는 각 쟁점의 `관련 법령·판례 상세 보기`에서 확인한다. 상세 건수와 실제 자료 수, 같은 조문의 서로 다른 시행 시점이 섞이지 않았는지 함께 확인한다.
- 최종 관련성 검증은 현재 요청에서 확보한 공식 원문만 한 번 대조한다. 인용·자료 식별자가 원문과 맞아야 직접·보충 근거에 포함하며, 검증 실패 시 키워드 일치만으로 재채택하지 않는다. 보충 자료만 있는 쟁점은 핵심 근거 확인 완료로 집계하지 않는다.
- 보충·쟁점·재조회로 확보한 조문의 `original`은 표시용 `excerpt`와 분리한다. 600자 표시 발췌의 말줄임은 원문 미확보를 뜻하지 않으며, 최종 검증은 보존한 원문을 사용한다. 실제 원문 자체가 생략된 경우에만 부분 확보로 취급한다.
- 검색어는 원질문의 법률관계를 유지하는 규율 용어로 정규화한다. 최종 채택 시 의무·책임의 성립요건과 확인서 발급·융자·배상방법 등의 보충 절차를 구분하며, 후자만으로 핵심 요건이 확인됐다고 표시하지 않는다.
- 최종 당사자·관계 gate는 모델의 `quote`가 아니라 확보한 공식 본문 전체와 원질문을 대조한다. 회사 구성원인 사원의 퇴사(총사원 동의·지분 등)를 근로자의 퇴사로 바꾸지 않으며, 실제 출자·지분 관계 질문은 배제하지 않는다. 가중 체불임금 배상은 별도 고의·기간·금액 조건이나 해당 손해배상 구제를 사용자가 묻지 않았다면 일반 임금 쟁점의 direct가 될 수 없다. 미확정 조건을 밝힌 supporting은 별도 검토한다.
- `tests/fixtures/research-live-scope-adoption.json`은 `artifacts/research-live-eight.json`의 실제 오채택 원문·quote·reason·요청 식별자와 식품 처분 원문을 보존한다. 식품 처분 조문은 완전한 원문 두 버전이 검토 목록에 있었지만 양성 판정이 없어 미채택되었고, 감사 응답만으로 모델의 실제 입력 window나 내부 판단은 확정할 수 없다. 처분 행위의 분리 표기와 일반 요건 질문에 대한 검증 지침을 명시했으며, 실제 API 개선 여부는 격리 preview 재실행으로 확인해야 한다. 키워드에 의한 강제 채택은 하지 않는다.
- 시점별 원문은 선택 MST와 기준일(`efYd`), 기대 시행일·공포일을 함께 대조한다. 불일치·메타데이터 부족은 `LAW_VERSION_UNCONFIRMED`이며, 시행 예정 원문으로 대체하지 않는다. 목차 확보와 해당 조문 확보도 구분한다.
- 조문 영향도는 확인된 인용 자료와 추가 확인 후보를 각각 자료 건수로 집계한다. 자료 유형 수·검색 후보 수와 혼합하지 않으며, 인용 확인은 판결에 미친 실질적 법적 영향의 확정이 아니다.
- 별표 표시용 문단·표 파싱은 원본 문자열을 수정하지 않는다. HWP 형식 안내만 본문에서 숨기고 다운로드 출처·형식 메타데이터는 유지하며, 병합 셀·빈 셀·각주·항목 순서를 보존한다.

## 배포 전후 비교

배포 후 30분간 위 지표를 배포 전 1시간과 비교한다.
`internal_error` 신규 발생 또는 유효 성공률 하락이 있으면
`scripts/law-regression.ts` (15종 실데이터 회귀)를 운영 대상으로 실행해
코드 회귀와 외부 장애를 구분한다.

## 비용·인프라 영향

- 추가 DB·외부 모니터링 서비스 없음. Workers Logs 기본 제공 범위를 사용.
- 로그 1줄/요청, PII 없음. 저장 기간은 Cloudflare 기본 정책 따름.
- 관측·채택 검토 기록을 위한 추가 외부 호출은 없다. 기존 검색·재조회 예산은 유지하며, 미채택 뒤 실행되는 기존 보충 조회로 실제 호출 수는 달라질 수 있다.

## 법령 정확도 수동 반복 측정

`scripts/law-accuracy-live.ts`는 기존 15종 회귀 입력·정답을 변경하지 않는 별도 API 관측기다. 앱 코드나 저장 데이터를 변경하지 않고 `/api/law/research` 검색 POST만 순차 실행한다. 운영 origin은 baseline 읽기 전용 검색에만 사용하고, 변경 후 측정은 격리 origin을 명시한다. 리다이렉트·자동 재시도·업로드·로그인·저장 API는 사용하지 않는다. 검색에 따른 정상 서버 메타데이터 로그·외부 API 비용은 발생할 수 있다.

```sh
# artifacts 부모 디렉터리가 존재해야 하며 --out은 아직 없는 새 디렉터리여야 한다.
# BASELINE_ORIGIN: 운영 읽기 전용 검색 origin, ISOLATED_ORIGIN: 격리 preview origin
bun scripts/law-accuracy-live.ts --base "$BASELINE_ORIGIN" --runs 1 --cases all --out artifacts/law-accuracy-baseline
bun scripts/law-accuracy-live.ts --base "$ISOLATED_ORIGIN" --runs 5 --cases representative --out artifacts/law-accuracy-after-five --baseline artifacts/law-accuracy-baseline/summary.private.json
# 전체 신규 유형을 변경 후 한 번 관측하거나, --runs 5로 전체 반복할 수도 있다.
bun scripts/law-accuracy-live.ts --base "$ISOLATED_ORIGIN" --runs 1 --cases all --out artifacts/law-accuracy-after-all --baseline artifacts/law-accuracy-baseline/summary.private.json
```

- 필수 인자: `--base`는 자격증명·경로·쿼리 없는 HTTP(S) origin, `--out`은 새 출력 디렉터리. `--runs` 기본 5(1~20), `--timeout-ms` 기본 180000(1000~600000).
- `--cases all`은 10유형이다: `labor-absence`, `post-employment-wages`, `monthly-wages`, `contract-breach`, `contract-rescission`, `procurement-change`, `procurement-sanction`, `delegation-system`, `business-suspension`, `administrative-appeal-documents`.
- `--cases representative`는 위 목록의 앞 5유형이며, ID를 쉼표로 연결한 부분집합도 지원한다. 질문에는 기대 법률명·조문번호를 강제하지 않는다. 법체계·처분근거·절차서류는 각각 실제 전용 task로 측정한다.
- 요청별 `response`(정상 응답), `external_failure`(알려진 외부 오류/일시 용량 제한), `api_failure`(HTTP·응답계약 오류), `missing`(`found:false`), `transport_failure`(네트워크·타임아웃)를 분리한다. 응답이 정상이어도 `interpretationFailure`, 쟁점 failed/timeout, evidence unverified 등 내부 부분 실패는 별도 private 기록으로 확인해야 한다.
- 종료 코드 0은 모든 요청의 응답 수신일 뿐 정확도 PASS가 아니다. 1은 API/전송 실패 또는 실행 실패, 2는 외부 장애/자료 없음 관측이다. 어떤 코드도 법률 정확도를 자동 인증하지 않는다.
- `summary.md`는 질문·원문·실패 메시지를 콘솔에 노출하지 않는 수동 검토용 요약이다. 결과별 후보 수, direct/supporting/identity/rejected, 해석 유무, 쟁점 상태와 검토 관점을 표시한다.
- `summary.private.json`에는 해석·쟁점, 채택 검토 전체, 후보 수, 확보된 원문 식별자·시행일·조회 단계, 공개된 입력 window, 원문 완전성 표시, 최종 근거 및 전용 task 근거를 기록한다. `*.private.json`은 요청·원응답 전체를 보존한다. 원문 길이나 부분 확보 여부가 미노출이면 완전 확보로 추정하지 않으며, 모델 window도 없으면 null이다. retries/requestStats/timing 등은 응답에 실제 존재하는 항목만 기록하고 0을 만들어 넣지 않는다.
- 응답 원문은 법률 상담·법령 본문을 포함하는 비공개 감사 자료다. 파일은 `0600`, 디렉터리는 `0700` 생성 모드로 요청하지만 Windows에서는 POSIX 모드가 ACL 접근 제한을 보장하지 않는다. 실행자는 제한된 로컬 디렉터리/ACL을 사용하고 raw JSON을 커밋·공개 CI artifact·운영 로그에 업로드하지 않는다. 키는 인자로 받거나 출력하지 않는다.
- `--baseline`은 앞선 `summary.private.json`을 읽어 같은 case ID의 outcome 수, 평균·p50·p95 소요시간과 평균 후보 수를 비교한다. 표본 수가 다른 baseline 1회/after 5회도 분모를 보존한다. 성능 차이는 시점·상류 상태가 다른 기술통계이며 인과적 개선 증거가 아니다.
- 반복 signature는 최종 근거 식별자와 task 근거의 관측 차이를 보여줄 뿐, 같은 결과가 정답이거나 다른 결과가 오답임을 뜻하지 않는다. 부모 검토자는 당사자·법률관계, 의무/행위/절차 쟁점 누락, 공식 원문 버전, 모델 입력 window, 직접/보조 역할, 조건부 구제의 미확정 조건, 최종 근거 연결을 실제 private 원응답과 대조하여 수동 판정한다.

이 runner는 수동 실행 전용이다. 신규 스크립트 변경 시 실제 API smoke와 전체 테스트/빌드는 통합 담당자가 격리 환경에서 실행하며 중간 작업 중 운영 반복 호출을 하지 않는다.
