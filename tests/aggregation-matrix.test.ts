/**
 * Fixture matrix: every case builds real XLSX bytes with ExcelJS, parses them
 * with the product parser, aggregates with the real engine, exports, and
 * reopens the result (ExcelJS objects and, where it matters, the OOXML).
 *
 * | Case | Structure                                   | Expected                                  |
 * | ---- | ------------------------------------------- | ----------------------------------------- |
 * | M01  | three identical workbooks                   | all rows appended in selection order      |
 * | M02  | source missing a field                      | blank cell, neighbours not shifted        |
 * | M03  | source extra field                          | review mapping, excluded, not in output   |
 * | M04  | alias vs lookalike header                   | 매출액→매출 only; 금액 stays apart           |
 * | M05  | title + spacer rows above the header        | header found, title not a record          |
 * | M06  | blank row inside the record table           | every row after the gap still appended    |
 * | M07  | two tables on one sheet                     | primary appended, other flagged           |
 * | M08  | source-only / target-only sheets            | target kept; source-only left to review   |
 * | M09  | hidden / veryHidden source sheets           | not selected by default                   |
 * | M10  | empty and header-only sheets                | no phantom records                        |
 * | M11  | mixed value types                           | types and number formats survive          |
 * | M12  | the same date written five ways             | one date value per row                    |
 * | M13  | summary sheet formulas over the data range  | range follows the final rows              |
 * | M14  | external workbook formula                   | cached value only, no externalLink part   |
 * | M15  | special strings                             | kept as text, never a formula             |
 * | M16  | partial duplicates                          | not deduplicated                          |
 * | M17  | footer with merge and border                | footer moves below appended rows          |
 * | M18  | long / similar sheet names                  | unique, ≤31 chars, order kept             |
 * | M19  | excluded mapping / deselected sheet         | exactly those values left out             |
 * | M20  | damaged XLSX inputs                         | clear DocumentError, no hang              |
 * | M21  | medium workbook (5×2,000 rows, 16 columns)  | no row lost                               |
 * | M22  | repeated run on identical input             | byte-for-byte identical sheet values      |
 * | M23  | Before/After pictures, identical bytes, logo| each in its own cell; logo stays          |
 * | M24  | the same workbook selected three times      | three sources, distinct record IDs        |
 * | M25  | 합계 is a legitimate final-row category      | record not mistaken for footer            |
 * | M26  | last record has a running SUM              | ordinary category still appended          |
 */
import ExcelJS from "exceljs";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { AggregationDraft, AggregationSelection } from "@/domain/aggregation";
import type { NormalizedDocument } from "@/domain/document";
import { buildAggregation } from "@/lib/aggregation/engine";
import { aggregationXlsxExport } from "@/lib/aggregation/export";
import { parseDocument } from "@/lib/parsers";

async function book(fileId: string, configure: (workbook: ExcelJS.Workbook) => void): Promise<NormalizedDocument> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return parseDocument({ fileId, fileName: `${fileId}.xlsx`, bytes: new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer) });
}

const defaults = (draft: AggregationDraft): AggregationSelection => ({
  sheetIds: draft.workbooks.flatMap((workbook) => workbook.sheets.filter((sheet) => sheet.selectedByDefault).map((sheet) => sheet.id)),
  mappings: draft.mappings,
});

/** Every internal relationship points at a part in the package; none points outside it. */
function expectPackageIntegrity(files: Record<string, Uint8Array>): void {
  for (const path of Object.keys(files).filter((entry) => entry.endsWith(".rels"))) {
    const base = path.replace(/_rels\/([^/]*)\.rels$/u, "$1").split("/").slice(0, -1);
    for (const [tag] of strFromU8(files[path]).matchAll(/<Relationship\b[^>]*>/gu)) {
      expect(tag, path).not.toMatch(/TargetMode="External"/u);
      const target = /\sTarget="([^"]*)"/u.exec(tag)![1];
      const parts = target.startsWith("/") ? [] : [...base];
      for (const segment of target.replace(/^\//u, "").split("/")) {
        if (segment === "..") parts.pop();
        else if (segment && segment !== ".") parts.push(segment);
      }
      expect(files[parts.join("/")], `${path} -> ${target}`).toBeDefined();
    }
  }
}

async function run(documents: NormalizedDocument[], select?: (draft: AggregationDraft) => AggregationSelection) {
  const draft = buildAggregation(documents);
  const exported = await aggregationXlsxExport(draft, select ? select(draft) : defaults(draft), documents);
  const output = new ExcelJS.Workbook();
  await output.xlsx.load(exported.content as unknown as ExcelJS.Buffer);
  // The product's own parser must read the result back too.
  const reparsed = await parseDocument({ fileId: "result", fileName: "result.xlsx", bytes: exported.content });
  const files = unzipSync(exported.content);
  expectPackageIntegrity(files);
  return { draft, output, reparsed, files };
}

/** Cell values of a sheet's used rows, `null` for blank cells, formulas as `=…`. */
function values(sheet: ExcelJS.Worksheet, fromRow = 1, columns = sheet.columnCount): unknown[][] {
  const rows: unknown[][] = [];
  for (let row = fromRow; row <= sheet.rowCount; row += 1) {
    rows.push(Array.from({ length: columns }, (_, index) => {
      const value = sheet.getCell(row, index + 1).value;
      if (value && typeof value === "object" && "formula" in value) return `=${value.formula}`;
      if (value instanceof Date) return value.toISOString().slice(0, 16);
      return value ?? null;
    }));
  }
  return rows;
}

const sheetIdOf = (draft: AggregationDraft, fileId: string, name: string) =>
  draft.workbooks.flatMap((workbook) => workbook.sheets).find((sheet) => sheet.fileId === fileId && sheet.name === name)!.id;

describe("aggregation fixture matrix", () => {
  it("M01 appends three identical workbooks in selection order with an exact record count", async () => {
    const documents = await Promise.all(["A", "B", "C"].map((prefix) => book(prefix, (workbook) => {
      workbook.addWorksheet("실적").addRows([["부서", "등록일", "매출", "비용"], ...[1, 2].map((index) => [`${prefix}-${index}`, new Date(Date.UTC(2026, 7, index)), index * 100, index * 10])]);
    })));
    const { draft, output } = await run(documents);
    expect(draft.targets.map((target) => [target.name, target.recordCount])).toEqual([["실적", 6]]);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["실적"]);
    expect(values(output.getWorksheet("실적")!, 2)).toEqual([
      ["A-1", "2026-08-01T00:00", 100, 10], ["A-2", "2026-08-02T00:00", 200, 20],
      ["B-1", "2026-08-01T00:00", 100, 10], ["B-2", "2026-08-02T00:00", 200, 20],
      ["C-1", "2026-08-01T00:00", 100, 10], ["C-2", "2026-08-02T00:00", 200, 20],
    ]);
  });

  it("M02 leaves a field the source lacks blank and never shifts its neighbours", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["부서", "등록일", "매출", "담당자"], ["T", "2026-08-01", 1, "김"], ["U", "2026-08-02", 2, "이"]]));
    const source = await book("S", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "담당자"], ["S", 3, "박"], ["V", 4, "최"]]));
    const { output } = await run([target, source]);
    expect(values(output.getWorksheet("표")!, 4)).toEqual([["S", null, 3, "박"], ["V", null, 4, "최"]]);
  });

  it("M03 keeps a source-only field for review instead of merging it into another column", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "등록일"], ["T", 1, "2026-08-01"], ["U", 2, "2026-08-02"]]));
    const source = await book("S", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "비고", "등록일"], ["S", 3, "메모", "2026-08-03"], ["V", 4, "메모2", "2026-08-04"]]));
    const { draft, output } = await run([target, source]);
    const extra = draft.mappings.find((mapping) => mapping.targetField === "비고")!;
    expect(extra).toMatchObject({ status: "review", included: false });
    expect(extra.targetColumn).toBeUndefined();
    expect(values(output.getWorksheet("표")!, 4)).toEqual([["S", 3, "2026-08-03"], ["V", 4, "2026-08-04"]]);

    // Included by the user, the field becomes a new column; nothing shifts.
    const { output: included } = await run([target, source], (built) => ({
      ...defaults(built),
      mappings: built.mappings.map((mapping) => mapping.targetField === "비고" ? { ...mapping, included: true } : mapping),
    }));
    expect(values(included.getWorksheet("표")!, 1)).toEqual([
      ["부서", "매출", "등록일", "비고"], ["T", 1, "2026-08-01", null], ["U", 2, "2026-08-02", null], ["S", 3, "2026-08-03", "메모"], ["V", 4, "2026-08-04", "메모2"],
    ]);
  });

  it("M04 merges only established synonyms; a lookalike header is never merged", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "비용", "기준일"], ["T", 1, 10, "2026-08-01"], ["U", 2, 20, "2026-08-02"]]));
    const source = await book("S", (workbook) => workbook.addWorksheet("표").addRows([["부서명", "매출액", "금액", "기준일"], ["S", 3, 30, "2026-08-03"], ["V", 4, 40, "2026-08-04"]]));
    const { draft, output } = await run([target, source]);
    expect(draft.mappings.find((mapping) => mapping.targetField === "매출")!.status).toBe("suggested");
    // 금액 sits between the same matched neighbours as 비용: offered for review, not confirmed.
    const cost = draft.mappings.find((mapping) => mapping.targetField === "비용")!;
    expect(cost.status).toBe("review");
    expect(values(output.getWorksheet("표")!, 4).map((row) => row.slice(0, 2))).toEqual([["S", 3], ["V", 4]]);
  });

  it("M05 finds the header under a title and spacer rows and never appends the title", async () => {
    const titled = (fileId: string, rows: unknown[][]) => book(fileId, (workbook) => {
      const sheet = workbook.addWorksheet("현황");
      sheet.mergeCells("A1:C1");
      sheet.getCell("A1").value = `${fileId} 8월 현황 보고`;
      sheet.getCell("A2").value = "작성: 운영팀";
      sheet.addRow([]);
      sheet.addRows([["부서", "건수", "기준일"], ...rows]);
    });
    const { draft, output } = await run([
      await titled("T", [["T", 1, "2026-08-01"], ["U", 2, "2026-08-02"]]),
      await titled("S", [["S", 3, "2026-08-03"]]),
    ]);
    expect(draft.targets[0].recordCount).toBe(3);
    const sheet = output.getWorksheet("현황")!;
    expect(sheet.getCell("A1").value).toBe("T 8월 현황 보고");
    expect(values(sheet, 5)).toEqual([["T", 1, "2026-08-01"], ["U", 2, "2026-08-02"], ["S", 3, "2026-08-03"]]);
  });

  it("M06 keeps every source row after a blank row inside the table", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["부서", "건수", "기준일"], ["T1", 1, "2026-08-01"], ["T2", 2, "2026-08-02"]]));
    const source = await book("S", (workbook) => workbook.addWorksheet("표").addRows([
      ["부서", "건수", "기준일"], ["S1", 3, "2026-08-03"], ["S2", 4, "2026-08-04"], [], ["S3", 5, "2026-08-05"], ["S4", 6, "2026-08-06"],
      // A printed page break repeats the header; the source's own total is not a record.
      [], ["부서", "건수", "기준일"], ["S5", 7, "2026-08-07"], ["합계", { formula: "SUM(B2:B9)", result: 25 }, null],
    ]));
    const { draft, output } = await run([target, source]);
    expect(draft.targets[0].recordCount).toBe(7);
    expect(values(output.getWorksheet("표")!, 4).map((row) => row[0])).toEqual(["S1", "S2", "S3", "S4", "S5"]);
  });

  it("M07 appends only the record table when a sheet also holds a small reference table", async () => {
    const shape = (fileId: string, names: string[]) => book(fileId, (workbook) => {
      const sheet = workbook.addWorksheet("표");
      sheet.addRows([["부서", "건수", "기준일"], ...names.map((name, index) => [name, index + 1, `2026-08-0${index + 1}`]), [], ["코드", "설명"], ["A", "정상"], ["B", "보류"]]);
    });
    const { draft, output } = await run([await shape("T", ["T1", "T2", "T3"]), await shape("S", ["S1", "S2", "S3"])]);
    const sheet = output.getWorksheet("표")!;
    expect(values(sheet, 1, 3)).toEqual([
      ["부서", "건수", "기준일"], ["T1", 1, "2026-08-01"], ["T2", 2, "2026-08-02"], ["T3", 3, "2026-08-03"],
      ["S1", 1, "2026-08-01"], ["S2", 2, "2026-08-02"], ["S3", 3, "2026-08-03"],
      [null, null, null], ["코드", "설명", null], ["A", "정상", null], ["B", "보류", null],
    ]);
    expect(draft.issues.some((issue) => issue.fileName === "S.xlsx" && issue.sheetName === "표"
      && issue.message.includes("추가 표") && issue.message.includes("자동 취합되지 않습니다"))).toBe(true);
  });

  it("M08 keeps target-only sheets and leaves a source-only sheet for review", async () => {
    const target = await book("T", (workbook) => {
      workbook.addWorksheet("직원").addRows([["이름", "부서", "입사일"], ["김", "운영", "2026-01-01"], ["이", "지원", "2026-02-01"]]);
      workbook.addWorksheet("참조").addRows([["기준 정보"], ["변경 금지"]]);
    });
    const source = await book("S", (workbook) => {
      workbook.addWorksheet("직원").addRows([["이름", "부서", "입사일"], ["박", "영업", "2026-03-01"]]);
      workbook.addWorksheet("신규 시트").addRows([["품목", "재고", "창고"], ["볼트", 10, "A"], ["너트", 20, "B"]]);
    });
    const { draft, output } = await run([target, source]);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["직원", "참조"]);
    expect(output.getWorksheet("참조")!.getCell("A2").value).toBe("변경 금지");
    const extra = draft.workbooks[1].sheets.find((sheet) => sheet.name === "신규 시트")!;
    expect(extra.plan.kind).toBe("unmatched");
    expect(draft.issues.some((issue) => issue.sheetName === "신규 시트")).toBe(true);
    const { output: withExtra } = await run([target, source], (built) => ({ ...defaults(built), sheetIds: [...defaults(built).sheetIds, extra.id] }));
    expect(withExtra.worksheets.map((sheet) => sheet.name)).toEqual(["직원", "참조", "신규 시트"]);
    expect(values(withExtra.getWorksheet("신규 시트")!, 2)).toEqual([["볼트", 10, "A"], ["너트", 20, "B"]]);
  });

  it("M09 never selects hidden or veryHidden source sheets by default", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["부서", "건수", "기준일"], ["T", 1, "2026-08-01"], ["U", 2, "2026-08-02"]]));
    const source = await book("S", (workbook) => {
      workbook.addWorksheet("표").addRows([["부서", "건수", "기준일"], ["S", 3, "2026-08-03"]]);
      workbook.addWorksheet("숨김", { state: "hidden" }).addRows([["부서", "건수", "기준일"], ["H", 9, "2026-08-09"], ["H2", 9, "2026-08-09"]]);
      workbook.addWorksheet("완전숨김", { state: "veryHidden" }).addRows([["부서", "건수", "기준일"], ["V", 9, "2026-08-09"], ["V2", 9, "2026-08-09"]]);
    });
    const { draft, output } = await run([target, source]);
    const hidden = draft.workbooks[1].sheets.filter((sheet) => sheet.visibility !== "visible");
    expect(hidden.map((sheet) => [sheet.visibility, sheet.selectedByDefault])).toEqual([["hidden", false], ["veryHidden", false]]);
    expect(values(output.getWorksheet("표")!, 2).map((row) => row[0])).toEqual(["T", "U", "S"]);
  });

  it("M10 creates no phantom records from empty or header-only sheets", async () => {
    const target = await book("T", (workbook) => {
      workbook.addWorksheet("표").addRows([["부서", "건수", "기준일"], ["T", 1, "2026-08-01"], ["U", 2, "2026-08-02"]]);
      workbook.addWorksheet("빈 시트");
    });
    const source = await book("S", (workbook) => {
      workbook.addWorksheet("표").addRows([["부서", "건수", "기준일"]]);
      workbook.addWorksheet("빈 시트");
    });
    const { draft, output } = await run([target, source]);
    expect(draft.records).toHaveLength(2);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["표"]);
    expect(output.getWorksheet("표")!.rowCount).toBe(3);
  });

  it("M11 preserves value types and number formats through the round trip", async () => {
    const typed = (fileId: string) => book(fileId, (workbook) => {
      const sheet = workbook.addWorksheet("타입");
      sheet.addRow(["구분", "정수", "소수", "음수", "영", "비율", "통화", "원", "참거짓", "날짜", "일시", "오류"]);
      const row = sheet.addRow([`${fileId}-행`, 1234, 1234.5, -7, 0, 0.123, 1234, 1234, true,
        new Date(Date.UTC(2026, 8, 25)), new Date(Date.UTC(2026, 8, 25, 13, 45)), { error: "#N/A" }]);
      sheet.addRow([`${fileId}-행2`, 1, 1, 1, 1, 1, 1, 1, false, new Date(Date.UTC(2024, 1, 29)), new Date(Date.UTC(2024, 1, 29, 0, 0)), 1]);
      [["B", "#,##0"], ["C", "#,##0.00"], ["F", "0.00%"], ["G", "₩#,##0"], ["H", '#,##0"원"'], ["J", "yyyy.mm.dd"], ["K", "yyyy.mm.dd hh:mm"]].forEach(([column, format]) => {
        sheet.getColumn(column).eachCell((cell, number) => { if (number > 1) cell.numFmt = format; });
      });
      void row;
    });
    const { output, reparsed } = await run([await typed("T"), await typed("S")]);
    const sheet = output.getWorksheet("타입")!;
    const appended = sheet.getRow(4);
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((column) => appended.getCell(column).value)).toEqual([1234, 1234.5, -7, 0, 0.123, 1234, 1234, true]);
    expect([2, 3, 6, 7, 8, 10, 11].map((column) => appended.getCell(column).numFmt)).toEqual(["#,##0", "#,##0.00", "0.00%", "₩#,##0", '#,##0"원"', "yyyy.mm.dd", "yyyy.mm.dd hh:mm"]);
    expect((appended.getCell(10).value as Date).toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect((appended.getCell(11).value as Date).toISOString()).toBe("2026-09-25T13:45:00.000Z");
    // An error is never data: the appended cell stays empty rather than holding error text.
    expect(appended.getCell(12).value).toBeNull();
    // The product parser reads the result back with the same values and formats.
    // (Its display text renders only percent formats; Excel renders the rest from numFmt.)
    const reread = reparsed.workbookSheets![0].table.rows[3];
    expect(reread.slice(1, 9).map((cell) => [cell.value, cell.numberFormat ?? null])).toEqual([
      [1234, "#,##0"], [1234.5, "#,##0.00"], [-7, null], [0, null], [0.123, "0.00%"], [1234, "₩#,##0"], [1234, '#,##0"원"'], [true, null],
    ]);
  });

  it("M12 reads one calendar day written five ways as that day, and a plain number as a number", async () => {
    const target = await book("T", (workbook) => {
      const sheet = workbook.addWorksheet("일자");
      sheet.addRows([["구분", "일자", "건수"], ["T1", new Date(Date.UTC(2026, 8, 25)), 45925], ["T2", new Date(Date.UTC(2026, 8, 26)), 3]]);
      sheet.getColumn(2).eachCell((cell, number) => { if (number > 1) cell.numFmt = "yyyy-mm-dd"; });
    });
    const source = await book("S", (workbook) => {
      const sheet = workbook.addWorksheet("일자");
      sheet.addRows([["구분", "일자", "건수"], ["문자 ISO", "2026-09-25", 1], ["점", "2026.09.25", 2], ["슬래시", "2026/09/25", 3], ["serial", 46290, 45925], ["잘못된 날짜", "2025-02-29", 5]]);
      sheet.getCell("B5").numFmt = "yyyy.mm.dd";
    });
    const { output } = await run([target, source]);
    const rows = values(output.getWorksheet("일자")!, 4);
    expect(rows.slice(0, 4).map((row) => row[1])).toEqual(["2026-09-25T00:00", "2026-09-25T00:00", "2026-09-25T00:00", "2026-09-25T00:00"]);
    expect(rows[3][2]).toBe(45925);
    // Not a real day: kept as the text the user typed, never rolled into March.
    expect(rows[4][1]).toBe("2025-02-29");
  });

  it("M13 keeps summary formulas live and stretches their ranges over the final rows", async () => {
    const shape = (fileId: string, names: string[]) => book(fileId, (workbook) => {
      workbook.addWorksheet("데이터").addRows([["부서", "금액", "상태"], ...names.map((name, index) => [name, (index + 1) * 100, index % 2 ? "완료" : "진행"])]);
      const summary = workbook.addWorksheet("요약");
      const last = names.length + 1;
      summary.addRows([
        ["항목", "값"],
        ["합계", { formula: `SUM(데이터!B2:B${last})`, result: 0 }],
        ["건수", { formula: `COUNTA(데이터!A2:A${last})`, result: 0 }],
        ["완료", { formula: `COUNTIF(데이터!C2:C${last},"완료")`, result: 0 }],
        ["완료금액", { formula: `SUMIF(데이터!C2:C${last},"완료",데이터!B2:B${last})`, result: 0 }],
        ["판정", { formula: `IF(B2>1000,"초과","정상")`, result: "정상" }],
      ]);
    });
    const { output, files } = await run([await shape("T", ["T1", "T2", "T3"]), await shape("S", ["S1", "S2"])]);
    expect(values(output.getWorksheet("요약")!, 2).map((row) => row[1])).toEqual([
      "=SUM(데이터!B2:B6)", "=COUNTA(데이터!A2:A6)", "=COUNTIF(데이터!C2:C6,\"완료\")", "=SUMIF(데이터!C2:C6,\"완료\",데이터!B2:B6)", "=IF(B2>1000,\"초과\",\"정상\")",
    ]);
    expect(Object.keys(files).some((path) => path.startsWith("xl/externalLinks/"))).toBe(false);
  });

  it("M14 writes an external workbook reference as its cached value with no external link part", async () => {
    const shape = (fileId: string) => book(fileId, (workbook) => {
      workbook.addWorksheet("표").addRows([
        ["부서", "금액", "기준일"],
        [`${fileId}1`, { formula: "'[Other.xlsx]Sheet1'!A1", result: 77 }, "2026-08-01"],
        [`${fileId}2`, 5, "2026-08-02"],
      ]);
    });
    const { output, files } = await run([await shape("T"), await shape("S")]);
    const rows = values(output.getWorksheet("표")!, 2);
    expect(rows.map((row) => row[1])).toEqual([77, 5, 77, 5]);
    const xml = Object.entries(files).filter(([path]) => path.startsWith("xl/")).map(([, bytes]) => strFromU8(bytes)).join("\n");
    expect(xml).not.toMatch(/Other\.xlsx|externalLink/u);
  });

  it("M15 keeps special strings as text and never turns them into formulas", async () => {
    const texts = ["쉼표, 포함", "탭\t포함", "줄\n바꿈", "따옴표 \"인용\"", "'작은따옴표", "=SUM(A1:A2)", "+1234", "-cmd", "@user", "English", "이모지 😀", "가".repeat(3000)];
    const shape = (fileId: string) => book(fileId, (workbook) => {
      workbook.addWorksheet("문자").addRows([["번호표", "내용", "구분"], ...texts.map((text, index) => [`${fileId}-${index}`, text, "x"])]);
    });
    const { output, files } = await run([await shape("T"), await shape("S")]);
    const appended = values(output.getWorksheet("문자")!, 2 + texts.length).map((row) => row[1]);
    expect(appended).toEqual(texts);
    const sheetXml = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(sheetXml).not.toContain("<f>");
  });

  it("M16 marks exact duplicates only and never removes a row", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["관리번호", "제목", "금액"], ["ID-1", "같음", 10], ["ID-2", "다름", 20]]));
    const source = await book("S", (workbook) => workbook.addWorksheet("표").addRows([["관리번호", "제목", "금액"], ["ID-1", "같음", 10], ["ID-2", "제목 바뀜", 20]]));
    const { draft, output } = await run([target, source]);
    const duplicates = draft.records.filter((record) => record.duplicateOf);
    expect(duplicates).toHaveLength(1);
    expect(values(output.getWorksheet("표")!, 2)).toEqual([["ID-1", "같음", 10], ["ID-2", "다름", 20], ["ID-1", "같음", 10], ["ID-2", "제목 바뀜", 20]]);
  });

  it("M17 moves a merged, bordered footer below the appended rows with its formula range", async () => {
    const target = await book("T", (workbook) => {
      const sheet = workbook.addWorksheet("정산");
      sheet.addRows([["부서", "금액", "비고"], ["T1", 10, "a"], ["T2", 20, "b"], ["합계", { formula: "SUM(B2:B3)", result: 30 }, null], ["서명", null, null]]);
      sheet.mergeCells("B5:C5");
      ["A", "B", "C"].forEach((column) => { sheet.getCell(`${column}4`).border = { top: { style: "double" }, bottom: { style: "double" } }; });
    });
    const source = await book("S", (workbook) => workbook.addWorksheet("정산").addRows([["부서", "금액", "비고"], ["S1", 30, "c"], ["S2", 40, "d"]]));
    const { output, files } = await run([target, source]);
    const sheet = output.getWorksheet("정산")!;
    expect(values(sheet, 2)).toEqual([["T1", 10, "a"], ["T2", 20, "b"], ["S1", 30, "c"], ["S2", 40, "d"], ["합계", "=SUM(B2:B5)", null], ["서명", null, null]]);
    expect(sheet.getCell("A6").border.top?.style).toBe("double");
    expect(strFromU8(files["xl/worksheets/sheet1.xml"])).toContain('<mergeCell ref="B7:C7"/>');
  });

  it("M18 keeps sheet order and makes long, similar result sheet names unique", async () => {
    const long = "아주 긴 시트 이름이 엑셀의 서른한 글자 한도를 넘는 경우";
    const target = await book("T", (workbook) => {
      workbook.addWorksheet("2026").addRows([["부서", "건수", "기준일"], ["T", 1, "2026-08-01"], ["U", 2, "2026-08-02"]]);
      workbook.addWorksheet("공백 포함 시트").addRows([["이름", "값", "메모"], ["a", 1, "x"], ["b", 2, "y"]]);
    });
    const source = await book("S", (workbook) => {
      workbook.addWorksheet(long.slice(0, 31)).addRows([["품목", "재고", "창고"], ["볼트", 10, "A"], ["너트", 20, "B"]]);
      workbook.addWorksheet(`${long.slice(0, 29)}2`).addRows([["코드", "수량", "위치"], ["x", 1, "1층"], ["y", 2, "2층"]]);
    });
    const { output } = await run([target, source], (draft) => ({ ...defaults(draft), sheetIds: draft.workbooks.flatMap((workbook) => workbook.sheets.map((sheet) => sheet.id)) }));
    const names = output.worksheets.map((sheet) => sheet.name);
    expect(names.slice(0, 2)).toEqual(["2026", "공백 포함 시트"]);
    expect(names).toHaveLength(4);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4);
    expect(names.every((name) => name.length <= 31)).toBe(true);
  });

  it("M19 leaves out exactly an excluded field and a deselected source sheet", async () => {
    const target = await book("T", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "비용"], ["T", 1, 10], ["U", 2, 20]]));
    const s1 = await book("S1", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "비용"], ["A", 3, 30]]));
    const s2 = await book("S2", (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "비용"], ["B", 4, 40]]));
    const { output } = await run([target, s1, s2], (draft) => {
      const base = defaults(draft);
      return {
        sheetIds: base.sheetIds.filter((id) => id !== sheetIdOf(draft, "S1", "표")),
        mappings: draft.mappings.map((mapping) => mapping.targetField === "비용" ? { ...mapping, included: false } : mapping),
      };
    });
    // The template column stays (the target's own values); only the appended value is omitted.
    expect(values(output.getWorksheet("표")!, 1)).toEqual([["부서", "매출", "비용"], ["T", 1, 10], ["U", 2, 20], ["B", 4, null]]);
  });

  it("M20 rejects damaged XLSX inputs with a clear error instead of hanging", async () => {
    const zipped = new Uint8Array(await (() => { const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("a").addRow(["x", "y"]); return workbook.xlsx.writeBuffer(); })() as ArrayBuffer);
    const withoutWorkbook = (() => {
      const files = unzipSync(zipped);
      delete files["xl/workbook.xml"];
      return files;
    })();
    const inputs: Array<[string, Uint8Array]> = [
      ["not a zip", new TextEncoder().encode("this is not a workbook")],
      ["empty", new Uint8Array()],
      ["truncated", zipped.slice(0, Math.floor(zipped.length / 2))],
      ["missing workbook.xml", zipSync(withoutWorkbook)],
    ];
    for (const [label, bytes] of inputs) {
      const outcome = await parseDocument({ fileId: label, fileName: `${label}.xlsx`, bytes }).then(() => "parsed", (error: Error) => error.name);
      expect(outcome, label).toBe("DocumentError");
    }
  });

  it("M21 appends a 5×2,000-row, 16-column workbook without losing a row", async () => {
    const columns = Array.from({ length: 16 }, (_, index) => index === 0 ? "관리번호" : index === 1 ? "등록일" : `항목${index}`);
    const large = (fileId: string, sheets: number, rows: number) => book(fileId, (workbook) => {
      for (let sheetIndex = 0; sheetIndex < sheets; sheetIndex += 1) {
        const sheet = workbook.addWorksheet(`데이터${sheetIndex + 1}`);
        sheet.addRow(columns);
        for (let row = 0; row < rows; row += 1) {
          sheet.addRow([`${fileId}-${sheetIndex}-${row}`, new Date(Date.UTC(2026, 0, 1 + (row % 300))), ...Array.from({ length: 14 }, (_, index) => row * 16 + index)]);
        }
      }
    });
    const started = performance.now();
    const documents = [await large("T", 5, 2_000), await large("S", 5, 2_000)];
    const parsed = performance.now();
    const { draft, output } = await run(documents);
    const finished = performance.now();
    expect(draft.targets.map((target) => target.recordCount)).toEqual([4_000, 4_000, 4_000, 4_000, 4_000]);
    for (const sheet of output.worksheets) {
      expect(sheet.rowCount).toBe(4_001);
      expect(sheet.getCell(4_001, 1).value).toBe(`S-${Number(sheet.name.slice(-1)) - 1}-1999`);
    }
    console.info(`[aggregation M21] parse ${Math.round(parsed - started)}ms, draft+export+reopen ${Math.round(finished - parsed)}ms`);
  }, 120_000);

  it("M22 produces identical results for identical input on repeated runs", async () => {
    const shape = (fileId: string) => book(fileId, (workbook) => workbook.addWorksheet("표").addRows([["부서", "매출", "기준일"], [`${fileId}1`, 1, "2026-08-01"], [`${fileId}2`, 2, "2026-08-02"]]));
    const documents = [await shape("T"), await shape("S")];
    const first = await run(documents);
    const second = await run(documents);
    expect(values(second.output.getWorksheet("표")!)).toEqual(values(first.output.getWorksheet("표")!));
  });

  it("M23 keeps Before/After pictures in their own record cells and a decorative logo, across identical bytes", async () => {
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZsXcAAAAASUVORK5CYII=", "base64");
    const shape = (fileId: string, logo: boolean) => book(fileId, (workbook) => {
      const sheet = workbook.addWorksheet("사진");
      sheet.addRows([["개선 대장"], ["관리 No", "Before", "After", "내용"], [`${fileId}-01`, null, null, "현상"], [`${fileId}-02`, null, null, "개선"]]);
      const image = workbook.addImage({ buffer: pixel as unknown as ExcelJS.Buffer, extension: "png" });
      // Before of the first record, After (two pictures) of the second.
      sheet.addImage(image, { tl: { col: 1.1, row: 2.1 }, br: { col: 1.9, row: 2.9 } } as ExcelJS.ImageRange);
      sheet.addImage(image, { tl: { col: 2.05, row: 3.1 }, br: { col: 2.45, row: 3.9 } } as ExcelJS.ImageRange);
      sheet.addImage(image, { tl: { col: 2.55, row: 3.1 }, br: { col: 2.95, row: 3.9 } } as ExcelJS.ImageRange);
      if (logo) sheet.addImage(image, { tl: { col: 3.2, row: 0 }, ext: { width: 40, height: 16 } });
    });
    const { draft, output, files } = await run([await shape("T", true), await shape("S", false)]);
    const roles = draft.records.map((record) => [record.fields[0].value.displayValue, record.media.map((media) => media.role)]);
    expect(roles).toEqual([["T-01", ["Before"]], ["T-02", ["After", "After"]], ["S-01", ["Before"]], ["S-02", ["After", "After"]]]);
    const pictures = output.getWorksheet("사진")!.getImages().map((image) => [Math.floor(image.range.tl.nativeRow) + 1, Math.floor(image.range.tl.nativeCol) + 1]);
    // Row 3–6 are the four records; column 2 Before, column 3 After; the logo stays in row 1.
    expect(pictures.sort((left, right) => left[0] - right[0] || left[1] - right[1])).toEqual([[1, 4], [3, 2], [4, 3], [4, 3], [5, 2], [6, 3], [6, 3]]);
    expect(output.worksheets.map((sheet) => sheet.name)).toEqual(["사진"]);
    expect(Object.keys(files).filter((path) => /^xl\/media\/.+/u.test(path))).toHaveLength(1);
  });

  it("M24 appends a workbook selected twice as two sources without either overwriting the other", async () => {
    const bytes = await (() => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("표").addRows([["부서", "매출", "기준일"], ["A", 1, "2026-08-01"], ["B", 2, "2026-08-02"]]);
      return workbook.xlsx.writeBuffer();
    })();
    const documents = await Promise.all(["copy-1", "copy-2", "copy-3"].map((fileId) => parseDocument({ fileId, fileName: "같은 파일.xlsx", bytes: new Uint8Array(bytes as ArrayBuffer) })));
    const { draft, output } = await run(documents);
    expect(new Set(draft.records.map((record) => record.id)).size).toBe(6);
    expect(values(output.getWorksheet("표")!, 2).map((row) => row[0])).toEqual(["A", "B", "A", "B", "A", "B"]);
  });

  it("M25 preserves a real record whose category is 합계", async () => {
    const shape = (fileId: string, last: string) => book(fileId, (workbook) =>
      workbook.addWorksheet("실적").addRows([
        ["구분", "건수", "기준일"],
        [`${fileId}-운영`, 1, "2026-08-01"],
        [last, 2, "2026-08-02"],
      ]));
    const { draft, output } = await run([await shape("T", "합계"), await shape("S", "합계")]);
    expect(draft.targets[0].recordCount).toBe(4);
    expect(values(output.getWorksheet("실적")!, 2).map((row) => row[0]))
      .toEqual(["T-운영", "합계", "S-운영", "합계"]);
  });

  it("M26 does not mistake a calculated data row for a footer", async () => {
    const shape = (fileId: string) => book(fileId, (workbook) =>
      workbook.addWorksheet("누적 실적").addRows([
        ["부서", "금액", "기준일"],
        [`${fileId}-1`, 10, "2026-08-01"],
        [`${fileId}-2`, 20, "2026-08-02"],
        [`${fileId}-3`, { formula: "SUM(B2:B3)", result: 30 }, "2026-08-03"],
      ]));
    const { draft, output } = await run([await shape("T"), await shape("S")]);
    expect(draft.targets[0].recordCount).toBe(6);
    expect(values(output.getWorksheet("누적 실적")!, 2).map((row) => row[0]))
      .toEqual(["T-1", "T-2", "T-3", "S-1", "S-2", "S-3"]);
  });
});
