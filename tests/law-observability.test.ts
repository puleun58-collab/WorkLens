import { describe, expect, it } from "vitest";
import {
  classifyLawError,
  formatLawLog,
  summarizeLawMetrics,
  type LawRequestLog,
} from "@/lib/law-observability";

describe("classifyLawError", () => {
  it("maps upstream codes to external_failure/timeout", () => {
    expect(classifyLawError("LAW_RATE_LIMITED")).toBe("external_failure");
    expect(classifyLawError("LAW_UPSTREAM_TIMEOUT")).toBe("timeout");
    expect(classifyLawError("LAW_UPSTREAM_UNAVAILABLE")).toBe("external_failure");
    expect(classifyLawError("LAW_MCP_ERROR")).toBe("external_failure");
  });
  it("maps cancellation separately from failures", () => {
    expect(classifyLawError("LAW_REQUEST_ABORTED")).toBe("cancelled");
  });
  it("falls back to internal_error for unknown codes", () => {
    expect(classifyLawError("SOMETHING_ELSE")).toBe("internal_error");
    expect(classifyLawError(undefined)).toBe("internal_error");
  });
});

describe("formatLawLog", () => {
  it("emits a single JSON line with metadata only", () => {
    const line = formatLawLog({
      requestId: "r1", task: "full_research", startMs: 1000, endMs: 2500,
      httpStatus: 200, outcome: "success", retries: 0,
    });
    const parsed = JSON.parse(line);
    expect(parsed.scope).toBe("law_request");
    expect(parsed.durationMs).toBe(1500);
    expect(parsed.requestId).toBe("r1");
    // No PII fields
    expect(parsed.query).toBeUndefined();
    expect(parsed.document).toBeUndefined();
    expect(line).not.toContain("\n");
  });
});

describe("summarizeLawMetrics", () => {
  const log = (outcome: LawRequestLog["outcome"], ms = 100): LawRequestLog => ({
    requestId: "r", task: "full_research", startMs: 0, endMs: ms,
    httpStatus: 200, outcome, retries: 0,
  });
  it("excludes no_data/insufficient_relevance/cancelled from the success-rate denominator", () => {
    const summary = summarizeLawMetrics([
      log("success"), log("success"), log("partial"),
      log("no_data"), log("insufficient_relevance"), log("cancelled"),
      log("external_failure"),
    ]);
    expect(summary.total).toBe(7);
    expect(summary.byOutcome.success).toBe(2);
    expect(summary.byOutcome.no_data).toBe(1);
    // (2 success + 1 partial) / (7 - 1 - 1 - 1) = 3/4
    expect(summary.effectiveSuccessRate).toBe(0.75);
  });
  it("computes p50/p95", () => {
    const summary = summarizeLawMetrics([log("success", 100), log("success", 200), log("success", 300)]);
    expect(summary.p50Ms).toBe(200);
    expect(summary.p95Ms).toBe(300);
  });
});
