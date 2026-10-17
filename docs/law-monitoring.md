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

## 배포 전후 비교

배포 후 30분간 위 지표를 배포 전 1시간과 비교한다.
`internal_error` 신규 발생 또는 유효 성공률 하락이 있으면
`scripts/law-regression.ts` (15종 실데이터 회귀)를 운영 대상으로 실행해
코드 회귀와 외부 장애를 구분한다.

## 비용·인프라 영향

- 추가 DB·외부 모니터링 서비스 없음. Workers Logs 기본 제공 범위를 사용.
- 로그 1줄/요청, PII 없음. 저장 기간은 Cloudflare 기본 정책 따름.
- 외부 MCP 요청량은 기존과 동일 (관측용 추가 호출 없음).
