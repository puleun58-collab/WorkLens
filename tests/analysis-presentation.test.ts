import { describe, expect, it } from "vitest";
import type { AnalyzeResult, GroundedClaim } from "@/domain/ai";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { ExtractedField, FileExtraction } from "@/domain/extract";
import {
  analysisClaimPresentation,
  claimDisplayText,
  confirmedAnalysisItems,
  confirmedAnalysisMetrics,
} from "@/lib/analysis-presentation";
import { autoExtract } from "@/lib/extract/auto";

function source(nodeId: string, slide: number, fileId = "file-1"): SourceRef {
  return {
    fileId,
    documentId: `document-${fileId}`,
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

function extraction(fileId: string, fileName: string, fields: ExtractedField[]): FileExtraction {
  return { file: { id: fileId, name: fileName }, fields, records: [], missing: [] };
}

describe("analysisClaimPresentation", () => {
  it("keeps narrative interpretation, merges duplicate evidence, and omits repeated confirmed facts", () => {
    const first = source("slide-1", 1);
    const duplicate = source("slide-2", 2);
    const product = source("slide-3", 3);
    const lowConfidence = source("slide-4", 4);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("price", "목표주가는 64,550원이다", "high", [first]),
        inference("product-1", "주요 제품은 HT-X1 MAX이다", "medium", [product]),
        inference("product-2", "주요 제품은 HT-X1 MAX이다", "medium", [duplicate]),
        inference("trend", "매출은 120에서 100으로 감소했다", "high", [first]),
        inference("uncertain", "추가 확인이 필요한 값은 12.5%이다", "low", [lowConfidence]),
      ],
      warnings: [{ code: "SOURCE_LIMIT", message: "일부 근거만 확인했습니다." }],
      rejectedClaimCount: 0,
    };
    const fields: ExtractedField[] = [{
      field: "목표주가",
      displayValue: "64,550원",
      type: "Money",
      sources: [first],
    }];

    const presentation = analysisClaimPresentation(result, fields);

    expect(presentation.summary.map(claimDisplayText)).toEqual([
      "주요 제품은 HT-X1 MAX이다",
      "매출은 120에서 100으로 감소했다",
    ]);
    expect(presentation.summary[0].evidence.map((binding) => binding.source)).toEqual([product, duplicate]);
    expect(presentation.concerns.map(claimDisplayText)).toEqual(["추가 확인이 필요한 값은 12.5%이다"]);
    expect(presentation.warnings).toEqual(result.warnings);
  });

  it("builds an ordered deterministic summary and confirmed metrics from extraction only", () => {
    const first = source("slide-1", 1);
    const repeated = source("slide-2", 2);
    const conflict = source("slide-3", 3);
    const fields: ExtractedField[] = [
      { field: "목표주가", displayValue: "64,550원", normalizedValue: "64550", type: "Money", sources: [first, repeated] },
      { field: "시가총액", displayValue: "2,258억 원", type: "Money", sources: [first] },
      { field: "상승여력", displayValue: "232.4%", normalizedValue: "232.4", type: "Percent", sources: [first] },
      { field: "기준일", displayValue: "2025.05.02", type: "Date", sources: [first] },
      { field: "담당자", displayValue: "김OO", type: "Text", sources: [first] },
      { field: "Source", displayValue: "회사 공시", type: "Text", sources: [first] },
      { field: "목표주가", displayValue: "62,000원", normalizedValue: "62000", type: "Money", sources: [conflict] },
    ];
    const entries = [{ file: { id: "file-1", name: "기업요약.pptx" }, extraction: extraction("file-1", "기업요약.pptx", fields) }];

    expect(confirmedAnalysisItems(entries)).toEqual([{
      id: "confirmed-items:file-1",
      text: "목표주가 · 시가총액 · 상승여력 · 기준일 · 담당자",
      sources: [first, repeated, conflict],
    }]);
    expect(confirmedAnalysisMetrics(entries).map(({ label, value, sources }) => ({ label, value, sources }))).toEqual([
      { label: "목표주가", value: "64,550원", sources: [first, repeated] },
      { label: "시가총액", value: "2,258억 원", sources: [first] },
      { label: "상승여력", value: "232.4%", sources: [first] },
      { label: "목표주가", value: "62,000원", sources: [conflict] },
    ]);
  });

  it("keeps equal labels from different files separate and names each deterministic summary", () => {
    const first = source("a", 1, "file-a");
    const second = source("b", 1, "file-b");
    const entries = [
      {
        file: { id: "file-a", name: "A.xlsx" },
        extraction: extraction("file-a", "A.xlsx", [{ field: "서울 단가", displayValue: "130,000원", type: "Money", sources: [first] }]),
      },
      {
        file: { id: "file-b", name: "B.xlsx" },
        extraction: extraction("file-b", "B.xlsx", [{ field: "서울 단가", displayValue: "135,000원", type: "Money", sources: [second] }]),
      },
    ];

    expect(confirmedAnalysisItems(entries).map((item) => item.text)).toEqual([
      "A.xlsx: 서울 단가",
      "B.xlsx: 서울 단가",
    ]);
    expect(confirmedAnalysisMetrics(entries).map((metric) => [metric.fileName, metric.value])).toEqual([
      ["A.xlsx", "130,000원"],
      ["B.xlsx", "135,000원"],
    ]);
  });

  it("links confirmed core items only to the labels shown on screen", () => {
    const sources = Array.from({ length: 7 }, (_, index) => source(`field-${index}`, index + 1));
    const fields = sources.map((item, index): ExtractedField => ({
      field: `항목 ${index + 1}`,
      displayValue: `값 ${index + 1}`,
      type: "Text",
      sources: [item],
    }));
    const entries = [{
      file: { id: "file-1", name: "항목.pptx" },
      extraction: extraction("file-1", "항목.pptx", fields),
    }];

    expect(confirmedAnalysisItems(entries)).toEqual([{
      id: "confirmed-items:file-1",
      text: "항목 1 · 항목 2 · 항목 3 · 항목 4 · 항목 5 · 항목 6 · 외 1개",
      sources: sources.slice(0, 6),
    }]);
  });

  it("does not create a confirmed metric from a number embedded in prose", () => {
    const proseSource = source("prose", 1);
    const document: NormalizedDocument = {
      id: "document-file-1",
      fileId: "file-1",
      kind: "pptx",
      metadata: { fileName: "계획.pptx" },
      blocks: [{ id: "prose", type: "paragraph", text: "올해 75명을 추가 채용할 계획입니다.", source: proseSource }],
      warnings: [],
    };
    const extracted = autoExtract(document, { id: "file-1", name: "계획.pptx" });

    expect(extracted.fields).toEqual([]);
    expect(confirmedAnalysisMetrics([{ file: extracted.file, extraction: extracted }])).toEqual([]);
  });

  it("returns no invented sections without an Analyze result", () => {
    expect(analysisClaimPresentation(null)).toEqual({
      summary: [],
      concerns: [],
      warnings: [],
    });
  });
});
