import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { checkDocument } from "@/lib/deterministic";
import type { NormalizedDocument, SourceRef } from "@/domain/document";
import type { CheckResult } from "@/domain/operations";
import { parseDocument } from "@/lib/parsers";
import { createCheckPptx, createPdf, createXlsx } from "./fixtures";


function qaDocx(paragraphs: ReadonlyArray<{ text: string; heading?: number }>): Uint8Array {
  const body = paragraphs.map(({ text, heading }) => `<w:p>${heading ? `<w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  });
}

async function parsed(fileId: string, fileName: string, bytes: Uint8Array) {
  return parseDocument({ fileId, fileName, bytes });
}

function finding(result: CheckResult, code: string) {
  return result.findings.find((item) => item.code === code);
}

function paragraphDocument(texts: readonly string[]): NormalizedDocument {
  return {
    id: "document:paragraph-check",
    fileId: "paragraph-check",
    kind: "docx",
    metadata: { fileName: "검수.docx" },
    warnings: [],
    blocks: texts.map((text, index) => {
      const source: SourceRef = {
        fileId: "paragraph-check",
        nodeId: `paragraph:${index + 1}`,
        label: `문단 ${index + 1}`,
        locator: { kind: "docx", part: "body", block: index + 1 },
        quote: text,
      };
      return { type: "paragraph" as const, id: source.nodeId, text, source };
    }),
  };
}

describe("document submission Check", () => {
  it("finds PPTX typo, terminology, dates, units, numeric conflicts and placeholders with slide sources", async () => {
    const document = await parsed("ppt-qa", "최종보고.pptx", createCheckPptx());
    const result = checkDocument(document);

    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "suspected-typo",
      "terminology-inconsistency",
      "inconsistent-date-format",
      "date-conflict",
      "inconsistent-unit-format",
      "repeated-number-conflict",
      "placeholder-text",
    ]));
    const typo = finding(result, "suspected-typo");
    expect(typo).toMatchObject({
      severity: "warning",
      category: "spelling",
      originalText: "향후 13주 유가 전먕",
      suggestedText: "향후 13주 유가 전망",
      source: { page: 1, label: "슬라이드 1" },
    });
    expect(finding(result, "terminology-inconsistency")?.sources.map((source) => source.page)).toEqual(expect.arrayContaining([1, 2]));
  });

  it("checks DOCX spacing, duplicate paragraphs and heading hierarchy", async () => {
    const repeated = "검수 결과를 확인한 뒤 문서를 제출합니다.";
    const document = await parsed("docx-qa", "제출안.docx", qaDocx([
      { text: "1. 검수 범위", heading: 1 },
      { text: "1) 세부 기준", heading: 3 },
      { text: "운영 모델은 적용 됩니다." },
      { text: repeated },
      { text: repeated },
    ]));
    const result = checkDocument(document);

    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "suspected-typo",
      "duplicate-sentence",
      "heading-hierarchy",
      "heading-numbering-inconsistency",
    ]));
    expect(finding(result, "heading-hierarchy")?.sources.every((source) => source.locator?.kind === "docx")).toBe(true);
  });

  it("checks PDF page text for English typo, terminology and date format consistency", async () => {
    const document = await parsed("pdf-qa", "review.pdf", await createPdf([
      "WorkLens forcast report. Review date 2026-09-14.",
      "Work Lens forecast report. Review date 2026.09.15.",
    ]));
    const result = checkDocument(document);

    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "english-spelling",
      "terminology-inconsistency",
      "inconsistent-date-format",
    ]));
    expect(finding(result, "english-spelling")?.source).toMatchObject({ page: 1, label: "페이지 1" });
  });

  it("preserves XLSX total, duplicate, formatting and privacy checks with cell sources", async () => {
    const document = await parsed("xlsx-qa", "검수표.xlsx", await createXlsx({
      검수: [
        ["항목", "금액", "담당자"],
        ["서울", 100, "user@example.com / 010-1234-5678"],
        [100, 100, ""],
        ["합계", 350, ""],
      ],
    }));
    const result = checkDocument(document);

    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "invalid-total",
      "duplicate-value",
      "privacy-email",
      "privacy-phone",
    ]));
    for (const item of result.findings) {
      expect(item.issue).not.toBe("");
      expect(item.category).not.toBe("");
      expect(item.source.cellRange).toBeDefined();
      expect(item.sources.length).toBeGreaterThan(0);
    }
  });

  it("rejects impossible dates and merges overlapping spelling findings", async () => {
    const document = await parsed("docx-dedupe", "날짜검수.docx", qaDocx([{ text: "검수 일정", heading: 1 }, { text: "기준일 2026-02-30" }, { text: "향후 전먕" }]));
    const result = checkDocument(document);
    expect(result.findings.filter((item) => item.code === "impossible-date")).toHaveLength(1);
    expect(result.findings.filter((item) => item.originalText === "향후 전먕")).toHaveLength(1);
  });

  it("detects only strong expanded privacy patterns and keeps every source actionable", () => {
    const result = checkDocument(paragraphDocument([
      "API Key: sk_live_1234567890abcdefgh",
      "계좌번호 123-456-789012",
      "사번 WL-2048",
      "내부 시스템 http://10.20.30.40/admin",
      "외부 참고 번호 12345",
    ]));
    const codes = result.findings.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "privacy-secret",
      "privacy-account-number",
      "privacy-employee-id",
      "privacy-internal-url",
    ]));
    expect(codes).not.toContain("privacy-sensitive-id");
    expect(result.findings.find((item) => item.code === "privacy-secret")).toMatchObject({ severity: "critical", category: "privacy" });
    expect(result.findings.every((item) => item.source.nodeId.length > 0)).toBe(true);
  });

  it("bounds findings for long documents without rescanning parsed content", () => {
    const result = checkDocument(paragraphDocument(
      Array.from({ length: 1_000 }, (_, index) => `TODO section ${index}`),
    ));
    expect(result.findings).toHaveLength(500);
    expect(result.findings.every((item) => item.code === "placeholder-text")).toBe(true);
  });
});
