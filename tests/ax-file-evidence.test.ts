import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildAxFileEvidence } from "../src/lib/ax/file-evidence";
import { AX_LIMITS } from "../src/lib/ax/schema";
import { parseDocument } from "../src/lib/parsers";
import { createDocx, createDocxImageOnly, createDocxParagraphs, createXlsx } from "./fixtures";

const parse = (fileName: string, bytes: Uint8Array) =>
  parseDocument({ fileId: "question-file", fileName, bytes });

describe("AX question file actual evidence", () => {
  it("retains actual sheet, first-row labels, addresses, types and original formulas", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("월별 정산");
    sheet.addRow(["항목", "금액", "합계"]);
    sheet.addRow(["수수료", 120, { formula: "SUM(B2:B2)", result: 120 }]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const document = await parse("정산.xlsx", bytes);
    const result = buildAxFileEvidence(document, "정산 수식은?");
    expect(result).toMatchObject({ empty: false, partial: false });
    // Cached formula results are not recalculated: consumers must retain the
    // parser caveat alongside the actual formula rather than claim validation.
    expect(result.warnings).toEqual(document.warnings);
    expect(result.warnings).toContain("XLSX_FORMULA_VALUE_ONLY");
    expect(result.text).toContain("시트 월별 정산");
    expect(result.text).toContain("항목");
    expect(result.text).toContain("금액");
    expect(result.text).toContain("C2");
    expect(result.text).toContain("유형=formula");
    expect(result.text).toContain("수식=SUM(B2:B2)");
    expect(result.text).not.toContain("자동 승인");
  });

  it("reads CSV cell values and DOCX paragraphs/tables, not just file metadata", async () => {
    const csv = buildAxFileEvidence(await parse("자료.csv", new TextEncoder().encode("담당,절차\r\n회계팀,월말 검수\r\n")), "검수 절차");
    expect(csv).toMatchObject({ empty: false, partial: false });
    expect(csv.text).toContain("회계팀");
    expect(csv.text).toContain("월말 검수");
    const docx = buildAxFileEvidence(await parse("자료.docx", createDocx()), "계약");
    expect(docx).toMatchObject({ empty: false, partial: false });
    expect(docx.text).toContain("분기 계약 요약");
    expect(docx.text).toContain("운송비");
    expect(docx.text).toContain("145000");
    expect(docx.text).not.toContain("자료.docx");
  });

  it("never treats an empty sheet or whitespace-only document as evidence", async () => {
    const documents = [
      await parse("빈.xlsx", await createXlsx({ 빈시트: [] })),
      await parse("빈.csv", new TextEncoder().encode(",,\r\n,,\r\n")),
      await parse("빈.docx", createDocxParagraphs(["   ", "\t "])),
    ];
    for (const document of documents) {
      expect(buildAxFileEvidence(document, "어떤 절차인가요?")).toMatchObject({ text: "", empty: true, partial: false });
    }
  });

  it("preserves parser omissions and signals incomplete reading even without readable text", async () => {
    const document = await parse("그림.docx", createDocxImageOnly());
    const result = buildAxFileEvidence(document, "업무");
    expect(result).toMatchObject({ text: "", empty: true, partial: true });
    expect(result.warnings).toEqual(document.warnings);
    expect(result.warnings).not.toBe(document.warnings);
    expect(result.warnings).toContain("DOCX_IMAGE_OMITTED");
  });

  it("balances table structure, distant question matches and formulas within the limit", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("처리 내역");
    sheet.addRow(["절차", "금액", "계산"]);
    for (let index = 0; index < 300; index += 1) sheet.addRow([`일반처리${index}`, index]);
    sheet.addRow(["특수반품은 담당자가 확인", 7, { formula: "B302*2", result: 14 }]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const document = await parse("내역.xlsx", bytes);
    const result = buildAxFileEvidence(document, "특수반품");
    expect(result).toMatchObject({ empty: false, partial: true });
    expect(result.text.length).toBeLessThanOrEqual(AX_LIMITS.attachmentSummary);
    expect(result.text).toContain("절차");
    expect(result.text).toContain("특수반품은 담당자가 확인");
    expect(result.text).toContain("수식=B302*2");
    expect(result.text).toContain("일부 추출");
    expect(buildAxFileEvidence(document, "특수반품")).toEqual(result);
  });

  it("finds a question match beyond the first window of a long paragraph", async () => {
    const document = await parse("긴본문.docx", createDocxParagraphs([
      `${"일반적인 안내 내용. ".repeat(600)}특별예외는 책임자 검토 후 처리한다.`,
    ]));
    const result = buildAxFileEvidence(document, "특별예외");
    expect(result).toMatchObject({ partial: true, empty: false });
    expect(result.text.length).toBeLessThanOrEqual(AX_LIMITS.attachmentSummary);
    expect(result.text).toContain("특별예외는 책임자 검토 후 처리한다.");
  });

  it("keeps complete small evidence complete and marks just-over-limit input partial", async () => {
    const small = await parse("짧음.docx", createDocxParagraphs(["현재 담당자가 직접 검수한다."]));
    expect(buildAxFileEvidence(small, "검수").partial).toBe(false);
    const long = await parse("경계.docx", createDocxParagraphs(["가".repeat(AX_LIMITS.attachmentSummary + 1)]));
    const result = buildAxFileEvidence(long, "검수");
    expect(result.partial).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(AX_LIMITS.attachmentSummary);
  });
});
