/**
 * 법령 MCP/API 운영 관측 (8순위).
 *
 * 기존 Cloudflare Workers 로깅(console → Workers Logs)을 그대로 사용한다.
 * 새 DB·외부 모니터링 서비스·유료 도구를 추가하지 않는다.
 *
 * 로그에는 메타데이터만 기록하고, 질문 원문·문서 내용·토큰·API 키·상담 정보 등
 * 개인정보·민감정보를 절대 포함하지 않는다.
 */

/** 운영 오류 분류. 정상 자료 없음은 장애율에 포함하지 않고, 외부 실패는 성공률에 포함하지 않는다. */
export type LawOutcomeClass =
  | "success"               // 요청·검증 정상 완료
  | "no_data"               // 조회는 정상이나 해당 자료 없음 (정상)
  | "insufficient_relevance"// 조회 자료를 직접 근거로 채택하지 못함 (정상)
  | "partial"               // 일부 자료 확인, 일부 조회 실패
  | "external_failure"      // MCP/API 외부 장애
  | "timeout"               // 요청 시간 예산 초과
  | "internal_error"        // WorkLens 처리 오류
  | "cancelled";            // 사용자·시스템의 정상 요청 취소

/** ApiError 코드 → 운영 분류. */
const CODE_CLASS: Record<string, LawOutcomeClass> = {
  LAW_RATE_LIMITED: "external_failure",
  LAW_UPSTREAM_TIMEOUT: "timeout",
  LAW_UPSTREAM_UNAVAILABLE: "external_failure",
  LAW_UPSTREAM_NO_DATA: "external_failure",
  LAW_MCP_ERROR: "external_failure",
  LAW_AUTH_FAILED: "external_failure",
  LAW_REQUEST_ABORTED: "cancelled",
  OPERATION_CAPACITY: "timeout",
  AI_RATE_LIMITED: "external_failure",
};

export function classifyLawError(code: string | undefined): LawOutcomeClass {
  if (!code) return "internal_error";
  return CODE_CLASS[code] ?? "internal_error";
}

/**
 * 요청 1건에 누적되는 실제 MCP 재시도 횟수. 라우트가 생성해 요청 context로
 * 전달하고, `callLawTool`이 재시도가 발생할 때마다 증가시킨다. 한 요청 안에서
 * 병렬로 실행되는 MCP 호출이 같은 객체를 공유해도 증가 연산 자체는 동기라
 * 요청 단위 합산이 정확하다. 추측이나 고정값으로 대체하지 않는다.
 */
export interface LawRequestStats {
  retries: number;
}

/** 법령 요청 1건의 관측 메타데이터 (PII 없음). */
export interface LawRequestLog {
  requestId: string;
  /** API task (full_research, law_system, ...). */
  task: string;
  startMs: number;
  endMs: number;
  /** HTTP 상태 코드. */
  httpStatus: number;
  outcome: LawOutcomeClass;
  /** ApiError 코드 (성공 시 생략). */
  errorCode?: string;
  /** MCP 재시도 횟수. */
  retries: number;
  /** 근거 관련성·원문 검증 수행 여부. */
  evidenceVerified?: boolean;
  /** MCP 조회 소요 시간(ms). */
  mcpMs?: number;
}

/** Workers Logs에서 파싱 가능한 단일 JSON 라인. */
export function formatLawLog(log: LawRequestLog): string {
  const { startMs, endMs, ...rest } = log;
  return JSON.stringify({
    scope: "law_request",
    durationMs: endMs - startMs,
    ...rest,
  });
}

/**
 * 분 단위 집계용 카운터 스냅샷. Workers에서는 로그 라인으로 배출하고,
 * 집계는 `wrangler tail --format json` 또는 Logpush 없이 로그 검색으로 수행한다.
 */
export interface LawMetricsSnapshot {
  windowStart: string;
  windowEnd: string;
  total: number;
  byOutcome: Record<LawOutcomeClass, number>;
  /** 성공률 분모에서 no_data/insufficient_relevance/cancelled를 제외한 값. */
  effectiveSuccessRate: number;
  retries: number;
  p50Ms: number;
  p95Ms: number;
  /** 표본 유무. false인 경우 아래 비율 지표는 실제 운영 성공을 뜻하지 않는다. */
  hasData: boolean;
  /**
   * 완전 성공률: success / 판정 대상. 판정 대상은 effectiveSuccessRate와 같은
   * 분모(전체 − no_data − insufficient_relevance − cancelled)다. 부분 성공을
   * 포함하지 않으므로 effectiveSuccessRate와 나란히 봐야 한다.
   */
  successRate: number;
  /** 부분 성공률: partial / 판정 대상. */
  partialRate: number;
  /** 외부 장애율: external_failure / 판정 대상. */
  externalFailureRate: number;
  /** 시간 초과율: timeout / 판정 대상. */
  timeoutRate: number;
  /** 재시도가 1회 이상 발생한 요청 수. */
  requestsWithRetries: number;
  /** 재시도 발생 요청 비율: requestsWithRetries / 전체 요청. */
  retriedRequestRate: number;
}

const OUTCOMES: LawOutcomeClass[] = [
  "success", "no_data", "insufficient_relevance", "partial",
  "external_failure", "timeout", "internal_error", "cancelled",
];

export function summarizeLawMetrics(logs: LawRequestLog[]): LawMetricsSnapshot {
  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<LawOutcomeClass, number>;
  for (const log of logs) byOutcome[log.outcome]++;
  const billable = logs.length - byOutcome.no_data - byOutcome.insufficient_relevance - byOutcome.cancelled;
  const ok = byOutcome.success + byOutcome.partial;
  const durations = logs.map((l) => l.endMs - l.startMs).sort((a, b) => a - b);
  const percentile = (p: number) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))]! : 0;
  // 세부 비율의 분모는 effectiveSuccessRate와 동일하게 판정 대상으로 통일한다.
  // 분모가 0이면 비율은 0이며, hasData가 표본 자체의 유무를 따로 알린다.
  const rate = (count: number) => billable ? count / billable : 0;
  const requestsWithRetries = logs.filter((log) => log.retries > 0).length;
  return {
    windowStart: logs.length ? new Date(Math.min(...logs.map((l) => l.startMs))).toISOString() : "",
    windowEnd: logs.length ? new Date(Math.max(...logs.map((l) => l.endMs))).toISOString() : "",
    total: logs.length,
    byOutcome,
    effectiveSuccessRate: billable ? ok / billable : 1,
    retries: logs.reduce((sum, l) => sum + l.retries, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    hasData: logs.length > 0,
    successRate: rate(byOutcome.success),
    partialRate: rate(byOutcome.partial),
    externalFailureRate: rate(byOutcome.external_failure),
    timeoutRate: rate(byOutcome.timeout),
    requestsWithRetries,
    retriedRequestRate: logs.length ? requestsWithRetries / logs.length : 0,
  };
}
