import ExcelJS from "exceljs";
import type { AggregationDraft, AggregationRecord, AggregationSelection } from "@/domain/aggregation";
import type { DocumentMedia, NormalizedDocument } from "@/domain/document";
import { improvementProfileStatus, improvementValue } from "@/lib/aggregation/improvement-profile";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ImprovementExport {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
}

function selectedRecords(draft: AggregationDraft, selection: AggregationSelection): AggregationRecord[] {
  const selected = new Set(selection.sheetIds);
  return draft.records.filter((record) => selected.has(record.sheetId));
}

function mediaForRecord(record: AggregationRecord, documents: readonly NormalizedDocument[]): DocumentMedia[] {
  const ids = new Set(record.media.map((media) => media.id));
  return documents.flatMap((document) => document.media ?? []).filter((media) => ids.has(media.id));
}

function dateCell(value: string | number | boolean | null): string | number | boolean | Date | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return value;
}

function styleBank(sheet: ExcelJS.Worksheet, lastRow: number): void {
  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];
  sheet.autoFilter = { from: "B4", to: `M${lastRow}` };
  sheet.columns = [4.14, 11.86, 9.43, 9.43, 20.43, 20.43, 53.86, 53.86, 11.86, 11.86, 11.86, 11.86, 11.86]
    .map((width) => ({ width }));
  sheet.mergeCells("E3:F3");
  sheet.mergeCells("K3:L3");
  const dark = "1F4E78";
  for (const rowNumber of [3, 4]) {
    const row = sheet.getRow(rowNumber);
    row.height = 24;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "맑은 고딕", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${dark}` } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
    });
  }
  for (let rowNumber = 5; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.height = 96;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "맑은 고딕", size: 9 };
      cell.alignment = { vertical: "middle", horizontal: Number(cell.col) === 7 || Number(cell.col) === 8 ? "left" : "center", wrapText: true };
      cell.border = { top: { style: "thin", color: { argb: "FFD9E2F3" } }, left: { style: "thin", color: { argb: "FFD9E2F3" } }, bottom: { style: "thin", color: { argb: "FFD9E2F3" } }, right: { style: "thin", color: { argb: "FFD9E2F3" } } };
    });
    for (const column of [11, 12]) if (row.getCell(column).value instanceof Date) row.getCell(column).numFmt = "yy.mm.dd";
  }
}

/** Produces the first concrete output profile: a Bank workbook preserving record images and typed dates. */
export async function improvementBankExport(
  draft: AggregationDraft,
  selection: AggregationSelection,
  documents: readonly NormalizedDocument[],
): Promise<ImprovementExport> {
  const records = selectedRecords(draft, selection);
  const status = improvementProfileStatus(records);
  if (!status.available) throw new Error(`개선 프로필 필수 항목이 없습니다: ${status.missing.join(", ")}`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("개선 Bank");
  sheet.addRow(["개선 제안 관리"]);
  sheet.addRow([]);
  sheet.addRow(["", "관리 No", "공장", "구분", "Figure", "", "현상 파악", "개선 결과", "제안자", "N/O", "진행 현황", "", "비고"]);
  sheet.addRow(["", "", "", "", "Before", "After", "", "", "", "", "등록", "종료", ""]);

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 5;
    sheet.addRow([
      "",
      improvementValue(record, "managementNo") ?? index + 1,
      improvementValue(record, "department"),
      improvementValue(record, "category"),
      "",
      "",
      improvementValue(record, "current"),
      improvementValue(record, "result"),
      improvementValue(record, "proposer"),
      improvementValue(record, "owner"),
      dateCell(improvementValue(record, "registeredAt")),
      dateCell(improvementValue(record, "closedAt")),
      improvementValue(record, "note"),
    ]);
    for (const [mediaIndex, media] of mediaForRecord(record, documents).slice(0, 2).entries()) {
      if (!(["png", "jpeg", "jpg", "gif"] as string[]).includes(media.extension.toLowerCase())) continue;
      const imageId = workbook.addImage({ buffer: media.data as unknown as ExcelJS.Buffer, extension: media.extension.toLowerCase() === "jpg" ? "jpeg" : media.extension.toLowerCase() as "png" | "jpeg" | "gif" });
      const column = 4 + mediaIndex;
      sheet.addImage(imageId, { tl: { col: column + 0.05, row: rowNumber - 0.95 }, ext: { width: 135, height: 118 }, editAs: "oneCell" });
    }
  }
  styleBank(sheet, records.length + 4);
  return { fileName: "worklens-improvement-bank.xlsx", mimeType: XLSX_MIME, content: new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer) };
}
