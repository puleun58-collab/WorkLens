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
  return {
    windowStart: logs.length ? new Date(Math.min(...logs.map((l) => l.startMs))).toISOString() : "",
    windowEnd: logs.length ? new Date(Math.max(...logs.map((l) => l.endMs))).toISOString() : "",
    total: logs.length,
    byOutcome,
    effectiveSuccessRate: billable ? ok / billable : 1,
    retries: logs.reduce((sum, l) => sum + l.retries, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}
