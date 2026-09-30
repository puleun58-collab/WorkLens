import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "@/lib/parsers";
import { buildSupplementDraft } from "@/lib/supplement/engine";
import { finalizeSupplement } from "@/lib/supplement/finalize";
import { createPptxSlides, createUnicodePdf } from "./fixtures";

type File = { name: string; slides?: string[][]; pages?: string[][]; sheets?: Array<{ name: string; rows: (string | number)[][]; percent?: number[] }> };

async function bytesOf(file: File): Promise<Uint8Array> {
  if (file.slides) return createPptxSlides(file.slides);
  if (file.pages) return createUnicodePdf(file.pages.map((page) => page.map((text, index) => ({ text, size: index === 0 ? 16 : 11 }))));
  const workbook = new ExcelJS.Workbook();
  for (const spec of file.sheets!) {
    const sheet = workbook.addWorksheet(spec.name);
    for (const values of spec.rows) {
      const row = sheet.addRow(values);
      for (const column of spec.percent ?? []) if (typeof row.getCell(column).value === "number") row.getCell(column).numFmt = "0.0%";
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

async function analyse(files: File[]) {
  const inputs = await Promise.all(files.map(async (file) => ({ document: await parseDocument({ fileId: file.name, fileName: file.name, bytes: await bytesOf(file) }), fileName: file.name })));
  const draft = buildSupplementDraft(inputs);
  return { draft, result: finalizeSupplement(draft, new Map()) };
}

const REPORT: File = { name: "월간보고.pptx", slides: [["2026년 9월 월간 보고", "물류 운영 현황"], ["비용 현황", "물류비가 전월 대비 18% 증가했습니다."]] };

describe("보완 — several files as one set", () => {
  it("separates a report gap from a set gap when only the analysis file explains", async () => {
    const { result } = await analyse([REPORT, { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], ["물류비 증가 요인: 유가 상승과 운송거리 증가"]] }]);
    expect(result.files.map((file) => [file.fileName, file.role])).toEqual([["월간보고.pptx", "report"], ["원인분석.pdf", "analysis"]]);
    const cause = result.findings.filter((finding) => finding.check === "cause");
    expect(cause).toHaveLength(1);
    expect(cause[0]).toMatchObject({ scope: "report", title: "원인 설명을 보고자료에 추가하면 좋습니다", locations: ["월간보고.pptx / 2P"], evidenceLocations: ["원인분석.pdf / 2페이지"] });
    expect(cause[0].additions[0]).toContain("유가 상승");
  });

  it("reports one set gap when no file explains, across files", async () => {
    const { result } = await analyse([REPORT, { name: "실적.xlsx", sheets: [{ name: "Summary", percent: [4], rows: [["2026년 9월 물류 실적 (단위: 백만원)"], ["구분", "전월", "당월", "전월 대비"], ["물류비", 400, 475, 0.18], ["인건비", 300, 303, 0.01]] }] }]);
    const cause = result.findings.filter((finding) => finding.check === "cause");
    expect(cause).toHaveLength(1);
    expect(cause[0].scope).toBe("all");
    expect(cause[0].locations).toEqual(["월간보고.pptx / 2P", "실적.xlsx / Summary / D3"]);
    expect(cause[0].message).toContain("업로드된 자료 전체에서");
  });

  it("settles inside the report before looking at other files", async () => {
    const { result } = await analyse([
      { ...REPORT, slides: [...REPORT.slides!, ["증가 배경", "유가 상승과 운송거리 증가로 비용 확대"]] },
      { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], ["물류비 증가 요인: 유가 상승"]] },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("uses an analysis sheet of another workbook as evidence", async () => {
    const { result } = await analyse([REPORT, { name: "실적.xlsx", sheets: [{ name: "Cost_Analysis", rows: [["2026년 9월 물류비 증가 요인"], ["요인", "기여"], ["유가 영향", "+8.2%p"], ["물동량 영향", "+6.1%p"]] }] }]);
    const cause = result.findings.find((finding) => finding.check === "cause");
    expect(cause?.scope).toBe("report");
    expect(cause?.evidenceLocations?.[0]).toMatch(/^실적\.xlsx \/ Cost_Analysis \//u);
  });

  it("never uses another month's explanation as direct evidence", async () => {
    const { result } = await analyse([REPORT, { name: "원인분석.pdf", pages: [["2026년 8월 물류비 분석"], ["2026년 8월 물류비 증가 원인: 유가 상승"]] }]);
    const cause = result.findings.find((finding) => finding.check === "cause");
    expect(cause?.scope).toBe("all");
    expect(cause?.linkNote).toContain("기간(2026년 8월)");
  });

  it("links the same amount written in different units, and not a bare number", async () => {
    const report: File = { name: "보고.pptx", slides: [["2026년 9월 보고", "현황"], ["운송", "운송비 12억원, 전월 대비 20% 증가"]] };
    const workbook = (unit: string): File => ({ name: "집계.xlsx", sheets: [{ name: "원인정리", rows: [[`2026년 9월 (단위: ${unit})`], ["코드", "금액", "설명"], ["X-9", 1200, "유가 상승 영향으로 증가"]] }] });
    const linked = await analyse([report, workbook("백만원")]);
    expect(linked.result.findings.find((finding) => finding.check === "cause")?.scope).toBe("report");
    const unlinked = await analyse([report, workbook("원")]);
    expect(unlinked.result.findings.find((finding) => finding.check === "cause")?.scope).toBe("all");
  });

  it("reports differing main causes without choosing one", async () => {
    const { result } = await analyse([
      { ...REPORT, slides: [...REPORT.slides!, ["원인", "물류비 증가의 주요 원인은 유가 상승입니다."]] },
      { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], ["물류비 증가의 주된 원인은 물동량 증가입니다."]] },
    ]);
    const conflict = result.findings.find((finding) => finding.scope === "conflict");
    expect(conflict?.title).toBe("원인 설명이 자료별로 다릅니다");
    expect(conflict?.evidenceLocations).toEqual(["월간보고.pptx / 3P", "원인분석.pdf / 2페이지"]);
    expect(result.findings.filter((finding) => finding.scope !== "conflict")).toEqual([]);
  });

  it("merges the same gap raised by two reports", async () => {
    const { result } = await analyse([REPORT, { name: "월간보고서.pdf", pages: [["2026년 9월 월간 보고서"], ["물류비가 전월 대비 18% 증가했습니다."], ["결론", "비용 관리가 필요합니다."]] }]);
    const cause = result.findings.filter((finding) => finding.check === "cause");
    expect(cause).toHaveLength(1);
    expect(cause[0].locations).toEqual(["월간보고.pptx / 2P", "월간보고서.pdf / 2페이지"]);
  });

  it("judges each core report on its own", async () => {
    const { result } = await analyse([
      { name: "임원보고.pptx", slides: [["2026년 9월 임원 보고", "현황"], ["비용", "물류비가 전월 대비 18% 증가했습니다.", "유가 상승과 운송거리 증가로 비용 확대"]] },
      { name: "고객보고.pdf", pages: [["2026년 9월 고객 보고"], ["물류비가 전월 대비 18% 증가했습니다."], ["결론", "서비스 수준은 유지됩니다."]] },
    ]);
    expect(result.files.map((file) => file.role)).toEqual(["report", "report"]);
    const cause = result.findings.filter((finding) => finding.check === "cause");
    expect(cause.map((finding) => [finding.scope, finding.locations[0]])).toEqual([["report", "고객보고.pdf / 2페이지"]]);
  });

  it("stays quiet when the set and the report are complete", async () => {
    const { result } = await analyse([
      { name: "월간보고.pptx", slides: [["2026년 9월 월간 보고", "현황"], ["비용", "물류비가 전월 대비 18% 증가했습니다.", "유가 상승과 운송거리 증가로 비용 확대", "운송사 단가 재협상 예정 (물류팀, 11월)"]] },
      { name: "실적.xlsx", sheets: [{ name: "Summary", rows: [["2026년 9월 물류 실적 (단위: 백만원)"], ["구분", "목표", "실적"], ["물류비", 400, 475], ["인건비", 300, 303]] }] },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("does not count raw data rows as an explanation", async () => {
    const raw: (string | number)[][] = [["일자", "메모", "금액"]];
    for (let index = 0; index < 1_500; index += 1) raw.push(["2026-09-01", index % 2 ? "유가 상승 영향" : "정상", 1000]);
    const { result } = await analyse([REPORT, { name: "실적.xlsx", sheets: [{ name: "Raw_Data", rows: raw }] }]);
    expect(result.findings.find((finding) => finding.check === "cause")?.scope).toBe("all");
  });

  it("withholds certainty when another file was only partly read", async () => {
    const { result } = await analyse([REPORT, { name: "원인분석.pdf", pages: [["2026년 9월 물류비 분석"], []] }]);
    const cause = result.findings.find((finding) => finding.check === "cause");
    expect(cause?.status).toBe("unverified");
    expect(cause?.limitation).toContain("원인분석.pdf");
  });

  it("does not link another customer's or another cost line's explanation", async () => {
    const customers = await analyse([
      { name: "보고.pptx", slides: [["2026년 9월 매출 보고", "현황"], ["매출", "고객사 A 매출이 전월 대비 12% 감소했습니다."]] },
      { name: "원인분석.pdf", pages: [["2026년 9월 매출 분석"], ["고객사 B 매출 감소 원인: 단가 인하"]] },
    ]);
    expect(customers.result.findings.find((finding) => finding.check === "cause")?.scope).toBe("all");
    const lines = await analyse([
      { name: "보고.pptx", slides: [["2026년 9월 비용 보고", "현황"], ["운송", "운송비가 전월 대비 20% 증가했습니다."]] },
      { name: "원인분석.pdf", pages: [["2026년 9월 인사 분석"], ["인건비 증가 원인: 임금 인상"]] },
    ]);
    expect(lines.result.findings.find((finding) => finding.check === "cause")?.scope).toBe("all");
  });
});
