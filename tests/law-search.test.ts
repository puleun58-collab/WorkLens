import { describe, expect, it } from "vitest";
import { formatLawDate, LAW_ARTICLE_PATTERN, LAW_FALLBACK_ERROR, LAW_TEXT_FALLBACK_ERROR, lawOutcome, lawStatusTone, lawTextIdentifier, lawTextOutcome } from "@/lib/law-search";

describe("law search outcome", () => {
  const law = { name: "근로기준법", lawId: "001872", mst: "283457", status: "현행" };

  it("keeps identifiers of found laws for the later text lookup", () => {
    expect(lawOutcome(true, { data: { found: true, laws: [law] } })).toEqual({ kind: "found", laws: [law] });
  });

  it("treats only an explicit found:false as no result", () => {
    expect(lawOutcome(true, { data: { found: false, marker: "NOT_FOUND" } })).toEqual({ kind: "empty" });
  });

  it("never reports an outage as no result", () => {
    expect(lawOutcome(false, { error: { code: "LAW_RATE_LIMITED", message: "요청이 많습니다." } })).toEqual({ kind: "error", message: "요청이 많습니다." });
    expect(lawOutcome(false, null)).toEqual({ kind: "error", message: LAW_FALLBACK_ERROR });
    expect(lawOutcome(false, { error: { message: 42 } })).toEqual({ kind: "error", message: LAW_FALLBACK_ERROR });
    // A success that claims results but lists none is malformed, not empty.
    expect(lawOutcome(true, { data: { found: true, laws: [] } })).toEqual({ kind: "error", message: LAW_FALLBACK_ERROR });
  });

  it("formats compact dates and leaves other shapes untouched", () => {
    expect(formatLawDate("20260820")).toBe("2026.08.20");
    expect(formatLawDate("2026-08-20")).toBe("2026-08-20");
    expect(formatLawDate(undefined)).toBeUndefined();
  });

  it("maps statuses to tones without inventing one", () => {
    expect(lawStatusTone("현행")).toBe("current");
    expect(lawStatusTone("시행예정")).toBe("upcoming");
    expect(lawStatusTone("폐지")).toBe("muted");
    expect(lawStatusTone(undefined)).toBeUndefined();
  });
});

describe("law text outcome", () => {
  it("prefers an MST and falls back to a valid law ID", () => {
    expect(lawTextIdentifier({ name: "법률", mst: "283457", lawId: "001872" })).toEqual({ mst: "283457" });
    expect(lawTextIdentifier({ name: "시행령", lawId: "003058" })).toEqual({ lawId: "003058" });
    expect(lawTextIdentifier({ name: "식별자 없음", mst: "bad" })).toBeNull();
  });

  it("accepts only the agreed Korean article shapes", () => {
    expect(LAW_ARTICLE_PATTERN.test("제74조")).toBe(true);
    expect(LAW_ARTICLE_PATTERN.test("제10조의2")).toBe(true);
    for (const invalid of ["74", "제74조 ", "제0조", "제10조의0", "제1조의123", "제12345조", "제1조 제2항"]) {
      expect(LAW_ARTICLE_PATTERN.test(invalid)).toBe(false);
    }
  });

  it("keeps raw successful text and parsed TOC items", () => {
    const data = { found: true, mode: "toc", text: "목차 (총 132개 조문)\n\n제74조 임산부의 보호", articles: [{ jo: "제74조", title: "임산부의 보호" }] };
    expect(lawTextOutcome(true, { data })).toEqual({ kind: "found", data });
  });

  it("distinguishes an explicit NOT_FOUND from malformed and failed responses", () => {
    expect(lawTextOutcome(true, { data: { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" } })).toEqual({ kind: "missing" });
    expect(lawTextOutcome(true, { data: { found: false, marker: "OTHER" } })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    expect(lawTextOutcome(true, { data: { found: true, mode: "toc" } })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    expect(lawTextOutcome(true, { data: { found: true, mode: "toc", text: "raw", articles: [{ jo: 74, title: "title" }] } })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    expect(lawTextOutcome(false, { data: { found: false, marker: "NOT_FOUND" }, error: { message: "원문 서비스 오류" } })).toEqual({ kind: "error", message: "원문 서비스 오류" });
    expect(lawTextOutcome(false, null)).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    expect(lawTextOutcome(false, { error: { message: 503 } })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    expect(lawTextOutcome(true, { data: null })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    expect(lawTextOutcome(true, { data: "raw text" })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
  });

  it("rejects malformed metadata and TOC entries instead of rendering untrusted response shapes", () => {
    const valid = { found: true, mode: "toc", text: "목차", articles: [{ jo: "제10조의2", title: "국가의 책무" }] };
    expect(lawTextOutcome(true, { data: valid })).toEqual({ kind: "found", data: valid });
    for (const changes of [
      { name: 42 }, { promulgationDate: 20260219 }, { effectiveDate: null },
      { articles: "제74조" }, { articles: [null] }, { articles: [{ jo: "제0조", title: "잘못된 번호" }] },
      { articles: [{ jo: "제74조", title: 74 }] },
    ]) {
      expect(lawTextOutcome(true, { data: { ...valid, ...changes } })).toEqual({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    }
  });
});
