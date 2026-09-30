import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { NormalizedDocument } from "@/domain/document";
import { parseDocument } from "@/lib/parsers";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement } from "@/lib/supplement/finalize";

type Cell = string | number | null;
interface SheetSpec {
  name: string;
  rows: Cell[][];
  hidden?: boolean;
  /** 1-based columns whose numbers are fractions shown as percentages. */
  percent?: number[];
  merges?: string[];
}

async function parseWorkbook(sheets: SheetSpec[], fileName = "보고.xlsx"): Promise<NormalizedDocument> {
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, spec.hidden ? { state: "hidden" } : {});
    for (const values of spec.rows) {
      const row = sheet.addRow(values);
      for (const column of spec.percent ?? []) {
        const cell = row.getCell(column);
        if (typeof cell.value === "number") cell.numFmt = "0.0%";
      }
    }
    for (const range of spec.merges ?? []) sheet.mergeCells(range);
  }
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  return parseDocument({ fileId: fileName, fileName, bytes });
}

async function analyse(sheets: SheetSpec[], fileName?: string) {
  const document = await parseWorkbook(sheets, fileName);
  const draft = buildSupplementDraft([{ document, fileName: fileName ?? "보고.xlsx" }]);
  return { draft, result: finalizeSupplement(draft, new Map()) };
}

const SUMMARY: SheetSpec = {
  name: "Summary",
  percent: [6],
  rows: [
    ["2026년 9월 물류 실적 (단위: 백만원)"],
    [],
    ["구분", "목표", "실적", "달성률", "전월", "전월 대비 증감률"],
    ["매출", 1200, 1250, "104%", 1180, 0.059],
    ["물류비", 400, 475, "119%", 400, 0.187],
    ["인건비", 300, 305, "102%", 298, 0.023],
    ["영업이익", 150, 148, "99%", 145, 0.021],
  ],
};

describe("보완 — workbook analysis", () => {
  it("flags a large unexplained increase at its own cell", async () => {
    const { result } = await analyse([SUMMARY]);
    expect(result.files[0].docType).toBe("performance");
    const cause = result.findings.filter((finding) => finding.check === "cause");
    expect(cause).toHaveLength(1);
    expect(cause[0].locations).toEqual(["Summary / F5"]);
    expect(cause[0].message).toBe("물류비가 전월 대비 18.7% 증가했다고 제시되어 있지만 현재 자료에서 주요 증가 원인 설명을 확인하지 못했습니다.");
    expect(cause[0].question).toBe("왜 물류비가 18.7% 증가했습니까?");
    // Target, period, unit and comparison are all stated in the title and headers.
    expect(result.findings.map((finding) => finding.check)).toEqual(["cause"]);
    expect(result.coverage[0]).toMatchObject({ unit: "시트", total: 1, analyzed: 1, complete: true });
  });

  it("accepts a cause decomposed on an analysis sheet", async () => {
    const { result } = await analyse([SUMMARY, {
      name: "Cost_Analysis",
      rows: [["물류비 증가 요인 분석"], ["요인", "기여"], ["유가 영향", "+8.2%p"], ["물동량 영향", "+6.1%p"], ["기타", "+4.4%p"]],
    }]);
    expect(result.findings).toEqual([]);
  });

  it("accepts a written explanation on a sheet named for analysis", async () => {
    const { result } = await analyse([SUMMARY, { name: "원인분석", rows: [["주요 내용"], ["유가 상승과 운송거리 증가로 운송 지출 확대"]] }]);
    expect(result.findings.some((finding) => finding.check === "cause")).toBe(false);
  });

  it("accepts an explanation column filled in the same row", async () => {
    const { result } = await analyse([{
      ...SUMMARY,
      rows: SUMMARY.rows.map((row, index) => index === 2 ? [...row, "비고"] : index === 4 ? [...row, "유가 상승"] : row),
    }]);
    expect(result.findings).toEqual([]);
  });

  it("asks for the target behind an attainment rate", async () => {
    const { result } = await analyse([{ name: "Summary", rows: [["2026년 9월 매출 실적 (단위: 백만원)"], ["구분", "실적", "달성률"], ["국내 매출", 1250, "104%"], ["해외 매출", 830, "92%"]] }]);
    const target = result.findings.find((finding) => finding.check === "target");
    expect(target?.title).toBe("목표/예산 기준 확인 필요");
    expect(target?.locations).toEqual(["Summary / A2:C4"]);
  });

  it("takes the unit and the period from the title above the table", async () => {
    const stated = await analyse([{ name: "비용", rows: [["2026년 9월 비용 현황"], ["단위: 백만원"], ["항목", "목표", "실적"], ["운송비", 400, 410], ["보관비", 120, 118]] }]);
    expect(stated.result.findings).toEqual([]);
    const missing = await analyse([{ name: "비용", rows: [["항목", "목표", "실적"], ["운송비", 400, 410], ["보관비", 120, 118]] }], "비용보고.xlsx");
    expect(missing.result.findings.map((finding) => finding.title).sort()).toEqual(["기준 기간 확인 필요", "단위 확인 필요"]);
  });

  it("uses raw data only as evidence and never reports its rows", async () => {
    const raw: Cell[][] = [["일자", "금액"]];
    for (let index = 0; index < 40_000; index += 1) raw.push([`2026-09-${String((index % 28) + 1).padStart(2, "0")}`, 1000 + (index % 97)]);
    const { draft, result } = await analyse([SUMMARY, { name: "Raw_Data", rows: raw }]);
    const rawSheet = result.coverage[0].sheets?.find((sheet) => sheet.name === "Raw_Data");
    expect(rawSheet).toMatchObject({ status: "structure", rows: 40_001 });
    expect(result.findings.every((finding) => finding.locations.every((location) => location.startsWith("Summary")))).toBe(true);
    // The semantic re-check sees a handful of lines, never the data rows.
    expect(draft.reviews.flatMap((batch) => batch.items).length).toBeLessThanOrEqual(40);
    expect(result.coverage[0].notes.join(" ")).toContain("Raw_Data");
  });

  it("gives every sheet of a large workbook a status", async () => {
    const sheets: SheetSpec[] = [SUMMARY];
    for (let index = 1; index <= 21; index += 1) sheets.push({ name: `지점${index}`, rows: [["2026년 9월 지점 현황 (단위: 건)"], ["구분", "목표", "실적"], ["처리", 100, 100 + index]] });
    const { result } = await analyse(sheets);
    const manifest = result.coverage[0].sheets!;
    expect(manifest).toHaveLength(22);
    expect(manifest.every((sheet) => ["detailed", "limited", "structure", "failed"].includes(sheet.status))).toBe(true);
    expect(result.coverage[0].total).toBe(22);
  });

  it("checks hidden helper sheets for structure only", async () => {
    const { result } = await analyse([SUMMARY, { name: "Config", hidden: true, rows: [["키", "값"], ["환율", 1380]] }, { name: "Lookup", hidden: true, rows: [["코드", "이름"], ["A01", "서울"]] }]);
    const hidden = result.coverage[0].sheets!.filter((sheet) => sheet.hidden);
    expect(hidden.map((sheet) => [sheet.name, sheet.status])).toEqual([["Config", "structure"], ["Lookup", "structure"]]);
    expect(result.coverage[0].complete).toBe(true);
    expect(result.findings.map((finding) => finding.check)).toEqual(["cause"]);
  });

  it("merges the same unexplained KPI change repeated on several sheets", async () => {
    const sheet = (name: string): SheetSpec => ({ name, percent: [4], rows: [["2026년 9월 (단위: 억원)"], ["구분", "전월", "당월", "전월 대비"], ["매출", 100, 88, -0.12], ["원가", 60, 61, 0.017]] });
    const { result } = await analyse([sheet("Summary"), sheet("Dashboard"), sheet("Monthly_Result")]);
    const causes = result.findings.filter((finding) => finding.check === "cause");
    expect(causes).toHaveLength(1);
    expect(causes[0].message).toContain("매출이 전월 대비 12% 감소");
    expect(causes[0].locations).toEqual(["Summary / D3", "Dashboard / D3", "Monthly_Result / D3"]);
  });

  it("reads stacked headers under a merged period label", async () => {
    const { result } = await analyse([{
      name: "Summary",
      merges: ["B1:C1"],
      rows: [["구분", "2026년 9월", null], [null, "목표", "실적"], ["운송비", 400, 410], ["보관비", 120, 118]],
    }], "운영.xlsx");
    expect(result.findings.some((finding) => finding.check === "baseline" || finding.check === "period")).toBe(false);
  });

  it("asks for follow-up on open issues in a register", async () => {
    const { result } = await analyse([{ name: "이슈관리", rows: [["2026년 9월 이슈 현황"], ["이슈", "영향", "상태", "조치"], ["A라인 설비 고장", "생산 2일 지연", "진행", ""], ["원자재 입고 지연", "납기 3건 지연", "완료", ""], ["품질 클레임", "고객 1곳", "진행", "공정 점검 (품질팀, 10/15)"]] }]);
    const response = result.findings.filter((finding) => finding.check === "response");
    expect(response).toHaveLength(1);
    expect(response[0].current).toContain("A라인 설비 고장");
  });

  it("reports an unread sheet and withholds certainty", async () => {
    const document = await parseWorkbook([SUMMARY]);
    const broken: NormalizedDocument = { ...document, metadata: { ...document.metadata, sheets: [...document.metadata.sheets!, { name: "Pivot", visibility: "visible", rowCount: 10, columnCount: 3 }] } };
    const result = finalizeSupplement(buildSupplementDraft([{ document: broken, fileName: "보고.xlsx" }]), new Map());
    expect(result.coverage[0].sheets!.find((sheet) => sheet.name === "Pivot")?.status).toBe("failed");
    expect(result.coverage[0].complete).toBe(false);
    expect(result.findings.every((finding) => finding.status === "unverified")).toBe(true);
  });
});
