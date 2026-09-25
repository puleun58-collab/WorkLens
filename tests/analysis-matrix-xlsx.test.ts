import { describe, expect, it } from "vitest";
import { claimDisplayText } from "@/lib/analysis-presentation";
import { MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";
import { MAX_EVIDENCE_CANDIDATES } from "@/lib/ai/retrieval";
import { buildEvidenceNodes } from "@/lib/ai/grounding";
import {
  expectCovers,
  expectGrounded,
  expectNoNoise,
  runAnalyze,
  visibleTexts,
  windowTexts,
  type AnalyzeRun,
} from "./analysis-quality-harness";
import { seeded, xlsxFile, type Cell } from "./analysis-matrix-fixtures";

/** XLSX Analyze matrix: row/column/sheet/table structure must survive into meaning. */
const deterministic = (run: AnalyzeRun) => visibleTexts(run.fallback, run.metrics);
const pct = (value: number): Cell => ({ value, numFmt: "0%" });

describe("Analyze matrix · XLSX", () => {
  it("XLSX-01 KPI table keeps each row's label, header and formatted value together", async () => {
    const run = await runAnalyze([await xlsxFile("x01", "부서 KPI.xlsx", [{ name: "KPI", rows: [
      ["부서", "목표", "실적", "달성률"],
      ["영업1팀", 100, 90, pct(0.9)],
      ["영업2팀", 200, 220, pct(1.1)],
    ] }])]);
    expectCovers(deterministic(run), { team1: /영업1팀 — 목표: 100 · 실적: 90 · 달성률: 90%/u, team2: /영업2팀 — 목표: 200 · 실적: 220 · 달성률: 110%/u }, "XLSX-01");
    expectCovers(windowTexts(run), { rate: /영업2팀.*달성률.*110%/u, target: /영업1팀.*목표.*100/u }, "XLSX-01 window");
    const cell = run.items[0].sources.find((source) => source.cellRange === "D2");
    expect(cell?.sheet).toBe("KPI");
  });

  it("XLSX-02 period comparison: the change is grounded in both cells; an invented cause is rejected", async () => {
    const run = await runAnalyze([await xlsxFile("x02", "연도 비교.xlsx", [{ name: "비교", rows: [
      ["항목", "2025", "2026"], ["매출", 100, 120], ["비용", 60, 90],
    ] }])]);
    expectCovers(deterministic(run), { revenue: /매출 — 2025: 100 · 2026: 120/u, cost: /비용 — 2025: 60 · 2026: 90/u }, "XLSX-02");
    const { grounded, presented } = run.enrich([
      { text: "매출은 2025년 100에서 2026년 120으로 증가했습니다.", evidence: [/매출 2025 · 100/u, /매출 2026 · 120/u], role: "insight" },
      { text: "원자재 가격 상승 때문에 비용이 60에서 90으로 증가했습니다.", evidence: [/비용 2025 · 60/u, /비용 2026 · 90/u], role: "insight" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(1);
    expect(presented.insights.map(claimDisplayText)).toEqual(["매출은 2025년 100에서 2026년 120으로 증가했습니다."]);
    expect(presented.insights[0].evidence.map(({ source }) => source.cellRange)).toEqual(["B2", "C2"]);
    expectNoNoise(visibleTexts(presented), [/원자재/u]);
  });

  it("XLSX-03 multi-sheet workbook: every sheet is represented and none owns the result", async () => {
    const sheet = (name: string, label: string, base: number) => ({ name, rows: [
      ["구분", "1분기", "2분기"],
      ...Array.from({ length: 12 }, (_, index) => [`${label} ${index + 1}`, base + index, base + index * 2]),
    ] as Cell[][] });
    const run = await runAnalyze([await xlsxFile("x03", "경영 현황.xlsx", [
      { name: "요약", rows: [["항목", "내용"], ["목적", "분기별 매출과 비용, 인원 변동을 점검합니다."], ["결론", "2분기 비용 증가율이 매출 증가율보다 높습니다."]] },
      sheet("매출", "제품", 100), sheet("비용", "비목", 50), sheet("인원", "부서", 10),
    ])]);
    const sheets = new Set(run.items.map((item) => item.sources[0].sheet));
    expect([...sheets].sort()).toEqual(["매출", "비용", "요약", "인원"].sort());
    const windowSheets = new Map<string, number>();
    for (const handle of run.window.items) {
      const sheetName = run.window.nodes.get(handle.handle)?.source.sheet ?? "";
      windowSheets.set(sheetName, (windowSheets.get(sheetName) ?? 0) + 1);
    }
    expect(windowSheets.size).toBe(4);
    expect(Math.max(...windowSheets.values()) / run.window.items.length).toBeLessThan(0.5);
    expectCovers(deterministic(run), { conclusion: /비용 증가율이 매출 증가율보다 높/u }, "XLSX-03");
  });

  it("XLSX-04 title row and blank rows above the real header: the title is not a header and data rows keep header context", async () => {
    const run = await runAnalyze([await xlsxFile("x04", "실적 현황.xlsx", [{ name: "실적", rows: [
      ["2026년 실적 현황"], [], [],
      ["부서", "목표", "실적"], ["영업1팀", 100, 90], ["영업2팀", 200, 220],
    ] }])]);
    const texts = deterministic(run);
    expectCovers(texts, { team: /영업1팀 — 목표: 100 · 실적: 90/u }, "XLSX-04");
    expectNoNoise(texts, [/^부서 — /u, /2026년 실적 현황 —/u], "XLSX-04");
  });

  it("XLSX-05 two tables in one sheet keep their own headers", async () => {
    const run = await runAnalyze([await xlsxFile("x05", "손익.xlsx", [{ name: "손익", rows: [
      ["지역", "매출"], ["서울", 120], ["부산", 80], [],
      ["비목", "비용"], ["인건비", 40], ["임차료", 25],
    ] }])]);
    const texts = deterministic(run);
    expectCovers(texts, { revenue: /서울 — 매출: 120/u, cost: /인건비 — 비용: 40/u }, "XLSX-05");
    expectNoNoise(texts, [/인건비 — 매출/u, /비목 — /u], "XLSX-05");
  });

  it("XLSX-06 two-level merged header keeps half-year and measure together", async () => {
    const run = await runAnalyze([await xlsxFile("x06", "반기 실적.xlsx", [{ name: "반기", rows: [
      ["구분", "상반기", null, null, "하반기", null, null],
      [null, "매출", "비용", "이익", "매출", "비용", "이익"],
      ["A사업부", 100, 70, 30, 120, 80, 40],
      ["B사업부", 90, 60, 30, 95, 70, 25],
    ], merges: ["B1:D1", "E1:G1"] }])]);
    expectCovers(deterministic(run), { grouped: /A사업부 — 상반기 매출: 100 · 상반기 비용: 70 · 상반기 이익: 30/u }, "XLSX-06");
    expectNoNoise(deterministic(run), [/^매출 — /u], "XLSX-06");
  });

  it("XLSX-07 numeric-dominant sheet does not become a number dump", async () => {
    const random = seeded(7);
    const run = await runAnalyze([await xlsxFile("x07", "측정.xlsx", [
      { name: "측정", rows: [["측정1", "측정2", "측정3"], ...Array.from({ length: 40 }, () => [0, 0, 0].map(() => Math.round(random() * 1000)))] },
      { name: "메모", rows: [["항목", "내용"], ["판정", "모든 측정값은 허용 범위 이내입니다."]] },
    ])]);
    expect(run.items.filter((item) => /^\d/u.test(item.text))).toEqual([]);
    expectCovers(deterministic(run), { verdict: /허용 범위 이내/u }, "XLSX-07");
    expectCovers(windowTexts(run), { verdict: /허용 범위 이내/u }, "XLSX-07 window");
  });

  it("XLSX-08 issue log reads text and counts together", async () => {
    const run = await runAnalyze([await xlsxFile("x08", "이슈.xlsx", [{ name: "이슈", rows: [
      ["이슈", "내용", "발생건수", "상태"],
      ["배송 지연", "오후 주문이 다음 날 출고됩니다.", 12, "조치 중"],
      ["오배송", "라벨 인쇄 오류로 주소가 바뀌었습니다.", 3, "완료"],
    ] }])]);
    expectCovers(deterministic(run), {
      delay: /배송 지연 — 내용: 오후 주문이 다음 날 출고됩니다\. · 발생건수: 12 · 상태: 조치 중/u,
      wrong: /오배송 — .*발생건수: 3 · 상태: 완료/u,
    }, "XLSX-08");
  });

  it("XLSX-09 formula cells show their cached result, and confirmed totals match the displayed value", async () => {
    const run = await runAnalyze([await xlsxFile("x09", "달성률.xlsx", [
      { name: "달성", rows: [
        ["부서", "목표", "실적", "달성률"],
        ["영업1팀", 100, 90, { formula: "C2/B2", result: 0.9, numFmt: "0%" }],
        ["영업2팀", 200, 220, { formula: "C3/B3", result: 1.1, numFmt: "0%" }],
      ] },
      { name: "합계", rows: [["항목", "값"], ["실적 합계", { formula: "SUM(달성!C2:C3)", result: 310 }]] },
    ])]);
    expectCovers(deterministic(run), { formula: /영업1팀 — .*달성률: 90%/u, total: /실적 합계 310/u }, "XLSX-09");
    const total = run.metrics.find((metric) => metric.label === "실적 합계");
    expect(total?.sources[0]).toMatchObject({ sheet: "합계", cellRange: "B2" });
  });

  it("XLSX-10 month labels identify records", async () => {
    const months = Array.from({ length: 12 }, (_, index) => [`${index + 1}월`, 100 + index * 5, 60 + index]);
    const run = await runAnalyze([await xlsxFile("x10", "월별.xlsx", [{ name: "월별", rows: [["월", "매출", "비용"], ...months] }])]);
    expectCovers(deterministic(run), { month: /^1월 — 매출: 100 · 비용: 60$/u }, "XLSX-10");
    expectCovers(windowTexts(run), { december: /12월.*매출.*155/u }, "XLSX-10 window");
  });

  it("XLSX-11 six-hundred-row time series is not represented only by its first rows in AI evidence", async () => {
    const random = seeded(11);
    const rows: Cell[][] = [["날짜", "품목", "가격"]];
    for (let day = 0; day < 600; day += 1) {
      const date = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
      rows.push([date, ["경유", "휘발유", "등유"][day % 3], 1500 + Math.round(random() * 200)]);
    }
    const run = await runAnalyze([await xlsxFile("x11", "가격 추이.xlsx", [{ name: "가격", rows }])]);
    const years = windowTexts(run).map((text) => text.match(/20(2[56])-/u)?.[1]).filter(Boolean);
    expect(years).toContain("26");
    expect(run.window.items.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
  });

  it("XLSX-12 a late outlier in a 200-row column stays available as evidence without being promoted as a core fact", async () => {
    const random = seeded(12);
    const rows: Cell[][] = [["지점", "처리건수"]];
    for (let index = 1; index <= 200; index += 1) rows.push([`지점 ${index}`, index === 170 ? 500 : 90 + Math.round(random() * 20)]);
    const run = await runAnalyze([await xlsxFile("x12", "지점별.xlsx", [{ name: "지점", rows }])]);
    expect(run.items.some((item) => /지점 170/u.test(item.text))).toBe(false);
    // The model must be able to see the one value that breaks the column's pattern.
    expect(windowTexts(run).some((text) => /지점 170\b.*500/u.test(text)), windowTexts(run).join("\n")).toBe(true);
  });

  it("XLSX-13 zero is a value, blank and N/A are missing, and neither becomes zero", async () => {
    const run = await runAnalyze([await xlsxFile("x13", "결측.xlsx", [{ name: "값", rows: [
      ["항목", "값"], ["반품 건수", 0], ["미수금", null], ["재고 회전율", "N/A"], ["교육 인원", "해당 없음"], ["신규 고객", 5],
    ] }])]);
    const metrics = new Map(run.metrics.map((metric) => [metric.label, metric.value]));
    expect(metrics.get("반품 건수")).toBe("0");
    expect(metrics.get("신규 고객")).toBe("5");
    expect(metrics.has("미수금")).toBe(false);
    expect(metrics.has("재고 회전율")).toBe(false);
    expect(metrics.has("교육 인원")).toBe(false);
    expectNoNoise(deterministic(run), [/미수금.*0/u, /재고 회전율.*0/u], "XLSX-13");
  });

  it("XLSX-14 large workbook (5 sheets × 2000 rows × 15 columns) completes with bounded evidence", async () => {
    const random = seeded(14);
    const sheets = Array.from({ length: 5 }, (_, sheet) => ({
      name: `데이터${sheet + 1}`,
      rows: [
        Array.from({ length: 15 }, (_, column) => (column === 0 ? "코드" : `지표${column}`)) as Cell[],
        ...Array.from({ length: 2000 }, (_, row) =>
          Array.from({ length: 15 }, (_, column) => (column === 0 ? `R${sheet}-${row}` : Math.round(random() * 1000))) as Cell[]),
      ],
    }));
    const file = await xlsxFile("x14", "대형.xlsx", sheets);
    const started = performance.now();
    const run = await runAnalyze([file]);
    const elapsed = performance.now() - started;
    const candidates = buildEvidenceNodes(run.documents, { operation: "analyze" });
    expect(candidates.length).toBeLessThanOrEqual(MAX_EVIDENCE_CANDIDATES);
    expect(run.window.items.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
    expect(run.items.length).toBeLessThanOrEqual(7);
    expect(elapsed, `parse+analyze+evidence took ${Math.round(elapsed)}ms`).toBeLessThan(60_000);
  }, 120_000);

  it("XLSX-15 confirmed metric values keep exact display, sign, zero, unit and source cell", async () => {
    const run = await runAnalyze([await xlsxFile("x15", "수치.xlsx", [{ name: "수치", rows: [
      ["항목", "값"],
      ["처리 건수", 100],
      ["반품 건수", 0],
      ["손익", -50],
      ["불량률", { value: 0.125, numFmt: "0.0%" }],
      ["예산", { value: 1000000, numFmt: '"₩"#,##0' }],
      ["평균 단가", { value: 1234.56, numFmt: "#,##0.00" }],
    ] }])]);
    const metrics = Object.fromEntries(run.metrics.map((metric) => [metric.label, metric.value]));
    expect(metrics).toMatchObject({ "처리 건수": "100", "반품 건수": "0", 손익: "-50", 불량률: "12.5%", 예산: "₩1,000,000", "평균 단가": "1,234.56" });
    expect(run.metrics.find((metric) => metric.label === "손익")?.sources[0]).toMatchObject({ sheet: "수치", cellRange: "B4" });
  });

  it("XLSX-16 AI grounding: a claim citing the wrong row's number is rejected, the right one kept", async () => {
    const run = await runAnalyze([await xlsxFile("x16", "부서 KPI.xlsx", [{ name: "KPI", rows: [
      ["부서", "목표", "실적"], ["영업1팀", 100, 90], ["영업2팀", 200, 220],
    ] }])]);
    const { grounded, presented } = run.enrich([
      { text: "영업2팀 실적은 220으로 목표 200을 초과했습니다.", evidence: [/영업2팀 실적 · 220/u, /영업2팀 목표 · 200/u], role: "insight" },
      { text: "영업1팀 실적은 95로 목표에 미달했습니다.", evidence: [/영업1팀 실적 · 90/u], role: "insight" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(1);
    expect(presented.insights.map(claimDisplayText)).toEqual(["영업2팀 실적은 220으로 목표 200을 초과했습니다."]);
    expectGrounded(presented, run.documents);
  });
});
