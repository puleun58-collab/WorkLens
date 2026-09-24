import { describe, expect, it } from "vitest";
import type { AnalyzeResult, GroundedClaim } from "@/domain/ai";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { ExtractedField, FileExtraction } from "@/domain/extract";
import {
  analysisClaimPresentation,
  claimDisplayText,
  confirmedAnalysisItems,
  confirmedAnalysisMetrics,
  documentAnalysisTopics,
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

function inference(
  id: string,
  text: string,
  confidence: "high" | "medium" | "low",
  evidence: SourceRef[],
  role: "summary" | "insight",
): GroundedClaim {
  return {
    id,
    kind: "inference",
    text: `추론: ${text}`,
    confidence,
    presentation: { role },
    evidence: evidence.map((item) => ({ source: item, support: "context" })) as GroundedClaim["evidence"],
  };
}

function extraction(fileId: string, fileName: string, fields: ExtractedField[]): FileExtraction {
  return { file: { id: fileId, name: fileName }, fields, records: [], missing: [] };
}

describe("analysisClaimPresentation", () => {
  it("keeps separate summary and insight roles, merges duplicate evidence, and omits repeated confirmed facts", () => {
    const first = source("slide-1", 1);
    const duplicate = source("slide-2", 2);
    const product = source("slide-3", 3);
    const lowConfidence = source("slide-4", 4);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("price", "목표주가는 64,550원이다", "high", [first], "summary"),
        inference("product-1", "주요 제품은 HT-X1 MAX이다", "medium", [product], "summary"),
        inference("product-2", "주요 제품은 HT-X1 MAX이다", "medium", [duplicate], "summary"),
        inference("trend", "매출은 120에서 100으로 감소했다", "high", [first], "insight"),
        inference("uncertain", "추가 확인이 필요한 값은 12.5%이다", "low", [lowConfidence], "insight"),
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

    expect(presentation.summary.map(claimDisplayText)).toEqual(["주요 제품은 HT-X1 MAX이다"]);
    expect(presentation.summary[0].evidence.map((binding) => binding.source)).toEqual([product, duplicate]);
    expect(presentation.insights.map(claimDisplayText)).toEqual(["매출은 120에서 100으로 감소했다"]);
    expect(presentation.concerns.map(claimDisplayText)).toEqual(["추가 확인이 필요한 값은 12.5%이다"]);
    expect(presentation.warnings).toEqual(result.warnings);
  });

  it("rejects question-like insights and merges near-duplicate relationships", () => {
    const heading = source("heading", 2);
    const body = source("body", 2);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("title", "주차별 Forecast 값은 어떻게 산정되나요", "high", [heading], "insight"),
        inference("short", "Actual이 반영되면 향후 Forecast를 다시 계산합니다", "high", [body], "insight"),
        inference("full", "새로운 Actual이 반영되면 최근 8주 기준이 바뀌어 향후 Forecast를 다시 계산합니다", "high", [body], "insight"),
        inference("other", "주간 Forecast가 없으면 월간 Forecast를 사용합니다", "high", [source("fallback", 3)], "insight"),
      ],
      warnings: [],
      rejectedClaimCount: 0,
    };

    expect(analysisClaimPresentation(result).insights.map(claimDisplayText)).toEqual([
      "새로운 Actual이 반영되면 최근 8주 기준이 바뀌어 향후 Forecast를 다시 계산합니다",
      "주간 Forecast가 없으면 월간 Forecast를 사용합니다",
    ]);
  });

  it("keeps a document-wide summary over a paraphrased core fact while preserving distinct facts", () => {
    const shared = source("definition", 2);
    const distinct = source("condition", 3);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [inference("summary", "Forecast는 실제값이 없는 미래 주차에 적용하는 예상 유가입니다", "high", [shared], "summary")],
      warnings: [],
      rejectedClaimCount: 0,
    };
    const content = [
      { id: "definition", text: "Forecast는 실제값이 없는 미래 주차에 적용되는 예상 유가입니다.", sources: [shared] },
      { id: "condition", text: "주간 예측값이 없으면 월간 예측값을 적용합니다.", sources: [distinct] },
    ];
    const presented = analysisClaimPresentation(result, [], content);
    expect(presented.summary.map(claimDisplayText)).toHaveLength(1);
    expect(presented.content).toEqual([content[1]]);
    expect(analysisClaimPresentation(null, [], content).content).toEqual(content);
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
    const entries = [{
      file: { id: "file-1", name: "기업요약.pptx" },
      extraction: extraction("file-1", "기업요약.pptx", fields),
      topics: [{ id: "topic:overview", text: "기업 개요", sources: [first, repeated] }],
    }];

    expect(confirmedAnalysisItems(entries)).toEqual([{
      id: "file-1:topic:overview",
      text: "기업 개요",
      sources: [first, repeated],
    }]);
    expect(confirmedAnalysisMetrics(entries).map(({ label, value, sources }) => ({ label, value, sources }))).toEqual([
      { label: "목표주가", value: "64,550원", sources: [first, repeated] },
      { label: "시가총액", value: "2,258억 원", sources: [first] },
      { label: "상승여력", value: "232.4%", sources: [first] },
      { label: "목표주가", value: "62,000원", sources: [conflict] },
    ]);
  });

  it("presents the body rather than repeated slide headings with its own source", () => {
    const first = source("slide-1", 1);
    const repeated = source("slide-2", 2);
    const body = source("body", 3);
    const document: NormalizedDocument = {
      id: "document-file-1",
      fileId: "file-1",
      kind: "pptx",
      metadata: { fileName: "회의.pptx", pageCount: 3 },
      blocks: [
        { id: "slide-1", type: "paragraph", text: "회의 개요", role: "heading", headingLevel: 1, source: first },
        { id: "slide-2", type: "paragraph", text: "회의 개요", role: "heading", headingLevel: 1, source: repeated },
        { id: "body", type: "paragraph", text: "법적 요구 사항과 적용 범위를 검토합니다.", source: body },
      ],
      warnings: [],
    };
    expect(documentAnalysisTopics(document)).toEqual([{
      id: "topic:body",
      text: "법적 요구 사항과 적용 범위를 검토합니다.",
      sources: [body],
    }]);
  });

  it("uses a section question as context rather than a displayed fact", () => {
    const heading = source("heading", 1);
    const body = source("body", 2);
    const document: NormalizedDocument = {
      id: "document-file-1",
      fileId: "file-1",
      kind: "pdf",
      metadata: { fileName: "가이드.pdf", pageCount: 2 },
      blocks: [
        { id: "heading", type: "paragraph", text: "예측값은 무엇인가요?", role: "heading", headingLevel: 1, source: heading },
        { id: "body", type: "paragraph", text: "최근 8주 평균 유가를 기준으로 예측값을 계산합니다.", source: body },
      ],
      warnings: [],
    };
    expect(documentAnalysisTopics(document)).toEqual([{
      id: "topic:body",
      text: "최근 8주 평균 유가를 기준으로 예측값을 계산합니다.",
      sources: [body],
    }]);
  });

  it("does not turn a fourteen-heading outline into fourteen main facts", () => {
    const blocks = Array.from({ length: 14 }, (_, index) => ({
      id: `slide-${index + 1}`,
      type: "paragraph" as const,
      text: `주제 ${String.fromCharCode(0xac00 + index * 28)} 운영 기준`,
      role: "heading" as const,
      headingLevel: 1,
      source: source(`slide-${index + 1}`, index + 1),
    }));
    const document: NormalizedDocument = {
      id: "document-file-1",
      fileId: "file-1",
      kind: "pptx",
      metadata: { fileName: "운영.pptx", pageCount: 14 },
      blocks,
      warnings: [],
    };
    expect(documentAnalysisTopics(document)).toEqual([]);
  });

  it("keeps equal labels from different files separate and names each deterministic summary", () => {
    const first = source("a", 1, "file-a");
    const second = source("b", 1, "file-b");
    const entries = [
      {
        file: { id: "file-a", name: "A.xlsx" },
        extraction: extraction("file-a", "A.xlsx", [{ field: "서울 단가", displayValue: "130,000원", type: "Money", sources: [first] }]),
        topics: [{ id: "topic:a", text: "서울 운영", sources: [first] }],
      },
      {
        file: { id: "file-b", name: "B.xlsx" },
        extraction: extraction("file-b", "B.xlsx", [{ field: "서울 단가", displayValue: "135,000원", type: "Money", sources: [second] }]),
        topics: [{ id: "topic:b", text: "서울 운영", sources: [second] }],
      },
    ];

    expect(confirmedAnalysisItems(entries).map((item) => item.text)).toEqual([
      "A.xlsx: 서울 운영",
      "B.xlsx: 서울 운영",
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
      topics: fields.map((field, index) => ({ id: `topic:${index}`, text: field.field, sources: field.sources })),
    }];

    expect(confirmedAnalysisItems(entries)).toEqual(
      sources.map((item, index) => ({
        id: `file-1:topic:${index}`,
        text: `항목 ${index + 1}`,
        sources: [item],
      })),
    );
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
    expect(confirmedAnalysisMetrics([{ file: extracted.file, extraction: extracted, topics: [] }])).toEqual([]);
  });

  it("returns no invented sections without an Analyze result", () => {
    expect(analysisClaimPresentation(null)).toEqual({
      content: [],
      summary: [],
      insights: [],
      concerns: [],
      warnings: [],
    });
  });
});
