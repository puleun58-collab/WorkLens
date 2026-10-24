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
  const log = (outcome: LawRequestLog["outcome"], ms = 100, retries = 0): LawRequestLog => ({
    requestId: "r", task: "full_research", startMs: 0, endMs: ms,
    httpStatus: 200, outcome, retries,
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
  it("separates complete success from partial success on the same denominator", () => {
    const summary = summarizeLawMetrics([
      log("success"), log("success"), log("partial"),
      log("external_failure"), log("timeout"),
      log("no_data"), log("cancelled"),
    ]);
    // 판정 대상 = 7 - no_data 1 - cancelled 1 = 5; effectiveSuccessRate keeps its meaning.
    expect(summary.effectiveSuccessRate).toBe(0.6);
    expect(summary.successRate).toBe(0.4);
    expect(summary.partialRate).toBe(0.2);
    expect(summary.externalFailureRate).toBe(0.2);
    expect(summary.timeoutRate).toBe(0.2);
    expect(summary.hasData).toBe(true);
  });
  it("does not classify no_data or insufficient_relevance as failures", () => {
    const summary = summarizeLawMetrics([log("no_data"), log("insufficient_relevance")]);
    expect(summary.externalFailureRate).toBe(0);
    expect(summary.timeoutRate).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.hasData).toBe(true);
  });
  it("counts actual retries: requests with retries and the accumulated total", () => {
    const summary = summarizeLawMetrics([
      log("success", 100, 2), log("external_failure", 100, 1), log("success", 100, 0),
    ]);
    expect(summary.retries).toBe(3);
    expect(summary.requestsWithRetries).toBe(2);
    expect(summary.retriedRequestRate).toBeCloseTo(2 / 3);
  });
  it("marks an empty window as having no data instead of a perfect success rate", () => {
    const summary = summarizeLawMetrics([]);
    expect(summary.hasData).toBe(false);
    expect(summary.total).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.partialRate).toBe(0);
    expect(summary.retriedRequestRate).toBe(0);
    // The legacy field keeps its documented formula; hasData is what
    // distinguishes "no requests" from a genuinely perfect window.
    expect(summary.effectiveSuccessRate).toBe(1);
  });
});
