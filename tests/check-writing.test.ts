import { describe, expect, it } from "vitest";
import { checkDocument } from "@/lib/check";
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
});
