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

  it("rejects question-like insights and retains a narrower trigger rather than merging it", () => {
    const heading = source("heading", 2);
    const body = source("body", 2);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("title", "주차별 Forecast 값은 어떻게 산정되나요", "high", [heading], "insight"),
        inference("short", "Actual이 반영되면 최근 8주 기준이 바뀌어 향후 Forecast를 다시 계산합니다", "high", [body], "insight"),
        inference("full", "새로운 Actual이 반영되면 최근 8주 기준이 바뀌어 향후 Forecast를 다시 계산합니다", "high", [body], "insight"),
        inference("other", "주간 Forecast가 없으면 월간 Forecast를 사용합니다", "high", [source("fallback", 3)], "insight"),
      ],
      warnings: [],
      rejectedClaimCount: 0,
    };

    expect(analysisClaimPresentation(result).insights.map(claimDisplayText)).toEqual([
      "Actual이 반영되면 최근 8주 기준이 바뀌어 향후 Forecast를 다시 계산합니다",
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

  it("shows a low-confidence claim only for review rather than again as core content", () => {
    const evidence = source("review", 2);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [inference("review", "The compliance team reviews exceptions quarterly.", "low", [evidence], "insight")],
      warnings: [], rejectedClaimCount: 0,
    };
    const content = [
      { id: "review", text: "The compliance team reviews exceptions quarterly.", sources: [evidence] },
      { id: "receipt", text: "Employees submit receipts within ten days.", sources: [source("receipt", 3)] },
    ];
    const presented = analysisClaimPresentation(result, [], content);
    expect(presented.concerns).toHaveLength(1);
    expect(presented.content).toEqual([content[1]]);
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

  it("keeps distinct conditions and values while collapsing the same grounded relationship across roles", () => {
    const shared = source("rules", 1);
    const otherFile = source("rules", 1, "file-2");
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("summary", "If the audit report is delayed, notify the compliance lead.", "high", [shared], "summary"),
        inference("insight", "If audit report is delayed, notify the compliance lead.", "high", [shared], "insight"),
        inference("condition", "If the permit is delayed, notify the compliance lead.", "high", [shared], "insight"),
        inference("value", "If the audit report is delayed, notify the compliance lead within 2 days.", "high", [shared], "insight"),
        inference("another-file", "If the audit report is delayed, notify the compliance lead.", "high", [otherFile], "insight"),
        inference("bare", "Revenue increased.", "high", [shared], "insight"),
      ],
      warnings: [], rejectedClaimCount: 0,
    };
    const presented = analysisClaimPresentation(result, [], [
      { id: "duplicate", text: "If the audit report is delayed, notify the compliance lead.", sources: [shared] },
      { id: "other-file", text: "If the audit report is delayed, notify the compliance lead.", sources: [otherFile] },
    ]);
    expect(presented.summary.map(claimDisplayText)).toEqual(["If the audit report is delayed, notify the compliance lead."]);
    expect(presented.insights.map(claimDisplayText)).toEqual([
      "If the permit is delayed, notify the compliance lead.",
      "If the audit report is delayed, notify the compliance lead within 2 days.",
      "If the audit report is delayed, notify the compliance lead.",
    ]);
    expect(presented.content).toEqual([]);
  });

  it("selects an ordered process with its step sources and omits recurring cover furniture", () => {
    const blocks = [
      { id: "cover", type: "paragraph" as const, role: "heading" as const, text: "Service handbook", source: source("cover", 1) },
      { id: "footer1", type: "paragraph" as const, text: "Harbor administration / controlled copy", source: source("footer1", 1) },
      { id: "first", type: "paragraph" as const, text: "1. Review the application and verify the applicant identity", source: source("first", 2) },
      { id: "second", type: "paragraph" as const, text: "2. Approve the request and notify the applicant", source: source("second", 2) },
      { id: "third", type: "paragraph" as const, text: "3. Issue the signed decision to the applicant", source: source("third", 2) },
      { id: "footer2", type: "paragraph" as const, text: "Harbor administration / controlled copy", source: source("footer2", 2) },
    ];
    const document: NormalizedDocument = {
      id: "process", fileId: "file-1", kind: "pdf", metadata: { fileName: "handbook.pdf" }, blocks, warnings: [],
    };
    const topics = documentAnalysisTopics(document);
    expect(topics).toEqual([{
      id: "topic:first:sequence",
      text: "1. Review the application and verify the applicant identity → 2. Approve the request and notify the applicant → 3. Issue the signed decision to the applicant",
      sources: [blocks[2].source, blocks[3].source, blocks[4].source],
    }]);
  });

  it("presents labeled table facts with cell provenance rather than a numeric dump", () => {
    const cell = (id: string, text: string, slide = 1) => ({
      display: text, value: text, source: source(id, slide),
    });
    const header = [cell("h-region", "Region"), cell("h-year", "2026"), cell("h-cost", "Budget")];
    const north = [cell("north", "North"), cell("north-year", "2026"), cell("north-cost", "$125")];
    const south = [cell("south", "South"), cell("south-year", "2026"), cell("south-cost", "0")];
    const document: NormalizedDocument = {
      id: "budget", fileId: "file-1", kind: "xlsx", metadata: { fileName: "budget.xlsx" },
      blocks: [{ id: "sheet", type: "table", source: source("sheet", 1), rows: [header, north, south] }],
      warnings: [],
    };
    const topics = documentAnalysisTopics(document);
    expect(topics.map(({ text }) => text)).toEqual([
      "North — 2026 · Budget: $125",
      "South — 2026 · Budget: 0",
    ]);
    expect(topics[0].sources).toEqual([
      north[0].source, header[1].source, north[1].source, header[2].source, north[2].source,
    ]);
    expect(topics[1].sources).toContain(south[2].source);
  });

  it("keeps prose key-value tables and skips table headers in policy documents", () => {
    const cell = (id: string, text: string) => ({ display: text, value: text, source: source(id, 1) });
    const purpose = [cell("purpose", "Purpose"), cell("purpose-value", "Coordinate the emergency response across departments.")];
    const exception = [cell("exception", "Exception"), cell("exception-value", "When the lead is absent, the deputy takes responsibility.")];
    const policy: NormalizedDocument = {
      id: "policy", fileId: "file-1", kind: "docx", metadata: { fileName: "policy.docx" },
      blocks: [{ id: "policy-table", type: "table", source: source("table", 1), rows: [purpose, exception] }],
      warnings: [],
    };
    expect(documentAnalysisTopics(policy)).toEqual([
      { id: "topic:policy-table:row:0", text: "Purpose — Coordinate the emergency response across departments.", sources: [purpose[0].source, purpose[1].source] },
      { id: "topic:policy-table:row:1", text: "Exception — When the lead is absent, the deputy takes responsibility.", sources: [exception[0].source, exception[1].source] },
    ]);
    const headers = [cell("condition-header", "Condition"), cell("action-header", "Action")];
    const rule = [cell("missing", "Missing permit"), cell("hold", "Hold dispatch until clearance is granted.")];
    expect(documentAnalysisTopics({
      ...policy, kind: "pdf",
      blocks: [{ id: "rule-table", type: "table", source: source("rule-table", 1), rows: [headers, rule] }],
    })).toEqual([{
      id: "topic:rule-table:row:1",
      text: "Missing permit — Action: Hold dispatch until clearance is granted.",
      sources: [rule[0].source, headers[1].source, rule[1].source],
    }]);
  });

  it("prioritizes a later table exception over routine rows and retains its cell sources", () => {
    const cell = (id: string, text: string) => ({ display: text, value: text, source: source(id, 1) });
    const rows = [
      [cell("category", "Category"), cell("action", "Action")],
      ...Array.from({ length: 27 }, (_, index) => [
        cell(`routine-${index}`, `Routine ${index + 1}`),
        cell(`copy-${index}`, "Copy the schedule to the shared folder."),
      ]),
      [cell("exception", "Missing permit"), cell("response", "If the permit is missing, hold dispatch until approval.")],
    ];
    const document: NormalizedDocument = {
      id: "rules", fileId: "file-1", kind: "xlsx", metadata: { fileName: "rules.xlsx" },
      blocks: [{ id: "sheet", type: "table", source: source("sheet", 1), rows }],
      warnings: [],
    };

    const topics = documentAnalysisTopics(document);
    expect(topics.some((topic) => topic.text.includes("hold dispatch")
      && topic.sources.some((item) => item.nodeId === "response"))).toBe(true);
  });

  it("keeps Korean conditional endings as relationships without elevating a bare fact", () => {
    const evidence = source("budget-rule", 2);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("conditional", "비용이 늘어나면 예산을 다시 검토합니다.", "high", [evidence], "insight"),
        inference("fact", "현재 비용은 52억원입니다.", "high", [source("amount", 1)], "insight"),
      ],
      warnings: [], rejectedClaimCount: 0,
    };

    expect(analysisClaimPresentation(result).insights.map(claimDisplayText)).toEqual([
      "비용이 늘어나면 예산을 다시 검토합니다.",
    ]);
  });

  it("recognizes a shared-source approval prerequisite across word order and voice without repeating it as content or insight", () => {
    const first = source("rule", 1);
    const second = source("restated-rule", 2);
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [
        inference("summary", "팀장 승인 이후 구매 담당자가 발주를 등록합니다.", "high", [first, second], "summary"),
        inference("relation", "팀장 승인이 완료되면 구매 담당자가 발주를 등록합니다.", "high", [second], "insight"),
      ],
      warnings: [], rejectedClaimCount: 0,
    };
    const content = [
      { id: "restatement", text: "팀장 승인이 완료된 뒤 구매 담당자가 발주를 등록합니다.", sources: [second] },
      { id: "novel", text: "구매 담당자는 처리 내역을 별도로 보관합니다.", sources: [second] },
    ];
    const presented = analysisClaimPresentation(result, [], content);
    expect(presented.summary).toHaveLength(1);
    expect(presented.summary[0].evidence.map(({ source: evidence }) => evidence)).toEqual([first, second]);
    expect(presented.insights).toEqual([]);
    expect(presented.content).toEqual([content[1]]);
  });

  it("keeps changed arguments, states, scope, values, direction, deadlines and rounding rules", () => {
    const shared = source("rule", 1);
    const baseline = "팀장 승인 이후 구매 담당자가 발주를 등록합니다.";
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [inference("summary", baseline, "high", [shared], "summary")],
      warnings: [], rejectedClaimCount: 0,
    };
    const changes = [
      "실장 승인 이후 구매 담당자가 발주를 등록합니다.",
      "팀장 거절 이후 구매 담당자가 발주를 등록합니다.",
      "팀장 승인 이후 구매 담당자가 발주를 안 등록합니다.",
      "팀장 승인 이전 구매 담당자가 발주를 등록합니다.",
      "팀장 승인 이후 구매 담당자가 발주를 2건 등록합니다.",
      "팀장 승인 이후 구매 담당자가 발주를 등록하고 기록을 보관합니다.",
      "팀장 승인 이후 구매 담당자가 발주를 등록하되 예외를 허용합니다.",
      "팀장 승인 이후 구매 담당자가 발주를 금요일까지 등록합니다.",
      "팀장 승인 이후 구매 담당자가 발주를 반올림하여 등록합니다.",
    ];
    const topics = changes.map((text, index) => ({ id: `difference-${index}`, text, sources: [shared] }));
    topics.push({ id: "other-file", text: baseline, sources: [source("rule", 1, "other-file")] });
    expect(analysisClaimPresentation(result, [], topics).content).toEqual(topics);
  });

  it("compares passive and active process statements without reversing actors or numeric direction", () => {
    const evidence = source("decision", 1);
    const base = "After approval, the clerk registers the order.";
    const result: AnalyzeResult = {
      operation: "analyze",
      claims: [inference("approval", base, "high", [evidence], "summary")],
      warnings: [], rejectedClaimCount: 0,
    };
    const same = { id: "same", text: "Once approval is complete, the order is registered by the clerk.", sources: [evidence] };
    const different = [
      { id: "actor", text: "Once approval is complete, the order is registered by the manager.", sources: [evidence] },
      { id: "polarity", text: "After approval, the clerk does not register the order.", sources: [evidence] },
      { id: "extra", text: "After approval, the clerk registers the order and notifies the manager.", sources: [evidence] },
    ];
    expect(analysisClaimPresentation(result, [], [same, ...different]).content).toEqual(different);

    const numbers: AnalyzeResult = {
      ...result,
      claims: [inference("change", "The balance falls from 120 to 100.", "high", [evidence], "summary")],
    };
    expect(analysisClaimPresentation(numbers, [], [
      { id: "reversed", text: "The balance falls from 100 to 120.", sources: [evidence] },
    ]).content).toHaveLength(1);
  });

  it("frees topic slots for distinct later facts while retaining every near-repeated source", () => {
    const repeated = [
      "The board reviews the annual report before publication.",
      "Before publication, the annual report is reviewed by the board.",
      "The annual report is reviewed by the board before publication.",
    ];
    const novel = Array.from({ length: 6 }, (_, index) =>
      `The department records decision ${index + 1} in the signed register.`);
    const blocks = [...repeated, ...novel].map((text, index) => ({
      id: `paragraph-${index}`, type: "paragraph" as const, text, source: source(`paragraph-${index}`, 1),
    }));
    const document: NormalizedDocument = {
      id: "repeated", fileId: "file-1", kind: "pptx",
      metadata: { fileName: "review.pptx" }, blocks, warnings: [],
    };
    const topics = documentAnalysisTopics(document);
    expect(topics).toHaveLength(7);
    expect(topics.find(({ text }) => /annual report/u.test(text))?.sources.map(({ nodeId }) => nodeId))
      .toEqual(["paragraph-0", "paragraph-1", "paragraph-2"]);
    for (const text of novel) expect(topics.some((topic) => topic.text === text)).toBe(true);
  });

  it("keeps the early and late states of the same document subject despite a crowded middle", () => {
    const texts = [
      "The inspection report remains pending while the review continues.",
      "The draft schedule is circulated for review.",
      ...Array.from({ length: 10 }, (_, index) =>
        `If the permit for unit ${index + 1} is missing, the office holds dispatch until clearance.`),
      "The inspection report is approved after the review is completed.",
      "The final schedule is issued after review.",
    ];
    const document: NormalizedDocument = {
      id: "states", fileId: "file-1", kind: "pptx", metadata: { fileName: "review.pptx" },
      blocks: texts.map((text, index) => ({
        id: `stage-${index}`, type: "paragraph" as const, text, source: source(`stage-${index}`, index + 1),
      })), warnings: [],
    };
    const topics = documentAnalysisTopics(document);
    expect(topics.some(({ text }) => /report remains pending/u.test(text))).toBe(true);
    expect(topics.some(({ text }) => /report is approved/u.test(text))).toBe(true);
    expect(topics.find(({ text }) => /report is approved/u.test(text))?.sources[0].nodeId).toBe("stage-12");
    expect(topics.some(({ text }) => /draft schedule/u.test(text))).toBe(true);
    expect(topics.some(({ text }) => /final schedule/u.test(text))).toBe(true);
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
