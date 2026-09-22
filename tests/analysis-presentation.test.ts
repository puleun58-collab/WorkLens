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

  it("uses only explicit headings, keeps order, and merges repeated heading sources", () => {
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
        { id: "body", type: "paragraph", text: "법적 요구 사항을 검토합니다.", source: body },
      ],
      warnings: [],
    };
    expect(documentAnalysisTopics(document)).toEqual([{
      id: "topic:slide-1",
      text: "회의 개요",
      sources: [first, repeated],
    }]);
  });

  it("keeps the document's sections and drops the parts that only name the file", () => {
    const page = (nodeId: string, pageNumber: number): SourceRef => ({
      fileId: "file-1",
      nodeId,
      label: `페이지 ${pageNumber}`,
      page: pageNumber,
      locator: { kind: "pdf", page: pageNumber, spans: [] },
    });
    const heading = (id: string, text: string, pageNumber: number) => ({
      id,
      type: "paragraph" as const,
      text,
      role: "heading" as const,
      headingLevel: 1,
      source: page(id, pageNumber),
    });
    const document: NormalizedDocument = {
      id: "document-file-1",
      fileId: "file-1",
      kind: "pdf",
      metadata: { fileName: "가이드.pdf", pageCount: 5 },
      blocks: [
        heading("cover", "예측값 산정 가이드", 1),
        heading("author", "정하건 지음", 1),
        heading("toc", "차례", 2),
        heading("toc-entry", "값 선택 순서 3", 2),
        heading("chapter", "C H A P T E R", 3),
        heading("definition", "예측값은 무엇인가요?", 3),
        heading("basis", "값은 어떻게 산정되나요?", 4),
        heading("order", "값 선택 순서", 4),
        { id: "body", type: "paragraph" as const, text: "최근 평균으로 계산합니다.", source: page("body", 4) },
        heading("colophon", "예측값 산정 가이드 — 안내서", 5),
      ],
      warnings: [],
    };

    expect(documentAnalysisTopics(document).map((topic) => topic.text)).toEqual([
      "예측값은 무엇인가요?",
      "값은 어떻게 산정되나요?",
      "값 선택 순서",
    ]);
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
      summary: [],
      concerns: [],
      warnings: [],
    });
  });
});
