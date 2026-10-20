import { describe, expect, it } from "vitest";
import { checkDocument, createDictionary } from "@/lib/check";
import { classifyEnglishCorrection } from "@/lib/check/writing/english-rules";
import type { NormalizedDocument, SourceRef } from "@/domain/document";

function paragraphDocument(texts: readonly string[]): NormalizedDocument {
  return {
    id: "document:writing-check",
    fileId: "writing-check",
    kind: "docx",
    metadata: { fileName: "writing-check.docx" },
    warnings: [],
    blocks: texts.map((text, index) => {
      const source: SourceRef = {
        fileId: "writing-check",
        nodeId: `paragraph:${index + 1}`,
        label: `문단 ${index + 1}`,
        locator: { kind: "docx", part: "body", block: index + 1 },
        quote: text,
      };
      return { type: "paragraph" as const, id: source.nodeId, text, source };
    }),
  };
}

describe("writing checks", () => {
  it("reports high-confidence Korean dictionary typos with corrections", () => {
    const result = checkDocument(paragraphDocument(["역활을 정리합니다.", "되요라고 쓰지 않습니다.", "갯수를 확인합니다."]));

    for (const [ruleId, corrected] of [
      ["writing/korean/spelling:역활", "역할"],
      ["writing/korean/spelling:되요", "돼요"],
      ["writing/korean/spelling:갯수", "개수"],
    ]) {
      expect(result.findings).toContainEqual(expect.objectContaining({
        code: "suspected-typo",
        ruleId,
        confidence: "high",
        suggestedText: expect.stringContaining(corrected),
      }));
    }
  });

  it("applies 율/률 orthography without flagging valid forms", () => {
    const result = checkDocument(paragraphDocument(["확율을 계산합니다.", "환율은 증가율이 법률과 성공률, 비율표를 비교합니다."]));

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "suspected-typo",
      ruleId: "writing/korean/ratio-suffix",
      originalText: "확율",
      suggestedText: "확률",
    }));
    expect(result.findings.filter((finding) => finding.ruleId === "writing/korean/ratio-suffix" && finding.originalText !== "확율")).toEqual([]);
  });

  it("reports Korean spacing slips while preserving valid noun spacing", () => {
    const result = checkDocument(paragraphDocument([
      "운영 모델이 적용 됩니다.",
      "서울 에서 검토합니다.",
      "할수 있습니다.",
      "실수 없이 진행합니다.",
    ]));

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "korean-spacing", ruleId: "writing/korean/spacing:predicate" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "korean-spacing", ruleId: "writing/korean/spacing:particle" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "korean-spacing", ruleId: "writing/korean/spacing:bound-noun", source: expect.objectContaining({ nodeId: "paragraph:3" }) }));
    expect(result.findings.filter((finding) => finding.code === "korean-spacing" && finding.source.nodeId === "paragraph:4")).toEqual([]);
  });

  it("splits hand-verified business compounds while leaving legitimate compounds and longer words alone", () => {
    const result = checkDocument(paragraphDocument([
      "첫 평가결과와 추가 보안요구사항을 확인했습니다.",
      "정기검토와 패치관리 지침, 로그 중앙수집 현황을 점검했습니다.",
      "추가기간(약 1개월)이 주어졌고 완료예정일은 별도로 정합니다.",
      "평가결과를 공유하고 개선목록을 정리했습니다.",
      "품질관리와 변경관리 절차, 평가결과서는 기존 표기를 유지합니다.",
    ]));

    const compound = result.findings.filter((finding) => finding.ruleId === "writing/korean/spacing:compound");
    expect(compound.map((finding) => finding.originalText)).toEqual(expect.arrayContaining([
      expect.stringContaining("평가결과"),
      expect.stringContaining("보안요구사항"),
      expect.stringContaining("정기검토"),
      expect.stringContaining("패치관리"),
      expect.stringContaining("중앙수집"),
      expect.stringContaining("추가기간"),
      expect.stringContaining("완료예정일"),
      expect.stringContaining("개선목록"),
    ]));
    for (const finding of compound) {
      expect(finding.code).toBe("korean-spacing");
      expect(finding.severity).toBe("suggestion");
    }
    expect(compound.find((finding) => finding.message.includes("보안요구사항"))?.suggestedText).toContain("보안 요구사항");
    expect(compound.find((finding) => finding.message.includes("추가기간"))?.suggestedText).toContain("추가 기간(약 1개월)");
    // Legitimate compounds and longer words containing a listed form stay untouched.
    expect(compound.filter((finding) => finding.source.nodeId === "paragraph:5")).toEqual([]);
  });

  it("flags compatibility jamo left by an interrupted Korean composition", () => {
    const result = checkDocument(paragraphDocument(["향후 전망ㅇ을 검토합니다."]));

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "stray-jamo", confidence: "high" }));
  });

  it("does not let protected terms suppress duplicate-word findings", () => {
    const result = checkDocument(paragraphDocument(["WorkLens WorkLens 검토"]));

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "repeated-word",
      confidence: "high",
      originalText: "WorkLens WorkLens 검토",
    }));
  });

  it("corrects English spelling while exempting acronyms and codes", () => {
    const misspelled = checkDocument(paragraphDocument(["Recieve the report."]));
    const protectedTokens = checkDocument(paragraphDocument(["GMK WL-2026"]));

    expect(misspelled.findings).toContainEqual(expect.objectContaining({
      code: "english-spelling",
      confidence: "high",
      suggestedText: "Receive the report.",
    }));
    expect(protectedTokens.findings.filter((finding) => finding.category === "spelling" || finding.category === "terminology")).toEqual([]);
  });

  it("classifies an English correction by its certainty, not by who proposed it", () => {
    const dictionary = createDictionary(["Recievr"], ["FSC-Forecast"]);
    for (const [original, replacement] of [
      ["teh", "the"], // known typo, swapped letters
      ["attachement", "attachment"], // extra letter
      ["Quaterly", "Quarterly"], // missing letter
      ["maintanance", "maintenance"], // mistyped letter
      ["recieveed", "received"], // swapped and doubled letters
    ]) expect(classifyEnglishCorrection(original, replacement, dictionary), original).toBe("clear");
    // Registered terms are the author's spelling.
    expect(classifyEnglishCorrection("Recievr", "Receiver", dictionary)).toBe("protected");
    // Product-like mixed case and acronyms may be intentional: confirm, never assert.
    expect(classifyEnglishCorrection("WorkLnes", "WorkLens", dictionary)).toBe("uncertain");
    expect(classifyEnglishCorrection("KPIS", "KPIs", dictionary)).toBeUndefined();
    // Not spelling: case-only, inflection/word form, phrases and distant rewrites.
    for (const [original, replacement] of [
      ["Forecast", "forecast"], ["show", "shows"], ["send", "sent"], ["was", "were"],
      ["departments have", "department has"], ["correct", "correctly"], ["colour", "hue"],
    ]) expect(classifyEnglishCorrection(original, replacement, dictionary), original).toBeUndefined();
  });
});
