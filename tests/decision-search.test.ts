import { describe, expect, it } from "vitest";
import { DECISION_SEARCH_ERROR, DECISION_TEXT_ERROR, decisionSearchOutcome, decisionTextOutcome } from "@/lib/decision-search";

const entry = { domain: "precedent", id: "000123", title: "부당해고", caseNumber: "2024두123", court: "대법원" };
const search = { found: true, entries: [entry], text: "[000123] 부당해고\n미분류 원문", page: 1, totalCount: 21, hasNext: true };
const detail = { found: true, text: "판시사항:\n원문 그대로\n\n미분류 항목:\n제외하지 않음", sections: [{ heading: "판시사항", text: "원문 그대로" }], expandable: true };

function response(data: unknown) { return { data }; }

describe("decision search response boundary", () => {
  it("retains zero-padded result IDs and raw source text for detail lookup", () => {
    expect(decisionSearchOutcome(true, response(search))).toEqual({ kind: "found", data: search });
    expect(decisionSearchOutcome(true, response({ ...search, page: 2, entries: [], hasNext: false })))
      .toEqual({ kind: "found", data: { ...search, page: 2, entries: [], hasNext: false } });
  });

  it("distinguishes explicit absence, service errors, and broken success envelopes", () => {
    expect(decisionSearchOutcome(true, response({ found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" }))).toEqual({ kind: "missing" });
    expect(decisionSearchOutcome(false, { error: { message: "요청이 너무 많습니다." } })).toEqual({ kind: "error", message: "요청이 너무 많습니다." });
    expect(decisionSearchOutcome(false, null)).toEqual({ kind: "error", message: DECISION_SEARCH_ERROR });
    for (const payload of [null, [], response(null), response({ found: false, marker: "NOT_FOUND" }), response({ found: false, marker: "OTHER", text: "" }), response({ ...search, found: false })]) {
      expect(decisionSearchOutcome(true, payload)).toEqual({ kind: "error", message: DECISION_SEARCH_ERROR });
    }
  });

  it("rejects invalid pagination and result metadata rather than rendering malformed records", () => {
    for (const change of [
      { text: null }, { entries: null }, { page: 0 }, { page: 1.2 }, { page: "1" },
      { totalCount: -1 }, { totalCount: 1.5 }, { hasNext: "yes" },
      { entries: [null] }, { entries: [{ ...entry, domain: "private" }] },
      { entries: [{ ...entry, id: null }] }, { entries: [{ ...entry, id: "" }] },
      { entries: [{ ...entry, title: 123 }] }, { entries: [{ ...entry, caseNumber: 123 }] },
      { entries: [{ ...entry, court: 123 }] }, { entries: [{ ...entry, summary: [] }] },
    ]) {
      expect(decisionSearchOutcome(true, response({ ...search, ...change }))).toEqual({ kind: "error", message: DECISION_SEARCH_ERROR });
    }
  });
});

describe("decision detail response boundary", () => {
  it("preserves complete text even when optional extracted sections omit unknown headings", () => {
    expect(decisionTextOutcome(true, response(detail))).toEqual({ kind: "found", data: detail });
    expect(decisionTextOutcome(true, response({ found: true, text: "표제 없는 원문" })))
      .toEqual({ kind: "found", data: { found: true, text: "표제 없는 원문" } });
  });

  it("treats only explicit NOT_FOUND as absence, never upstream failures", () => {
    expect(decisionTextOutcome(true, response({ found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" }))).toEqual({ kind: "missing" });
    expect(decisionTextOutcome(false, { error: { message: "상세 조회 실패" } })).toEqual({ kind: "error", message: "상세 조회 실패" });
    expect(decisionTextOutcome(false, { error: { message: 503 } })).toEqual({ kind: "error", message: DECISION_TEXT_ERROR });
    for (const payload of [null, [], response(null), response({ found: false, marker: "NOT_FOUND" }), response({ found: false, marker: "OTHER", text: "" }), response({ ...detail, found: false })]) {
      expect(decisionTextOutcome(true, payload)).toEqual({ kind: "error", message: DECISION_TEXT_ERROR });
    }
  });

  it("rejects malformed text, sections, metadata and expansion flags", () => {
    for (const change of [
      { text: null }, { title: 42 }, { expandable: "true" }, { sections: null },
      { sections: [null] }, { sections: [{ heading: 1, text: "raw" }] },
      { sections: [{ heading: "이유", text: null }] },
    ]) {
      expect(decisionTextOutcome(true, response({ ...detail, ...change }))).toEqual({ kind: "error", message: DECISION_TEXT_ERROR });
    }
  });
});
