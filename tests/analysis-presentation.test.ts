import { describe, expect, it } from "vitest";
import type { AnalyzeResult, GroundedClaim } from "@/domain/ai";
import type { SourceRef } from "@/domain/document";
import { analysisClaimPresentation, claimDisplayText } from "@/lib/analysis-presentation";

function source(nodeId: string, slide: number): SourceRef {
  return {
    fileId: "file-1",
    documentId: "document-1",
    nodeId,
    label: `Slide ${slide} · 본문`,
    locator: { kind: "pptx", slide, shape: 0 },
    quote: slide === 1 ? "목표주가 64,550원" : "주요 제품 HT-X1 MAX",
  };
}

function inference(id: string, text: string, confidence: "high" | "medium" | "low", evidence: SourceRef[]): GroundedClaim {
  return {
    id,
    kind: "inference",
    text: `추론: ${text}`,
    confidence,
    evidence: evidence.map((item) => ({ source: item, support: "context" })) as GroundedClaim["evidence"],
  };
}

describe("analysisClaimPresentation", () => {
  it("groups grounded claims without changing values or dropping duplicate evidence", () => {
    const first = source("slide-1", 1);
    const duplicate = source("slide-2", 2);
    const product = source("slide-3", 3);
    const lowConfidence = source("slide-4", 4);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("price-1", "목표주가는 64,550원이다", "high", [first]),
        inference("price-2", "목표주가는 64,550원이다", "high", [duplicate]),
        inference("product", "주요 제품은 HT-X1 MAX이다", "medium", [product]),
        inference("uncertain", "추가 확인이 필요한 값은 12.5%이다", "low", [lowConfidence]),
      ],
      warnings: [{ code: "SOURCE_LIMIT", message: "일부 근거만 확인했습니다." }],
      rejectedClaimCount: 0,
    };

    const presentation = analysisClaimPresentation(result);

    expect(presentation.summary.map(claimDisplayText)).toEqual([
      "목표주가는 64,550원이다",
      "주요 제품은 HT-X1 MAX이다",
    ]);
    expect(presentation.summary[0].evidence.map((binding) => binding.source)).toEqual([first, duplicate]);
    expect(presentation.metrics).toEqual([
      {
        id: "price-1",
        label: "목표주가는 64,550원이다",
        value: "64,550원",
        sources: [first, duplicate],
      },
      {
        id: "product",
        label: "주요 제품은 HT-X1 MAX이다",
        value: "HT-X1",
        sources: [product],
      },
    ]);
    expect(presentation.concerns.map(claimDisplayText)).toEqual(["추가 확인이 필요한 값은 12.5%이다"]);
    expect(presentation.content).toEqual([]);
    expect(presentation.warnings).toEqual(result.warnings);
  });

  it("returns no invented sections without an Analyze result", () => {
    expect(analysisClaimPresentation(null)).toEqual({
      summary: [],
      metrics: [],
      content: [],
      concerns: [],
      warnings: [],
    });
  });
});
