import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedDocument } from "@/domain/document";
import { parseDocument } from "@/lib/parsers";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { fileKindOf, validateUploadBytes } from "@/lib/upload";

async function workbookBytes(configure: (sheet: ExcelJS.Worksheet) => void): Promise<Record<string, Uint8Array>> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook.addWorksheet("Sheet1"));
  return unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer));
}

/** An external reference is only usable through the result Excel already stored. */
async function externalLinkWorkbook(cachedResult: number | undefined): Promise<Uint8Array> {
  const files = await workbookBytes((sheet) => {
    sheet.addRow(["항목", "값"]);
    sheet.addRow(["단가", cachedResult === undefined
      ? { formula: "'[가격표.xlsx]Sheet1'!B4" }
      : { formula: "'[가격표.xlsx]Sheet1'!B4", result: cachedResult }]);
    sheet.addRow(["수량", 3]);
  });
  files["xl/externalLinks/externalLink1.xml"] = strToU8('<?xml version="1.0"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook/></externalLink>');
  files["xl/externalLinks/_rels/externalLink1.xml.rels"] = strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///C:/가격표.xlsx" TargetMode="External"/></Relationships>');
  return zipSync(files);
}

async function macroWorkbook(): Promise<Uint8Array> {
  const files = await workbookBytes((sheet) => {
    sheet.addRow(["부서", "인원", "기준일"]);
    sheet.addRow(["운영", 12, "2026-08-01"]);
    sheet.addRow(["지원", 8, "2026-08-02"]);
  });
  files["xl/vbaProject.bin"] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  return zipSync(files);
}

const cellText = (document: NormalizedDocument, row: number, column: number): string =>
  document.workbookSheets?.[0].table.rows[row][column].display ?? "";

describe("workbooks with macros or external links", () => {
  it("admits an externally linked workbook and reads the value Excel stored", async () => {
    const bytes = await externalLinkWorkbook(125_000);
    expect(validateUploadBytes(fileKindOf("가격.xlsx"), bytes)).toContain("XLSX_EXTERNAL_REFERENCE_VALUE_ONLY");

    const document = await parseDocument({ fileId: "linked", fileName: "가격.xlsx", bytes });
    expect(cellText(document, 1, 1)).toBe("125000");
    expect(cellText(document, 2, 1)).toBe("3");
    expect(document.warnings).toContain("XLSX_EXTERNAL_REFERENCE_VALUE_ONLY");
  });

  it("keeps the rest of the sheet when an external reference has no stored result", async () => {
    const bytes = await externalLinkWorkbook(undefined);
    const document = await parseDocument({ fileId: "linked-empty", fileName: "가격.xlsx", bytes });

    expect(cellText(document, 1, 1)).toBe("");
    expect(cellText(document, 2, 1)).toBe("3");
    expect(document.warnings).toContain("XLSX_EXTERNAL_REFERENCE_NO_CACHE");
    expect(document.warnings).not.toContain("XLSX_EXTERNAL_REFERENCE_VALUE_ONLY");
  });

  it("reads a macro-enabled workbook without touching the macro project", async () => {
    const bytes = await macroWorkbook();
    expect(validateUploadBytes(fileKindOf("관리.xlsm"), bytes)).toEqual(["XLSX_MACRO_IGNORED"]);

    const document = await parseDocument({ fileId: "macro", fileName: "관리.xlsm", bytes });
    expect(document.workbookSheets?.[0].name).toBe("Sheet1");
    expect(cellText(document, 1, 0)).toBe("운영");
    expect(JSON.stringify(document)).not.toContain("vbaProject");

    const draft = buildAggregation([document]);
    expect(draft.records).toHaveLength(2);
  });

  it("never reaches the network while reading a linked workbook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bytes = await externalLinkWorkbook(125_000);
    await parseDocument({ fileId: "offline", fileName: "가격.xlsx", bytes });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("exports data only: no macro project and no external link survives the round trip", async () => {
    const linked = await parseDocument({ fileId: "linked", fileName: "가격.xlsx", bytes: await externalLinkWorkbook(125_000) });
    const macro = await parseDocument({ fileId: "macro", fileName: "관리.xlsm", bytes: await macroWorkbook() });
    const draft = buildAggregation([linked, macro]);
    const exported = await aggregationXlsxExport(draft, {
      sheetIds: draft.workbooks.flatMap((workbook) => workbook.sheets.map((sheet) => sheet.id)),
      mappings: draft.mappings,
    });

    const parts = Object.keys(unzipSync(exported.content));
    expect(parts.some((part) => part.toLowerCase().includes("vbaproject"))).toBe(false);
    expect(parts.some((part) => part.toLowerCase().includes("externallink"))).toBe(false);
    // The stored value still travels, so the export carries data, not links.
    expect(new TextDecoder().decode(unzipSync(exported.content)["xl/worksheets/sheet1.xml"])).toContain("125000");
  });
});
