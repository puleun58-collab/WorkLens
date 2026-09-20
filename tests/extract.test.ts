import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { autoExtract } from "@/lib/extract/auto";
import { buildValueCheck } from "@/domain/value-check";
import { extractRequestedFields, labelMatches, modelField } from "@/lib/extract/fields";
import { withResolvedField } from "@/lib/extract/merge";
import { structuredCsv, structuredXlsx } from "@/lib/extract/export";
import { classifyValue, normalizeValue } from "@/lib/extract/values";
import { parseExtractResponse } from "@/lib/ai/extract-prompt";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { StructuredExtract } from "@/domain/extract";
import type { EvidenceItem } from "@/lib/ai/prompt";

/**
 * Extract turns a document into data someone pastes into a spreadsheet, so the
 * contract under test is fidelity: the document's own wording, its source, and
 * nothing invented where the document says nothing.
 */
function source(nodeId: string, label: string, fileId = "file-1"): SourceRef {
  return { fileId, nodeId, label };
}

function paragraphs(lines: readonly string[], fileId = "file-1"): NormalizedDocument {
  return {
    id: `document:${fileId}`,
    fileId,
    kind: "pptx",
    metadata: { fileName: `${fileId}.pptx` },
    blocks: lines.map((text, index) => ({
      type: "paragraph" as const,
      id: `p${index}`,
      text,
      source: source(`p${index}`, `Slide ${index + 1}`, fileId),
    })),
    warnings: [],
  };
}

function table(rows: readonly string[][]): NormalizedDocument {
  return {
    id: "document:file-2",
    fileId: "file-2",
    kind: "docx",
    metadata: { fileName: "실적.docx" },
    blocks: [{
      type: "table",
      id: "t0",
      source: source("t0", "Table 1"),
      rows: rows.map((row, rowIndex) => row.map((display, column) => ({
        value: display,
        display,
        source: source(`t0:r${rowIndex}c${column}`, `Table 1 R${rowIndex + 1}C${column + 1}`),
      }))),
    }],
    warnings: [],
  };
}

const file = { id: "file-1", name: "회의자료.pptx" };

describe("value typing", () => {
  it("types the shapes business documents are read for", () => {
    expect(classifyValue("2026.09.15 13:00")).toBe("DateTime");
    expect(classifyValue("2026-09-30")).toBe("Date");
    expect(classifyValue("2026년 9월")).toBe("Period");
    expect(classifyValue("1,250만원")).toBe("Money");
    expect(classifyValue("87.0%")).toBe("Percent");
    expect(classifyValue("12명")).toBe("Number");
    expect(classifyValue("ops@example.com")).toBe("Email");
    expect(classifyValue("SOP-Q3")).toBe("Code");
    expect(classifyValue("경영지원팀")).toBe("Text");
  });

  it("normalises only what can be read without guessing", () => {
    expect(normalizeValue("2026-09-30", "Date")).toBe("2026-09-30");
    expect(normalizeValue("2026.09.15 13:00", "DateTime")).toBe("2026-09-15T13:00");
    expect(normalizeValue("2026년 9월", "Period")).toBe("2026-09");
    // A scale that has to be assumed is never converted.
    expect(normalizeValue("1,250만원", "Money")).toBeUndefined();
    expect(normalizeValue("12명", "Number")).toBeUndefined();
  });

  it("recognizes scaled money without inventing a normalized amount", () => {
    for (const value of ["2,258억 원", "120억", "6억 원", "1.2조 원", "50,000달러"]) {
      expect(classifyValue(value)).toBe("Money");
      expect(normalizeValue(value, "Money")).toBeUndefined();
    }
  });
});

describe("automatic extraction", () => {
  it("extracts labelled pairs and keeps the document's wording", () => {
    const result = autoExtract(paragraphs([
      "회의일시: 2026.09.15 13:00",
      "작성부서: 경영지원팀",
      "참석인원: 12명",
    ]), file);
    expect(result.fields.map((entry) => [entry.field, entry.displayValue, entry.type])).toEqual([
      ["회의일시", "2026.09.15 13:00", "DateTime"],
      ["작성부서", "경영지원팀", "Text"],
      ["참석인원", "12명", "Number"],
    ]);
    expect(result.fields[0].sources[0].nodeId).toBe("p0");
    expect(result.fields.map((entry) => entry.origin)).toEqual([
      "explicit-delimiter",
      "explicit-delimiter",
      "explicit-delimiter",
    ]);
  });

  it("extracts trusted delimiterless labels only when the value has a safe type", () => {
    const result = autoExtract(paragraphs([
      "목표주가 64,550원",
      "상승여력 232.4%",
      "시가총액 2,258억 원",
      "기준일 2025.05.02",
      "인원 75명",
      "수량 12개",
      "종목코드 SOP-Q3",
      "단위 백만 원",
    ]), file);
    expect(result.fields.map((entry) => [entry.field, entry.displayValue, entry.type])).toEqual([
      ["목표주가", "64,550원", "Money"],
      ["상승여력", "232.4%", "Percent"],
      ["시가총액", "2,258억 원", "Money"],
      ["기준일", "2025.05.02", "Date"],
      ["인원", "75명", "Number"],
      ["수량", "12개", "Number"],
      ["종목코드", "SOP-Q3", "Code"],
      ["단위", "백만 원", "Text"],
    ]);
    expect(result.fields[3].normalizedValue).toBe("2025-05-02");
    expect(result.fields[2].normalizedValue).toBeUndefined();
    expect(result.fields.every((entry) => entry.origin === "business-label")).toBe(true);
  });

  it("allows a trusted dash boundary without making hyphens a general splitter", () => {
    const result = autoExtract(paragraphs([
      "목표주가 - 64,550원",
      "Equity Research - 64,550원",
      "회사-64,550원",
    ]), file);
    expect(result.fields.map((entry) => [entry.field, entry.displayValue])).toEqual([
      ["목표주가", "64,550원"],
    ]);
  });

  it("does not turn running prose or unlabeled numbers into fields", () => {
    const result = autoExtract(paragraphs([
      "이번 분기에는 운영 프로세스를 개선하여 처리 지연을 줄였고 관련 부서와 협의를 계속 진행하고 있습니다.",
      "안전 점검은 매월 시행합니다.",
      "64,550원",
      "232.4%",
      "2025.05.02",
      "목표주가는 시장 상황에 따라 달라질 수 있습니다.",
      "매출 성장이 예상됩니다.",
      "시가총액 기준을 재검토합니다.",
    ]), file);
    expect(result.fields).toEqual([]);
  });

  it("merges normalized duplicate labels and values while retaining every source", () => {
    const result = autoExtract(paragraphs([
      "작성부서: 경영지원팀",
      "작성 부서: 경영지원팀",
      "단위 백만 원",
      "단위 백만 원",
    ]), file);
    expect(result.fields).toHaveLength(2);
    expect(result.fields.map((entry) => entry.field)).toEqual(["작성부서", "단위"]);
    expect(result.fields[0].sources).toHaveLength(2);
    expect(result.fields[1].sources).toHaveLength(2);
  });

  it("groups repeated structural Source lines instead of inventing business fields", () => {
    const result = autoExtract(paragraphs([
      "Source: 회사 공시",
      "Source: 거래소 데이터",
      "목표주가 | 64,550원",
    ]), file);
    expect(result.fields.map((entry) => [entry.field, entry.displayValue])).toEqual([
      ["목표주가", "64,550원"],
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      title: "Source",
      displayTitle: "참고 출처",
      columns: ["참고 출처"],
      rows: [{ cells: ["회사 공시"] }, { cells: ["거래소 데이터"] }],
    });
    expect(result.records[0].rows.map((row) => row.source.nodeId)).toEqual(["p0", "p1"]);
  });

  it("rejects ambiguous layout pipes while keeping explicit business pairs", () => {
    const result = autoExtract(paragraphs([
      "Equity Research | 토모큐브",
      "SMIC 4팀 | 정기 보고",
      "목표주가 | 64,550원",
    ]), file);
    expect(result.fields.map((entry) => [entry.field, entry.displayValue])).toEqual([
      ["목표주가", "64,550원"],
    ]);
  });

  it("keeps different values for the same field as separate occurrences", () => {
    const result = autoExtract(paragraphs([
      "목표주가: 64,550원",
      "목표주가: 62,000원",
      "목표주가: 64,550원",
    ]), file);
    expect(result.fields.map((entry) => entry.displayValue)).toEqual(["64,550원", "62,000원"]);
    expect(result.fields[0].sources).toHaveLength(2);
    expect(result.fields[1].sources).toHaveLength(1);
  });

  it("feeds delimiterless deterministic values into value comparison", () => {
    const first = autoExtract(paragraphs(["목표주가 64,550원"], "a"), { id: "a", name: "a.pptx" });
    const second = autoExtract(paragraphs(["목표주가 62,000원"], "b"), { id: "b", name: "b.pptx" });
    const result = buildValueCheck([first, second]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      field: "목표주가",
      status: "different",
      distinctValueCount: 2,
    });
  });

  it("keeps a repeating table as a table, not as pairs", () => {
    const result = autoExtract(table([
      ["담당자", "조치사항", "기한"],
      ["김OO", "안전표지 설치", "9/30"],
      ["이OO", "통로 정리", "10/5"],
    ]), { id: "file-2", name: "실적.docx" });
    expect(result.fields).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].columns).toEqual(["담당자", "조치사항", "기한"]);
    expect(result.records[0].rows).toHaveLength(2);
  });

  it("reads a two-column table as label and value", () => {
    const result = autoExtract(table([
      ["보고기간", "2026년 9월"],
      ["담당부서", "영업팀"],
    ]), { id: "file-2", name: "실적.docx" });
    expect(result.fields.map((entry) => [entry.field, entry.displayValue])).toEqual([
      ["보고기간", "2026년 9월"],
      ["담당부서", "영업팀"],
    ]);
    expect(result.records).toEqual([]);
    expect(result.fields.map((entry) => entry.origin)).toEqual(["key-value-table", "key-value-table"]);
  });
});

describe("requested fields", () => {
  it("matches a requested field against the document's own label", () => {
    expect(labelMatches("회의일시", "회의 일시")).toBe(true);
    expect(labelMatches("담당부서", "작성부서")).toBe(false);
  });

  it("answers what the document states and reports the rest as unresolved", () => {
    const plan = extractRequestedFields(
      paragraphs(["회의일시: 2026.09.15 13:00", "작성부서: 경영지원팀"]),
      file,
      ["회의일시", "조치기한"],
    );
    expect(plan.extraction.fields.map((entry) => entry.field)).toEqual(["회의일시"]);
    expect(plan.extraction.fields[0].confidence).toBeUndefined();
    expect(plan.unresolved).toEqual(["조치기한"]);
  });

  it("retains structural labels when the user explicitly requests them", () => {
    const plan = extractRequestedFields(
      paragraphs(["Source: 회사 공시", "Source: 거래소 데이터"]),
      file,
      ["Source"],
    );
    expect(plan.unresolved).toEqual([]);
    expect(plan.extraction.fields.map((entry) => entry.displayValue)).toEqual(["회사 공시", "거래소 데이터"]);
  });
});

describe("model-extracted values", () => {
  const items: EvidenceItem[] = [
    { handle: "E1", text: "조치기한은 2026.09.30까지입니다." },
    { handle: "E2", text: "담당자는 경영지원팀입니다." },
  ];

  it("keeps a value that is written in the evidence", () => {
    const proposal = parseExtractResponse('{"field":"조치기한","value":"2026.09.30","sources":["E1"],"confidence":"high"}', "조치기한", items);
    expect(proposal).toEqual({ field: "조치기한", value: "2026.09.30", handles: ["E1"], confidence: "high" });
  });

  it("drops a value the evidence does not contain", () => {
    const proposal = parseExtractResponse('{"field":"조치기한","value":"2026.10.15","sources":["E1"],"confidence":"high"}', "조치기한", items);
    expect(proposal.value).toBeNull();
  });

  it("treats an explicit null and a placeholder as not stated", () => {
    expect(parseExtractResponse('{"field":"예산","value":null,"sources":[]}', "예산", items).value).toBeNull();
    expect(parseExtractResponse('{"field":"예산","value":"없음","sources":["E1"]}', "예산", items).value).toBeNull();
    expect(parseExtractResponse("설명만 반환", "예산", items).value).toBeNull();
  });

  it("folds a resolved field into the run and recounts the summary", () => {
    const current: StructuredExtract = {
      mode: "fields",
      requestedFields: ["회의일시", "조치기한"],
      files: [{ file, fields: [], records: [], missing: ["회의일시", "조치기한"] }],
      summary: { fields: 0, missing: 2, records: 0, lowConfidence: 0 },
    };
    const resolved = withResolvedField(current, "file-1", modelField("조치기한", "2026.09.30", [source("p3", "Slide 4")], "medium"));
    expect(resolved.files[0].fields[0].displayValue).toBe("2026.09.30");
    expect(resolved.files[0].fields[0].origin).toBe("requested-ai");
    // The wording stays; the normalised form is added beside it.
    expect(resolved.files[0].fields[0].normalizedValue).toBe("2026-09-30");
    expect(resolved.files[0].missing).toEqual(["회의일시"]);
    expect(resolved.summary).toEqual({ fields: 1, missing: 1, records: 0, lowConfidence: 0 });
  });
});

describe("structured export", () => {
  const multiFile: StructuredExtract = {
    mode: "fields",
    requestedFields: ["보고월", "매출"],
    files: [
      {
        file: { id: "f1", name: "7월 보고서.docx" },
        fields: [
          { field: "보고월", displayValue: "2026-07", type: "Date", sources: [source("p1", "Paragraph 1")] },
          { field: "매출", displayValue: "1,250만원", type: "Money", sources: [source("p2", "Paragraph 2")] },
        ],
        records: [],
        missing: [],
      },
      {
        file: { id: "f2", name: "8월 보고서.docx" },
        fields: [{ field: "보고월", displayValue: "2026-08", type: "Date", sources: [source("p1", "Paragraph 1")] }],
        records: [],
        missing: ["매출"],
      },
    ],
    summary: { fields: 3, missing: 1, records: 0, lowConfidence: 0 },
  };

  it("writes one row per file with the requested fields as columns", () => {
    const csv = structuredCsv(multiFile);
    const [header, first, second] = csv.trim().split("\r\n");
    expect(header.startsWith("FILE,보고월,매출")).toBe(true);
    expect(first).toContain("7월 보고서.docx");
    expect(first).toContain("1,250만원".replace(",", ",")); // quoted by the writer
    // A field the document does not state stays an empty cell, never "없음".
    expect(second.endsWith(",")).toBe(false);
    expect(second).toContain("2026-08");
    expect(second).not.toContain("없음");
  });

  it("writes one row per item in automatic mode", () => {
    const auto: StructuredExtract = {
      mode: "auto",
      requestedFields: [],
      files: [{
        file,
        fields: [{
          field: "작성부서",
          displayValue: "경영지원팀",
          type: "Text",
          sources: [source("p1", "Slide 1")],
          origin: "business-label",
        }],
        records: [],
        missing: [],
      }],
      summary: { fields: 1, missing: 0, records: 0, lowConfidence: 0 },
    };
    const csv = structuredCsv(auto);
    expect(csv.trim().split("\r\n")[0]).toBe("FILE,FIELD,VALUE,TYPE,SOURCE");
    expect(csv).toContain("경영지원팀");
    expect(csv).not.toContain("business-label");
  });

  it("exports refined record rows with their original source", () => {
    const auto: StructuredExtract = {
      mode: "auto",
      requestedFields: [],
      files: [{
        file,
        fields: [],
        records: [{
          id: "sources",
          title: "Source",
          displayTitle: "참고 출처",
          columns: ["참고 출처"],
          rows: [{ cells: ["회사 공시"], source: source("p1", "Slide 1") }],
          source: source("p1", "Slide 1"),
        }],
        missing: [],
      }],
      summary: { fields: 0, missing: 0, records: 1, lowConfidence: 0 },
    };
    const csv = structuredCsv(auto);
    expect(csv).toContain("참고 출처,회사 공시,Record,Slide 1");
  });

  it("keeps automatic record content aligned across CSV and XLSX", async () => {
    const auto: StructuredExtract = {
      mode: "auto",
      requestedFields: [],
      files: [{
        file,
        fields: [],
        records: [{
          id: "sources",
          title: "Source",
          displayTitle: "참고 출처",
          columns: ["참고 출처"],
          rows: [{ cells: ["회사 공시"], source: source("p1", "Slide 1") }],
          source: source("p1", "Slide 1"),
        }],
        missing: [],
      }],
      summary: { fields: 0, missing: 0, records: 1, lowConfidence: 0 },
    };
    expect(structuredCsv(auto)).toContain("참고 출처,회사 공시,Record,Slide 1");
    const workbook = new ExcelJS.Workbook();
    const bytes = await structuredXlsx(auto);
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.getWorksheet("Records")?.getRow(2).values).toEqual(
      expect.arrayContaining(["회의자료.pptx", "참고 출처", "회사 공시", "Slide 1"]),
    );
  });

  it("produces a workbook with a data sheet and an evidence sheet", async () => {
    const bytes = await structuredXlsx(multiFile);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Sheet names live in the zip's central directory as part names.
    expect(text).toContain("xl/worksheets/sheet1.xml");
    expect(text).toContain("xl/worksheets/sheet2.xml");
  });
});
