import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import ExcelJS from "exceljs";
import { createAnalyzePptx, createCheckPptx, createDocx, createExtractPptx, createNarrativePptx, createPdf, createPptx, createPptxSlides, createTrainingPptx, createUnicodePdf, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "../fixtures";
import { navigateWorkspace } from "./navigation";

const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures");
const files = {
  v1: path.join(FIXTURE_DIR, "운임현황_v1.xlsx"),
  v1Copy: path.join(FIXTURE_DIR, "운임현황_v1_사본.xlsx"),
  longV1: path.join(FIXTURE_DIR, "2026년_서울권역_운송단가_최종검토본_매우긴파일명_v1.xlsx"),
  v2: path.join(FIXTURE_DIR, "운임현황_v2.xlsx"),
  pdf: path.join(FIXTURE_DIR, "계약서.pdf"),
  csv: path.join(FIXTURE_DIR, "운임.csv"),
  docx: path.join(FIXTURE_DIR, "계약.docx"),
  pptx: path.join(FIXTURE_DIR, "계획.pptx"),
  checkPptx: path.join(FIXTURE_DIR, "최종검수.pptx"),
  extractPptx: path.join(FIXTURE_DIR, "회의자료.pptx"),
  narrativePptx: path.join(FIXTURE_DIR, "서술형_안전보건협의체.pptx"),
  trainingSepPptx: path.join(FIXTURE_DIR, "WL_교육운영_9월.pptx"),
  trainingOctPptx: path.join(FIXTURE_DIR, "WL_교육운영_10월.pptx"),
  fake: path.join(FIXTURE_DIR, "위장파일.xlsx"),
  valueA: path.join(FIXTURE_DIR, "주요값_A.xlsx"),
  valueB: path.join(FIXTURE_DIR, "주요값_B.xlsx"),
  valueC: path.join(FIXTURE_DIR, "주요값_C.xlsx"),
  analyzePptx: path.join(FIXTURE_DIR, "기업요약.pptx"),
  analyzeCopy: path.join(FIXTURE_DIR, "기업요약_사본.pptx"),
  noticePptx: path.join(FIXTURE_DIR, "교육안내.pptx"),
  alignmentA: path.join(FIXTURE_DIR, "정렬기준_A.xlsx"),
  alignmentB: path.join(FIXTURE_DIR, "정렬기준_B.xlsx"),
};

test.beforeAll(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(files.v1, await createXlsx(RATE_SHEET_V1));
  await writeFile(files.v1Copy, await createXlsx(RATE_SHEET_V1));
  await writeFile(files.longV1, await createXlsx(RATE_SHEET_V1));
  await writeFile(files.v2, await createXlsx(RATE_SHEET_V2));
  await writeFile(files.pdf, await createPdf(["WorkLens contract page one", "WorkLens contract page two"]));
  await writeFile(files.csv, "지역,금액\r\n서울,145000\r\n부산,90000\r\n");
  await writeFile(files.docx, createDocx());
  await writeFile(files.pptx, createPptx());
  await writeFile(files.checkPptx, createCheckPptx());
  await writeFile(files.extractPptx, createExtractPptx());
  await writeFile(files.narrativePptx, createNarrativePptx());
  await writeFile(files.trainingSepPptx, createTrainingPptx("9월"));
  await writeFile(files.trainingOctPptx, createTrainingPptx("10월"));
  await writeFile(files.valueA, await createXlsx({ 주요값: [
    ["목표주가", "64,550원"],
    ["기준일", "2026.09.15"],
    ["담당부서", "경영지원팀"],
    ["Source", "회사 공시"],
  ] }));
  await writeFile(files.valueB, await createXlsx({ 주요값: [
    ["목표주가", "62,000원"],
    ["기준일", "2026-09-15"],
    ["담당부서", "경영지원팀"],
    ["검토상태", "완료"],
  ] }));
  await writeFile(files.valueC, await createXlsx({ 주요값: [
    ["목표주가", "64,550원"],
    ["기준일", "2026-09-15"],
  ] }));
  await writeFile(files.analyzePptx, createAnalyzePptx());
  await writeFile(files.analyzeCopy, createAnalyzePptx());
  await writeFile(files.noticePptx, createPptxSlides([
    ["교육 안내", "교육은 9월 28일 3층 대회의실에서 진행됩니다.", "참석 대상은 현장 관리자입니다.", "필기도구를 준비해 주세요."],
  ]));
  await writeFile(files.alignmentA, await createXlsx({ 정렬: [
    ["항목", "값"],
    ["일시", "2026.09.29 09:00"],
    ["장소", "2층 회의실"],
    ["담당자", "김하나"],
    ["금액", "1,680,000원"],
    ["인원", "60명"],
  ] }));
  await writeFile(files.alignmentB, await createXlsx({ 정렬: [
    ["항목", "값"],
    ["일시", "2026.09.30 14:00"],
    ["장소", "3층 대회의실"],
    ["담당자", "이도윤"],
    ["금액", "2,258,000원"],
    ["인원", "75명"],
  ] }));
  await writeFile(files.fake, "이 파일은 XLSX가 아닙니다");
});

function fileRow(page: Page, filePath: string) {
  return page.locator(".file-row").filter({ hasText: path.basename(filePath) });
}

async function sendFile(page: Page, filePath: string) {
  await page.locator('input[type="file"]').setInputFiles(filePath);
}

async function upload(page: Page, filePath: string) {
  await sendFile(page, filePath);
  await expect(fileRow(page, filePath)).toBeVisible();
}

async function mockEmptyClaims(page: Page) {
  await page.route("**/api/ai", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [] } }),
    });
  });
}

type PolishBatchRequest = { kind: "polish-batch"; items: Array<{ id: string; text: string }> };

function polishBatchResponse(items: PolishBatchRequest["items"], propose: (text: string) => { changed: boolean; revisedText: string; reasons: string[] }) {
  return { data: { kind: "polish-batch", proposals: items.map(({ id, text }) => ({ id, proposal: propose(text) })) } };
}

test("uploads XLSX files, compares them and shows source evidence", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as { items: Array<{ handle: string; text: string }> };
    const evidence = request.items[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kind: "claims",
          claims: evidence ? [{ text: evidence.text, handles: [evidence.handle], confidence: "high" }] : [],
        },
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "작업 파일" })).toBeVisible();
  await expect(page.locator(".dropzone")).toBeVisible();

  await upload(page, files.v1);
  await upload(page, files.v2);
  await expect(page.getByText("파일은 브라우저에서 처리", { exact: true })).toHaveCount(0);

  const firstRow = fileRow(page, files.v1);
  await expect(firstRow).toContainText("시트: 1");
  await expect(firstRow).toContainText("행: 5");

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await expect(page.getByText("두 파일의 추가·삭제·변경된 내용을 비교합니다.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("첫 번째로 선택한 파일이 기준 파일입니다.", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("현재 비교 방향")).toHaveCount(0);
  const swap = page.getByRole("button", { name: "기준/대상 바꾸기" });
  await expect(swap).toBeVisible();
  await expect(page.getByText("기준 운임현황_v1.xlsx", { exact: true })).toHaveCount(0);
  await expect(page.getByText("대상 운임현황_v2.xlsx", { exact: true })).toHaveCount(0);
  await swap.click();
  await expect(fileRow(page, files.v1).locator(".compare-selection-role")).toHaveText("2 · 대상 파일");
  await expect(fileRow(page, files.v2).locator(".compare-selection-role")).toHaveText("1 · 기준 파일");
  await expect(page.locator(".comparison-panel")).toHaveCount(0);
  await swap.click();
  await expect(fileRow(page, files.v1).locator(".compare-selection-role")).toHaveText("1 · 기준 파일");
  await expect(fileRow(page, files.v2).locator(".compare-selection-role")).toHaveText("2 · 대상 파일");
  await page.getByRole("button", { name: "비교 실행" }).click();

  const panel = page.locator(".comparison-panel");
  await expect(panel.getByRole("heading", { name: "버전 비교 결과", exact: true })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText("비교 완료");
  await expect(panel).not.toContainText("COMPARE RESULT");
  const fileMap = panel.locator(".comparison-file-map");
  await expect(fileMap).toContainText("기준 파일");
  await expect(fileMap).toContainText("운임현황_v1.xlsx");
  await expect(fileMap).toContainText("대상 파일");
  await expect(fileMap).toContainText("운임현황_v2.xlsx");
  await expect(panel.locator(".change-head [role='columnheader']")).toHaveText(["변경 유형", "기준 파일 값", "대상 파일 값", "변동", "근거"]);
  expect(await panel.locator(".change-head [role='columnheader']").evaluateAll((headers) =>
    headers.map((header) => getComputedStyle(header).textAlign))).toEqual(["left", "left", "left", "left", "left"]);
  const edges = await panel.evaluate((root) => {
    const rect = (element: Element) => element.getBoundingClientRect();
    const [base, target] = [...root.querySelectorAll(".comparison-file-map > div")].map(rect);
    const summary = rect(root.querySelector(".executive-summary")!);
    return [base.left - summary.left, target.right - summary.right, base.height - target.height].map(Math.round);
  });
  expect(edges).toEqual([0, 0, 0]);
  const csvDownload = page.waitForEvent("download");
  await panel.getByRole("button", { name: "CSV 다운로드" }).click();
  expect((await csvDownload).suggestedFilename()).toBe("worklens-version-compare.csv");
  const xlsxDownload = page.waitForEvent("download");
  await panel.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await xlsxDownload).suggestedFilename()).toBe("worklens-version-compare.xlsx");
  await expect(panel).not.toContainText(/Previous|Current|Difference|Change %/);
  const rows = page.getByTestId("change-row");
  await expect(rows.first()).toBeVisible();
  const seoul = rows.filter({ hasText: "145000" }).first();
  await expect(seoul).toContainText("158000");
  await expect(seoul).toContainText("+13,000");
  expect(await seoul.locator(":scope > span, :scope > div").evaluateAll((cells) =>
    cells.map((cell) => getComputedStyle(cell).textAlign))).toEqual(["left", "right", "right", "right", "left"]);
  await expect(seoul).toContainText("+8.97%");
  await expect(page.locator('[data-category="Important Change"]').first()).toBeVisible();
  await expect(page.locator('[data-category="Added"]').first()).toBeVisible();
  await expect(page.locator('[data-category="Removed"]').first()).toBeVisible();
  const jeju = rows.filter({ hasText: "5000" }).first();
  await expect(jeju).toBeVisible();

  await expect(panel.getByRole("heading", { name: "주요 변화", exact: true })).toBeVisible();
  await expect(panel.locator(".comparison-semantic-section .analysis-reading-row")).toHaveCount(1);
  await expect(page.locator(".enrichment-results")).toHaveCount(0);
  await expect(page.getByText(/비교 추가 결과|근거 연결 결과|semantic-check/)).toHaveCount(0);
  await seoul.locator(".source-action").first().click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail).toContainText("운송단가 · B2");
  await detail.getByRole("button", { name: "닫기" }).click();
  await swap.click();
  await expect(panel).toHaveCount(0);
  await expect(fileRow(page, files.v1).locator(".compare-selection-role")).toHaveText("2 · 대상 파일");
  await expect(fileRow(page, files.v2).locator(".compare-selection-role")).toHaveText("1 · 기준 파일");
  await page.getByRole("button", { name: "비교 실행" }).click();
  const reversedMap = page.locator(".comparison-file-map");
  await expect(reversedMap.locator("> div").nth(0)).toContainText("운임현황_v2.xlsx");
  await expect(reversedMap.locator("> div").nth(1)).toContainText("운임현황_v1.xlsx");
  await page.screenshot({ path: "artifacts/compare-evidence.png", fullPage: true });
});

test("shows the swap action only for exactly two version files", async ({ page }) => {
  await page.goto("/");
  await navigateWorkspace(page, "비교");
  await expect(page.getByLabel("현재 비교 방향")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "기준/대상 바꾸기" })).toHaveCount(0);

  await upload(page, files.longV1);
  await page.getByRole("checkbox", { name: `${path.basename(files.longV1)} 선택`, exact: true }).check();
  await expect(page.getByRole("button", { name: "기준/대상 바꾸기" })).toHaveCount(0);

  await upload(page, files.v2);
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  const swap = page.getByRole("button", { name: "기준/대상 바꾸기" });
  await expect(swap).toBeVisible();
  await expect(page.getByLabel("현재 비교 방향")).toHaveCount(0);

  await page.getByRole("radio", { name: "값 일치 확인" }).check();
  await expect(swap).toHaveCount(0);
  await expect(page.getByText("여러 파일의 동일 항목과 값 차이를 확인합니다.", { exact: true })).toHaveCount(0);

  await page.getByRole("radio", { name: "버전 비교" }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "기준/대상 바꾸기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "기준/대상 변경" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("usage guide switches feature flows on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await navigateWorkspace(page, "Guide");
  await expect(page.getByRole("button", { name: "Guide" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "분석", exact: true })).toHaveAttribute("aria-selected", "true");
  const tabs = page.getByRole("tablist", { name: "기능 선택" });
  const desktopTabs = await tabs.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const guide = element.parentElement!.getBoundingClientRect();
    const lastTab = [...element.querySelectorAll('[role="tab"]')].at(-1)!;
    return { left: bounds.left, guideLeft: guide.left, width: bounds.width, guideWidth: guide.width, trailing: bounds.right - lastTab.getBoundingClientRect().right };
  });
  expect(Math.abs(desktopTabs.left - desktopTabs.guideLeft)).toBeLessThan(1);
  expect(desktopTabs.width).toBeLessThan(desktopTabs.guideWidth);
  expect(desktopTabs.trailing).toBeLessThan(12);
  const panel = page.getByRole("tabpanel");
  await page.getByRole("tab", { name: "비교", exact: true }).click();
  await expect(panel.locator(".usage-guide-step > strong")).toHaveText(["파일 선택", "기준/대상 확인", "실행", "결과 확인"]);
  await page.getByRole("tab", { name: "비교", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "검수", exact: true })).toBeFocused();
  await expect(page.getByRole("tab", { name: "검수", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".usage-guide-step")).toHaveCount(3);
  await page.getByRole("tab", { name: "법령", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTabs = await tabs.evaluate((element) => ({ width: element.getBoundingClientRect().width, guideWidth: element.parentElement!.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(mobileTabs.width).toBeLessThanOrEqual(mobileTabs.guideWidth + 1);
  expect(mobileTabs.scrollWidth).toBeGreaterThan(mobileTabs.clientWidth);
  await page.getByRole("tab", { name: "용어 사전", exact: true }).click();
  await expect(page.getByRole("tab", { name: "용어 사전", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps multi-file Analyze confirmed metrics separated when the model abstains", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.valueA);
  await upload(page, files.valueB);
  await page.getByRole("checkbox", { name: "주요값_A.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "주요값_B.xlsx 선택", exact: true }).check();

  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();

  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "분석 결과", exact: true })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.locator(".result-status")).toHaveClass(/success/);
  await expect(panel).not.toContainText("ANALYZE RESULT");
  await expect(panel).not.toContainText(/서술형 문단 중심|표 중심의 문서|혼합형 문서|주요 수치/);
  await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "확인된 수치", exact: true })).toBeVisible();
  await expect(panel.locator(".analysis-metric-table thead th")).toHaveText(["파일", "항목", "값", "근거"]);
  const metrics = panel.locator(".analysis-metric-table tbody tr");
  await expect(metrics).toHaveCount(2);
  await expect(metrics.nth(0)).toContainText("주요값_A.xlsx");
  await expect(metrics.nth(0)).toContainText("목표주가");
  await expect(metrics.nth(0)).toContainText("64,550원");
  await expect(metrics.nth(1)).toContainText("주요값_B.xlsx");
  await expect(metrics.nth(1)).toContainText("62,000원");
  await expect(panel).not.toContainText("2026.09.15");

});

test("keeps deterministic Analyze output stable across grounding rejection and enrichment success", async ({ page }) => {
  let analyzeCalls = 0;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    expect(request.request.operation).toBe("analyze");
    analyzeCalls += 1;
    if (analyzeCalls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { kind: "claims", claims: [{ text: "근거 없는 분석", handles: ["E999"], confidence: "high", presentation: { role: "summary" } }] },
        }),
      });
      return;
    }
    const evidence = request.items.find((item) => item.text.includes("함께 검토해야 합니다")) ?? request.items[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kind: "claims",
          claims: [{
            text: evidence.text,
            handles: [evidence.handle],
            confidence: "high",
            presentation: { role: "summary" },
          }],
        },
      }),
    });
  });

  await page.goto("/");
  await upload(page, files.extractPptx);
  await page.getByRole("checkbox", { name: "회의자료.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "분석");
  const run = page.getByRole("button", { name: "분석 실행" });

  await run.click();
  const panel = page.locator(".results-panel");
  await expect(panel.locator(".result-status")).toHaveText("기본 분석 완료");
  await expect(panel.locator(".result-status")).toHaveClass(/warning/);
  await expect(panel.locator(".result-inline-warning")).toContainText("기본 분석은 완료됐습니다. 요약과 인사이트를 불러오지 못했습니다.");
  await expect(panel).not.toContainText(/서술형 문단 중심|표 중심의 문서|혼합형 문서|주요 수치/);
  await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);
  const topics = panel.locator(".analysis-core-items-section .analysis-reading-row");
  await expect(panel.getByRole("heading", { name: "주요 내용", exact: true })).toBeVisible();
  await expect(topics.first()).toBeVisible();
  const baseText = await topics.allInnerTexts();
  const metricRows = panel.locator(".analysis-metric-table tbody tr");
  const firstMetrics = await metricRows.allInnerTexts();
  await expect(panel).not.toContainText("2025.05.02");
  await expect(panel).not.toContainText("회사 공시");

  await run.click();
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.locator(".result-inline-warning")).toHaveCount(0);
  await expect(panel.locator(".analysis-summary-section .analysis-reading-row")).toHaveCount(1);
  expect((await topics.allInnerTexts()).length).toBeLessThanOrEqual(baseText.length);
  expect(await metricRows.allInnerTexts()).toEqual(firstMetrics);
  await expect(panel.locator(".analysis-summary-section")).not.toContainText("목표주가 64,550원");
  expect(analyzeCalls).toBe(2);

  const targetMetric = metricRows.filter({ hasText: "목표주가" }).first();
  await targetMetric.locator(".source-action").click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail).toContainText("Slide 3");
  await detail.getByRole("button", { name: "닫기" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(targetMetric.locator("[data-label='항목']")).toBeVisible();
  expect(await targetMetric.evaluate((element) => getComputedStyle(element).display)).toBe("block");
});

test("surfaces FSC Analyze failure and then grounded relational insights with aligned sources", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    const items = request.items;
    expect(items.length).toBeLessThanOrEqual(40);
    expect(items.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(10_000);
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThanOrEqual(64 * 1024);
    expect(request.request.operation).toBe("analyze");
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_RATE_LIMITED" } }) });
      return;
    }
    const handleFor = (pattern: RegExp) => {
      const handle = request.items.find((item) => pattern.test(item.text))?.handle;
      if (!handle) throw new Error("FSC relation missing from provider evidence");
      return handle;
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [
        { text: "주간 Forecast는 최근 8개 주간 평균 유가로 산정합니다", handles: [handleFor(/8\s*개 주간 평균 유가/u)], confidence: "high", presentation: { role: "summary" } },
        { text: "새로운 Actual이 반영되면 향후 Forecast를 다시 계산합니다", handles: [handleFor(/재계산/u), handleFor(/Actual/u)], confidence: "high", presentation: { role: "insight" } },
        { text: "주간 Forecast가 없으면 월간 Forecast 대체값을 사용합니다", handles: [handleFor(/대체값/u)], confidence: "high", presentation: { role: "insight" } },
        { text: "두바이유와 환율은 Forecast에 보조적으로 반영됩니다", handles: [handleFor(/보조적으로/u)], confidence: "high", presentation: { role: "insight" } },
      ] } }),
    });
  });

  const pdf = path.join(process.cwd(), "tests/data/fsc-forecast-guide.pdf");
  await page.goto("/");
  await upload(page, pdf);
  await fileRow(page, pdf).getByRole("checkbox").check();
  await navigateWorkspace(page, "분석");
  const run = page.getByRole("button", { name: "분석 실행" });
  const panel = page.locator(".results-panel");
  await run.click();
  await expect(panel.locator(".result-status")).toHaveText("기본 분석 완료");
  await expect(panel.locator(".result-inline-warning")).toContainText("기본 분석은 완료됐습니다. 요약과 인사이트를 불러오지 못했습니다.");
  await expect(panel.locator(".result-inline-warning")).toHaveCount(1);
  await expect(panel.locator(".notice.warning")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "주요 내용" })).toBeVisible();
  await expect(panel.locator(".analysis-core-items-section .analysis-reading-row").first()).toBeVisible();
  await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);

  await run.click();
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.locator(".analysis-summary-section .analysis-reading-row").first()).toBeVisible();
  await expect(panel.locator(".analysis-insight-section .analysis-reading-row").first()).toBeVisible();
  const sectionHeadings = await panel.locator(".analysis-report-section h3").allTextContents();
  expect(sectionHeadings.indexOf("핵심 요약")).toBeLessThan(sectionHeadings.indexOf("주요 내용"));
  expect(sectionHeadings.indexOf("주요 내용")).toBeLessThan(sectionHeadings.indexOf("분석 인사이트"));
  const aligned = await panel.evaluate((root) => {
    const left = (selector: string) => root.querySelector(selector)!.getBoundingClientRect().left;
    const right = (selector: string) => root.querySelector(selector)!.getBoundingClientRect().right;
    return {
      leftDrift: Math.abs(left(".result-heading h2") - left(".analysis-summary-section h3")),
      topicDrift: Math.abs(left(".analysis-summary-section h3") - left(".analysis-core-items-section h3")),
      countDrift: Math.abs(right(".result-status") - right(".analysis-summary-section .subsection-heading span")),
      sourceDrift: Math.abs(right(".analysis-summary-section .source-action") - right(".analysis-core-items-section .source-action")),
    };
  });
  expect(Object.values(aligned).every((drift) => drift <= 1)).toBe(true);
  await panel.locator(".analysis-summary-section .source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toBeVisible();
  await page.getByLabel("근거 상세").getByRole("button", { name: "닫기" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(panel.locator(".analysis-insight-section .source-action").first()).toBeVisible();
  expect(calls).toBe(2);
});

test("keeps sourced narrative body facts when Analyze AI is unavailable", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "AI_PROVIDER_UNAVAILABLE" },
        requestId: "req-narrative-failure",
      }),
    });
  });
  await page.goto("/");
  await upload(page, files.narrativePptx);
  await page.getByRole("checkbox", { name: "서술형_안전보건협의체.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();

  const panel = page.locator(".results-panel");
  await expect(panel.locator(".result-status")).toHaveText("기본 분석 완료");
  await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "주요 내용", exact: true })).toBeVisible();
  const topics = panel.locator(".analysis-core-items-section .analysis-reading-row");
  await expect(topics.first()).toBeVisible();
  await topics.first().locator(".source-action").click();
  await expect(page.getByRole("complementary", { name: "근거 상세" })).toBeVisible();
  await page.getByRole("complementary", { name: "근거 상세" }).getByRole("button", { name: "닫기" }).click();
  await expect(panel.locator(".result-inline-warning")).toContainText("기본 분석은 완료됐습니다. 요약과 인사이트를 불러오지 못했습니다.");
  await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);

});


test("checks shared values locally, keeps evidence, and exports both formats", async ({ page }) => {
  let aiRequests = 0;
  await page.route("**/api/ai", async (route) => {
    aiRequests += 1;
    await route.abort();
  });
  await page.goto("/");
  await upload(page, files.valueA);
  await upload(page, files.valueB);
  await page.getByRole("checkbox", { name: "주요값_A.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "주요값_B.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("radio", { name: "값 일치 확인" }).check();
  await page.getByRole("button", { name: "비교 실행" }).click();

  const panel = page.locator(".value-check-panel");
  await expect(panel.getByRole("heading", { name: "값 일치 확인 결과" })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText("확인 완료");
  await expect(panel.locator(".value-check-filters")).toContainText("전체 3");
  await expect(panel.locator(".value-check-filters")).toContainText("값 차이 1");
  await expect(panel.locator(".value-check-filters")).toContainText("일치 2");
  await expect(panel.locator(".check-summary-line")).toHaveCount(0);
  // The count summary starts on the same left edge as the result table below it.
  const leftEdge = async (selector: string) => (await panel.locator(selector).first().boundingBox())!.x;
  expect(Math.abs(await leftEdge(".value-check-filters") - await leftEdge(".value-check-matrix"))).toBeLessThan(1);
  const different = panel.getByTestId("value-check-group").filter({ hasText: "목표주가" });
  await expect(different).toContainText("64,550원");
  await expect(different).toContainText("62,000원");
  await expect(different.locator(".value-check-cell-entry")).toHaveCount(2);
  await different.locator(".source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toContainText("주요값");
  await page.getByLabel("근거 상세").getByRole("button", { name: "닫기" }).click();

  for (const [label, suffix] of [["CSV 다운로드", ".csv"], ["XLSX 다운로드", ".xlsx"]] as const) {
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: label }).click();
    expect((await download).suggestedFilename()).toBe(`worklens-value-check${suffix}`);
  }
  expect(aiRequests).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await different.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(Math.abs(await leftEdge(".value-check-filters") - await leftEdge(".value-check-matrix"))).toBeLessThan(1);
});

test("scales value checks from two-file columns to compact multi-file rows", async ({ page }) => {
  let aiRequests = 0;
  await page.route("**/api/ai", async (route) => {
    aiRequests += 1;
    await route.abort();
  });
  await page.goto("/");
  for (const file of [files.valueA, files.valueB, files.valueC]) {
    await upload(page, file);
    await page.getByRole("checkbox", { name: `${path.basename(file)} 선택`, exact: true }).check();
  }
  await navigateWorkspace(page, "비교");
  await page.getByRole("radio", { name: "값 일치 확인" }).check();
  await expect(page.getByRole("radio", { name: "값 일치 확인" })).toBeChecked();
  await page.getByRole("button", { name: "비교 실행" }).click();

  const panel = page.locator(".value-check-panel");
  await expect(panel.locator(".value-check-matrix")).toHaveCount(0);
  await expect(panel.locator(".value-check-list")).toBeVisible();
  await expect(panel.getByTestId("value-check-group").filter({ hasText: "목표주가" })).toContainText("값 차이");
  await expect(panel.getByTestId("value-check-group").filter({ hasText: "기준일" })).toContainText("일치");
  const partial = panel.getByTestId("value-check-group").filter({ hasText: "담당부서" });
  await expect(partial).toContainText("일부 파일만 확인");
  await expect(partial).toContainText("주요값_C.xlsx");
  await expect(partial.locator(".value-check-occurrence")).toHaveCount(2);
  expect(Math.abs((await panel.locator(".value-check-filters").boundingBox())!.x - (await panel.locator(".value-check-list").boundingBox())!.x)).toBeLessThan(1);
  expect(aiRequests).toBe(0);
});

test("distinguishes same-named uploaded revisions in the evidence inspector", async ({ page }) => {
  await page.goto("/");
  const first = await createXlsx(RATE_SHEET_V1);
  const second = await createXlsx(RATE_SHEET_V2);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: "동일이름.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(first) });
  await expect(page.locator(".file-row").filter({ hasText: "동일이름.xlsx" })).toHaveCount(1);
  await input.setInputFiles({ name: "동일이름.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(second) });
  await expect(page.locator(".file-row").filter({ hasText: "동일이름.xlsx" })).toHaveCount(2);

  const sameRows = page.locator(".file-row").filter({ hasText: "동일이름.xlsx" });
  await sameRows.nth(0).getByRole("checkbox").check();
  await sameRows.nth(1).getByRole("checkbox").check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("button", { name: "비교 실행" }).click();
  const row = page.getByTestId("change-row").first();
  await expect(row).toBeVisible();

  // The row stays locator-first and summarises both revisions. Explicit file
  // roles distinguish identical names while upload order remains the direction.
  const summary = await row.locator(".source-locator").innerText();
  expect(summary).toContain("기준 파일");
  expect(summary).toContain("외 1곳");

  await row.locator(".source-action").click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail).toBeVisible();
  const headings = await detail.locator(".evidence-entry h3").allInnerTexts();
  const locations = await detail.locator(".evidence-location-list li").allInnerTexts();
  expect(locations.some((location) => location.includes("기준 파일"))).toBe(true);
  expect(locations.some((location) => location.includes("대상 파일"))).toBe(true);
  expect(headings.some((heading) => heading.includes("동일이름.xlsx (2)"))).toBe(true);
  expect([...headings, ...locations].every((text) => !/[a-f0-9]{8}/.test(text))).toBe(true);
  expect(new Set(headings).size).toBeGreaterThanOrEqual(2);
});

test("uploads and normalizes all five formats", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.csv);
  await upload(page, files.pdf);
  await upload(page, files.docx);
  await upload(page, files.pptx);
  await upload(page, files.v1);
  await expect(fileRow(page, files.csv)).toContainText("csv");
  await expect(fileRow(page, files.pdf)).toContainText("페이지/슬라이드: 2");
  await expect(fileRow(page, files.docx)).toContainText("docx");
  await expect(fileRow(page, files.pptx)).toContainText("페이지/슬라이드: 1");
  await expect(fileRow(page, files.v1)).toContainText("시트: 1");

});

test("selects, clears, and reports all work files from the table header", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  const selectAll = page.getByRole("checkbox", { name: "전체 선택" });

  await selectAll.check();
  await expect(page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true })).toBeChecked();
  await expect(page.locator(".context-counts")).toContainText("선택 2개");

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).uncheck();
  await expect(selectAll).toHaveAttribute("aria-checked", "mixed");
  await expect(page.locator(".context-counts")).toContainText("선택 1개");

  await page.getByRole("checkbox", { name: "전체 선택" }).check();
  await page.getByRole("checkbox", { name: "전체 선택 해제" }).uncheck();
  await expect(page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true })).not.toBeChecked();
  await expect(page.locator(".context-counts")).toContainText("선택 0개");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("checkbox", { name: "전체 선택" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("deletes every selected file in one secondary action", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  const remove = page.getByRole("button", { name: "선택 삭제" });
  await expect(remove).toBeDisabled();
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(fileRow(page, files.v1)).toHaveCount(0);
  await expect(fileRow(page, files.v2)).toBeVisible();
  await expect(page.locator(".context-counts")).toContainText("1개");
  await expect(page.locator(".context-counts")).toContainText("선택 0개");
  await expect(remove).toBeDisabled();
});


test("runs deterministic Analyze, Check, Extract and export paths", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();

  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("분석 완료");
  await expect(page.locator(".results-panel").getByRole("heading", { name: "분석 결과" })).toBeVisible();
  await expect(page.locator(".results-panel")).not.toContainText("기본 분석 세부 정보");
  await expect(page.locator(".results-panel .source-action").first()).toBeVisible();
  await page.locator(".results-panel .source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toBeVisible();
  await page.getByLabel("닫기").click();

  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toContainText("검수 완료");

  await navigateWorkspace(page, "추출");
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("추출 완료");
  const structuredDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드" }).click();
  expect((await structuredDownload).suggestedFilename()).toContain(".csv");


});

test("extracts fields and records without a model and exports the structured table", async ({ page }) => {
  let aiRequests = 0;
  await page.route("**/api/ai", async (route) => {
    aiRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { kind: "extract", proposal: { field: "", value: null, handles: [], confidence: "low" } },
      }),
    });
  });
  await page.goto("/");
  await upload(page, files.extractPptx);
  await page.getByRole("checkbox", { name: "회의자료.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "추출");

  // Automatic mode: labelled pairs become FIELD/VALUE rows with a locator.
  await page.getByRole("button", { name: "추출 실행" }).click();
  const summary = page.locator(".check-summary-line");
  await expect(summary).toContainText("추출 항목");
  await expect(summary).not.toContainText("목록");
  await expect(summary).not.toContainText("반복 표");
  const autoTable = page.locator(".extract-auto-table");
  await expect(autoTable).toBeVisible();
  await expect(autoTable.locator(".data-row").first().locator(".source-action")).toBeVisible();
  // The source trigger reads as a bordered secondary action, not a filled primary one.
  const sourceTriggerStyle = await autoTable.locator(".source-action").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderStyle: style.borderStyle, background: style.backgroundColor };
  });
  expect(sourceTriggerStyle.borderStyle).toBe("solid");
  expect(sourceTriggerStyle.background).toBe("rgb(255, 255, 255)");
  // Values and field labels keep the document's own wording.
  for (const text of ["경영지원팀", "목표주가", "64,550원", "상승여력", "232.4%", "시가총액", "2,258억 원", "기준일", "2025.05.02", "단위", "백만 원"]) {
    await expect(autoTable).toContainText(text);
  }
  await expect(page.locator(".extract-results")).not.toContainText("참고 출처");
  expect(aiRequests).toBe(0);
  // Field mode: a value explicitly present in the document needs no model.
  await page.getByRole("radio", { name: "항목 지정" }).check();
  const field = page.getByLabel("추출할 항목");
  await field.fill("작성부서");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await field.fill("Source");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  const table = page.locator(".results-panel .extract-fields-table");
  await expect(table.locator('[role="columnheader"]').nth(0)).toHaveText("항목");
  await expect(table).toContainText("경영지원팀");
  await expect(table).toContainText("회사 공시");
  await expect(table).toContainText("거래소 데이터");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await download).suggestedFilename()).toContain(".xlsx");
  expect(aiRequests).toBe(0);
});

test("keeps multi-file training records folded below automatic fields", async ({ page }) => {
  let aiRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/ai") aiRequests += 1;
  });
  await page.goto("/");
  await upload(page, files.trainingSepPptx);
  await upload(page, files.trainingOctPptx);
  await page.getByRole("checkbox", { name: "WL_교육운영_9월.pptx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "WL_교육운영_10월.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "추출");
  await page.getByRole("button", { name: "추출 실행" }).click();

  const results = page.locator(".extract-results");
  const autoTable = results.locator(".extract-auto-table");
  await expect(autoTable).toContainText("전 직원 75명");
  await expect(autoTable.locator(".data-row").filter({ hasText: "전 직원 75명" }).locator("small")).toHaveCount(0);
  await expect(autoTable.locator(".data-row").filter({ hasText: "출석률 95% 미만" }).locator("small")).toHaveCount(0);
  await expect(autoTable.locator(".data-row").filter({ hasText: "2,258,000원" }).locator("small")).toHaveText("금액");

  const toggle = results.getByRole("button", { name: "세부 표 2개", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(results.locator(".extract-table")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(results.locator(".extract-table")).toHaveCount(2);
  await expect(results.locator(".subsection-heading h4")).toHaveText([
    "WL_교육운영_9월.pptx · 교육 세부 일정",
    "WL_교육운영_10월.pptx · 교육 세부 일정",
  ]);
  await expect(results.locator(".subsection-heading .source-locator")).toHaveText(["Slide 2", "Slide 2"]);
  await expect(results.locator(".extract-table").first().locator("th")).toHaveText(["시간", "주제", "담당자", "산출물"]);
  expect(aiRequests).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("makes missing and low-confidence Extract values explicit", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: string;
      field?: string;
      items: Array<{ handle: string; text: string }>;
    };
    const evidence = request.items.find((item) => item.text.includes("경영지원팀"));
    const proposal = request.field === "검토부서" && evidence
      ? { field: request.field, value: "경영지원팀", handles: [evidence.handle], confidence: "low" }
      : { field: request.field ?? "", value: null, handles: [], confidence: "low" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "extract", proposal } }),
    });
  });

  await page.goto("/");
  await upload(page, files.extractPptx);
  await page.getByRole("checkbox", { name: "회의자료.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "추출");
  await page.getByRole("radio", { name: "항목 지정" }).check();
  const field = page.getByLabel("추출할 항목");
  await field.fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  const panel = page.locator(".extract-results");
  await expect(panel.getByText("'존재하지 않는 항목'을(를) 찾지 못했습니다.")).toBeVisible();
  await expect(panel.getByText("선택한 문서에서 해당 항목이나 값을 확인할 수 없습니다.")).toBeVisible();
  await expect(panel.locator(".check-summary-line")).toContainText("찾지 못함 1");
  await expect(panel.locator(".check-summary-line")).not.toContainText("확인 필요");

  await field.fill("검토부서");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();

  await expect(panel.locator(".check-summary-line")).toContainText("찾지 못함 1");
  await expect(panel.locator(".check-summary-line")).toContainText("확인 필요 1");
  await expect(panel.locator(".check-summary-line")).not.toContainText("낮은 확신");
  await expect(panel.getByRole("button", { name: "표 보기" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "항목 보기" })).toHaveCount(0);
  const table = panel.locator(".extract-fields-table");
  await expect(table).toBeVisible();
  await expect(table.locator(".data-row")).toHaveCount(2);
  await expect(table).toContainText("경영지원팀");
  await expect(table).toContainText("확신 낮음");
  await expect(table).toContainText("문서에서 찾지 못함");

  const exports = panel.locator(".extract-export-actions");
  const csv = exports.getByRole("button", { name: "CSV 다운로드" });
  const xlsx = exports.getByRole("button", { name: "XLSX 다운로드" });
  await expect(exports.getByRole("button")).toHaveText(["CSV 다운로드", "XLSX 다운로드"]);
  const [summaryBox, csvBox, xlsxBox, tableBox] = await Promise.all([
    panel.locator(".check-summary-line").boundingBox(),
    csv.boundingBox(),
    xlsx.boundingBox(),
    table.boundingBox(),
  ]);
  expect(summaryBox).not.toBeNull();
  expect(csvBox).not.toBeNull();
  expect(xlsxBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  expect(csvBox!.y).toBeLessThan(tableBox!.y);
  expect(xlsxBox!.x).toBeGreaterThan(csvBox!.x);
  const fileBox = await page.locator(".file-list").boundingBox();
  expect(fileBox).not.toBeNull();
  expect(summaryBox!.x).toBe(fileBox!.x);
  expect(xlsxBox!.x + xlsxBox!.width).toBe(fileBox!.x + fileBox!.width);
  expect(tableBox!.x).toBe(fileBox!.x);
  expect(tableBox!.width).toBe(fileBox!.width);
  const hierarchy = await exports.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, color: style.color, border: style.borderStyle };
  }));
  // CSV stays a quiet outline action; XLSX is the one filled primary action.
  expect(hierarchy[0].background).toBe("rgb(255, 255, 255)");
  expect(hierarchy[1].background).not.toBe(hierarchy[0].background);
  expect(hierarchy[1].color).toBe("rgb(255, 255, 255)");
  expect(hierarchy[0].border).not.toBe("none");
  expect(hierarchy[1].border).not.toBe("none");
  await page.screenshot({ path: "artifacts/inspo-extract-desktop-1440.png", fullPage: true });
  if (testInfo.project.name === "chromium-desktop") expect(consoleErrors).toEqual([]);
});


test("offers file and pasted-text polish without touching the workspace", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "윤문");

  // File polish is the default and keeps the workspace list in view.
  await expect(page.getByRole("radio", { name: "파일 윤문" })).toBeChecked();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await expect(page.getByLabel("윤문할 텍스트 입력")).toHaveCount(0);

  // Pasted text replaces the file picker with the paste area.
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const paste = page.getByLabel("윤문할 텍스트 입력");
  await expect(paste).toBeVisible();
  await expect(page.locator(".file-row")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "간결하게" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "업무 문체" })).toBeVisible();

  // The action follows the textarea, not the file selection.
  await expect(page.getByRole("button", { name: "윤문 실행" })).toBeDisabled();
  await paste.fill("안녕하세요.\n- 3분기 운영 보고 관련하여 검토 부탁드리고자 합니다.\n1. 매출은 1,250만원입니다.");
  await expect(page.locator(".polish-paste small")).toContainText("/ 10,000자");
  await expect(page.getByRole("button", { name: "윤문 실행" })).toBeEnabled();
  await expect(page.locator(".source-locator")).toHaveCount(0);
  const prose = "운영 개선 방안을 함께 검토 부탁드립니다. ".repeat(500);
  for (const length of [9_999, 10_000]) {
    await paste.fill(prose.slice(0, length));
    await expect(page.locator(".polish-paste small")).toContainText(`${length.toLocaleString("ko-KR")} / 10,000자`);
    await expect(page.locator(".polish-paste small")).not.toHaveAttribute("data-over", "true");
  }
  await paste.fill(prose.slice(0, 10_001));
  await expect(page.locator(".polish-paste small")).toHaveAttribute("data-over", "true");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".status-panel.error")).toContainText("10,000자 이하");
  await paste.fill("안녕하세요.\n- 3분기 운영 보고 관련하여 검토 부탁드리고자 합니다.\n1. 매출은 1,250만원입니다.");

  // Switching back restores the workspace file and its selection.
  await page.getByRole("radio", { name: "파일 윤문" }).check();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await expect(page.getByLabel("윤문할 텍스트 입력")).toHaveValue(/3분기 운영 보고/);

  // Nothing about the pasted text is persisted.
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: Object.keys(sessionStorage).length,
  }));
  expect(stored.local).not.toContain("3분기 운영 보고");
  expect(stored.session).toBe(0);
  await page.reload();
  await navigateWorkspace(page, "윤문");
  await expect(page.getByRole("radio", { name: "파일 윤문" })).toBeChecked();
});

test("presents text Polish as an immediate original-to-revision workflow", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = text;
        },
      },
    });
  });
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(polishBatchResponse(request.items, (text) => text.includes("pc반환")
        ? { changed: true, revisedText: "김영삼 차장님이 PC 반납을 요청했습니다.", reasons: ["오타 수정", "표현 정리"] }
        : text.includes("1,250")
          ? { changed: true, revisedText: "이번 매출은 1,500만원으로 집계되었습니다.", reasons: ["수치 표현 정리"] }
          : { changed: false, revisedText: text, reasons: [] })),
    });
  });

  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByRole("radio", { name: "업무 문체" }).check();
  const paste = page.getByLabel("윤문할 텍스트 입력");
  await paste.fill("김영삼 차장님이 pc반환 요청했습니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();

  const result = page.locator(".polish-text-results");
  await expect(result.getByRole("heading", { name: "윤문 결과", exact: true })).toBeVisible();
  await expect(result.getByText("POLISH RESULT", { exact: true })).toHaveCount(0);
  await expect(result.getByRole("heading", { name: "텍스트 윤문", exact: true })).toHaveCount(0);
  await expect(result.locator(".result-heading-meta")).toContainText("업무 문체");
  await expect(result.locator(".result-heading-meta")).toContainText("윤문 완료");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 1");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 0");
  await expect(result).not.toContainText("보호 검증 차단");
  await expect(result.locator(".polish-protection-metric")).toHaveCount(0);
  await expect(result.locator(".polish-label")).toHaveText(["원문", "수정안", "변경 이유"]);

  const original = result.locator(".polish-copy-block").filter({ hasText: "원문" });
  const revision = result.locator(".polish-copy-block").filter({ hasText: "수정안" });

  const [inputBox, resultBox, weights, revisionBorder] = await Promise.all([
    paste.boundingBox(),
    result.boundingBox(),
    Promise.all([
      original.evaluate((block) => getComputedStyle(block.querySelector("p")!).fontWeight),
      revision.evaluate((block) => getComputedStyle(block.querySelector("p")!).fontWeight),
    ]),
    revision.evaluate((block) => {
      const style = getComputedStyle(block);
      return { top: style.borderTopWidth, left: style.borderLeftWidth };
    }),
  ]);
  const boundaryBox = await page.locator(".work-section-heading").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(resultBox).not.toBeNull();
  expect(boundaryBox).not.toBeNull();
  expect(Math.abs(resultBox!.width - boundaryBox!.width)).toBeLessThanOrEqual(1);
  expect(weights[1]).toBe(weights[0]);
  expect(revisionBorder.left).toBe(revisionBorder.top);
  expect(await original.locator(".polish-copy-heading").evaluate((element) => getComputedStyle(element).justifyContent)).toBe("space-between");
  const copyActions = result.locator(".polish-copy-heading > button");
  const cardHierarchy = async () => result.evaluate((element) => {
    const cards = [...element.querySelectorAll<HTMLElement>(".polish-copy-block")];
    return cards.map((card) => {
      const button = card.querySelector("button")!;
      const cardBox = card.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        background: getComputedStyle(card).backgroundColor,
        label: button.innerText,
        icon: Boolean(button.querySelector("svg")),
        right: Math.round(cardBox.right - buttonBox.right),
        top: Math.round(buttonBox.top - cardBox.top),
        height: buttonBox.height,
        font: style.fontSize,
        color: style.color,
        gap: style.gap,
      };
    });
  });
  const desktopCards = await cardHierarchy();
  expect(desktopCards.map((card) => card.label)).toEqual(["원문 복사", "복사"]);
  expect(desktopCards.map((card) => card.icon)).toEqual([true, true]);
  expect(desktopCards[0].background).not.toBe(desktopCards[1].background);
  expect(desktopCards[0].right).toBe(desktopCards[1].right);
  expect(desktopCards[0].top).toBe(desktopCards[1].top);
  for (const property of ["height", "font", "color", "gap"] as const) {
    expect(desktopCards[0][property]).toBe(desktopCards[1][property]);
  }
  await copyActions.first().hover();
  const originalHover = await copyActions.first().evaluate((button) => getComputedStyle(button).backgroundColor);
  await copyActions.last().hover();
  expect(await copyActions.last().evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(originalHover);
  await copyActions.first().focus();
  const focusWidth = await copyActions.first().evaluate((button) => getComputedStyle(button).outlineWidth);
  expect(Number.parseInt(focusWidth, 10)).toBeGreaterThan(0);
  await copyActions.last().focus();
  expect(await copyActions.last().evaluate((button) => getComputedStyle(button).outlineWidth)).toBe(focusWidth);
  await page.screenshot({ path: "artifacts/polish-result-desktop-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(result).toBeVisible();
  expect(await revision.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(await result.locator(".polish-row").evaluate((element) => {
      const style = getComputedStyle(element);
      return Math.round(element.getBoundingClientRect().width
        - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
        - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth));
    }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const mobileCards = await cardHierarchy();
  expect(mobileCards[0].right).toBe(mobileCards[1].right);
  expect(mobileCards[0].top).toBe(mobileCards[1].top);
  expect(mobileCards.map((card) => card.icon)).toEqual([true, true]);
  await page.screenshot({ path: "artifacts/polish-result-mobile-390.png", fullPage: true });
  await original.getByRole("button", { name: "원문 복사" }).click();
  expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText))
    .toBe("김영삼 차장님이 pc반환 요청했습니다.");
  await revision.getByRole("button", { name: "복사", exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText))
    .toBe("김영삼 차장님이 PC 반납을 요청했습니다.");

  await paste.fill("현재 문장은 자연스럽습니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(result.getByText("현재 문장은 별도 수정 없이 사용할 수 있습니다.", { exact: true })).toBeVisible();
  await expect(result.locator(".polish-row")).toHaveCount(0);

  await paste.fill("이번 매출은 1,250만원으로 집계되었습니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(result.locator(".polish-protection-metric")).toHaveText("수정안 미적용 1");
  await expect(result).not.toContainText("보호 검증 차단");
  // A rejected proposal leaves the text unchanged, so no identical 수정안 is repeated.
  await expect(result.locator(".polish-summary-line")).toContainText("변경 0");
  await expect(result.locator(".polish-row")).toHaveCount(0);
  await expect(result.locator(".polish-rejection-reason")).toBeVisible();

  await page.getByRole("radio", { name: "파일 윤문" }).check();
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const fileResult = page.locator(".polish-results:not(.polish-text-results)");
  await expect(fileResult.getByRole("heading", { name: "윤문 결과", exact: true })).toBeVisible();
  await expect(fileResult).not.toContainText("POLISH RESULT");
  await expect(fileResult).not.toContainText("문장 윤문");
});

test("distinguishes partial Polish failure from unchanged text and clears stale mode results", async ({ page }) => {
  let failAll = false;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    if (failAll || request.items.some(({ text }) => text.includes("이번 내용"))) {
      await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_TIMEOUT" } }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(polishBatchResponse(request.items, (text) => text.includes("pc반환")
        ? { changed: true, revisedText: "김영삼 차장님이 PC 반납을 요청했습니다.", reasons: ["표현 정리"] }
        : { changed: false, revisedText: text, reasons: [] })),
    });
  });

  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const paste = page.getByLabel("윤문할 텍스트 입력");
  await paste.fill("김영삼 차장님이 pc반환 요청했습니다.\n이번 내용은 확인했습니다.\n다음 문장은 확인했습니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-text-results");
  await expect(result.locator(".result-status")).toHaveText("검토 미완료");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 1");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 1");
  await expect(result.locator(".polish-summary-line")).toContainText("검토 미완료 1");
  await expect(result).not.toContainText("별도 수정 없이 사용할 수 있습니다.");
  await result.getByRole("button", { name: "검토 미완료 문장 1건 보기" }).click();
  await expect(result).toContainText("이번 내용은 확인했습니다.");

  await page.getByRole("radio", { name: "간결하게" }).check();
  await expect(result).toHaveCount(0);
  failAll = true;
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(result.locator(".result-status")).toHaveText("검토 미완료");
  await expect(result.locator(".polish-summary-line")).toContainText("검토 미완료 3");
  await expect(page.locator(".notice.error")).toHaveCount(0);
});

test("shows changed, rejected and failed outcomes independently for a document", async ({ page }) => {
  const fixture = path.join(FIXTURE_DIR, "윤문_혼합.pptx");
  await writeFile(fixture, createPptxSlides([[
    "윤문 검토",
    "㈜한빛전자 법무팀은 2026-08-31에 예산을 검토하기 위한 논의를 진행했습니다.",
    "김영삼 차장님이 고객 대응을 위한 검토를 진행했습니다.",
    "이번 계획은 내부 공유를 위해 작성했습니다.",
  ]]));
  const attempts: string[] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    attempts.push(...request.items.map(({ text }) => text));
    if (request.items.some(({ text }) => text.includes("내부 공유"))) {
      await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_TIMEOUT" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => ({
        changed: true,
        revisedText: text.includes("차장님") ? text.replace("김영삼", "김철수") : text.replace("논의를 진행했습니다", "논의를 했습니다"),
        reasons: ["표현 정리"],
      })),
    ) });
  });
  await page.goto("/");
  await upload(page, fixture);
  await page.getByRole("checkbox", { name: "윤문_혼합.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "윤문");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-results:not(.polish-text-results)");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 1");
  await expect(result.locator(".polish-summary-line")).toContainText("수정안 미적용 1");
  await expect(result.locator(".polish-summary-line")).toContainText("검토 미완료 1");
  await expect(result.locator(".polish-row.rejected")).toContainText("김영삼 차장님");
  await expect(result.locator(".polish-row.rejected .polish-copy-block.revised")).toHaveCount(0);
  await expect(result.locator(".polish-row:not(.rejected) .polish-copy-block.revised")).toHaveCount(1);
  expect(attempts.filter((text) => text.includes("내부 공유")).length).toBeGreaterThanOrEqual(3);
});

test("keeps the other 57 text sentences when candidate 11 exhausts its transient retry", async ({ page }) => {
  const attempts = new Map<number, number>();
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    requests += 1;
    for (const { text } of request.items) {
      const number = Number(/문장 (\d+)/u.exec(text)?.[1]);
      attempts.set(number, (attempts.get(number) ?? 0) + 1);
    }
    if (request.items.some(({ text }) => text.includes("문장 11의"))) {
      await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_TIMEOUT" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => ({ changed: false, revisedText: text, reasons: [] })),
    ) });
  });

  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const original = Array.from({ length: 58 }, (_, index) => `문장 ${index + 1}의 내용을 함께 검토 부탁드립니다.`).join("\n");
  await page.getByLabel("윤문할 텍스트 입력").fill(original);
  await page.getByRole("button", { name: "윤문 실행" }).click();

  const result = page.locator(".polish-text-results");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 57");
  await expect(result.locator(".polish-summary-line")).toContainText("검토 미완료 1");
  await expect(result.locator(".polish-copy-block.revised")).toHaveCount(0);
  await result.getByRole("button", { name: "검토 미완료 문장 1건 보기" }).click();
  await expect(result.locator(".polish-unchanged li")).toContainText(["문장 11의 내용을 함께 검토 부탁드립니다."]);
  expect(attempts.size).toBe(58);
  expect(attempts.get(11)).toBeGreaterThanOrEqual(2);
  expect(attempts.get(58)).toBe(1);
  expect(requests).toBeLessThan(58);
});

test("isolates one unavailable provider sentence and continues later batches", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    requests++;
    if (request.items.some(({ text }) => text.includes("문장 2의"))) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_PROVIDER_UNAVAILABLE" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => ({ changed: false, revisedText: text, reasons: [] })),
    ) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill(
    Array.from({ length: 6 }, (_, index) => `문장 ${index + 1}의 내용을 함께 검토 부탁드립니다.`).join("\n"));
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-text-results");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 5");
  await expect(result.locator(".polish-summary-line")).toContainText("검토 미완료 1");
  expect(requests).toBeLessThan(20);
});

test("recovers only missing and duplicated batch entries without accepting unknown IDs", async ({ page }) => {
  const attempts = new Map<string, number>();
  let first = true;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    for (const item of request.items) attempts.set(item.text, (attempts.get(item.text) ?? 0) + 1);
    const proposals = request.items.map(({ id, text }) => ({
      id, proposal: { changed: false, revisedText: text, reasons: [] },
    }));
    const returned = first && proposals.length === 6
      ? [proposals[0], proposals[1], proposals[1], { ...proposals[2], proposal: { changed: true, revisedText: "", reasons: [] } }, { ...proposals[3], id: "unknown-id" }, proposals[4], proposals[5]]
      : proposals;
    first = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      data: { kind: "polish-batch", proposals: returned },
    }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const sentences = Array.from({ length: 6 }, (_, index) => `문장 ${index + 1}의 내용을 다시 한번 검토 부탁드립니다.`);
  await page.getByLabel("윤문할 텍스트 입력").fill(sentences.join("\n"));
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-text-results");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 6");
  await expect(result.locator(".polish-summary-line")).not.toContainText("검토 미완료");
  expect(attempts.get(sentences[0])).toBe(1);
  expect(attempts.get(sentences[1])).toBeGreaterThan(1);
  expect(attempts.get(sentences[2])).toBeGreaterThan(1);
  expect(attempts.get(sentences[3])).toBeGreaterThan(1);
  expect(attempts.get(sentences[4])).toBe(1);
  expect(attempts.get(sentences[5])).toBe(1);
});

test("splits only failing Polish ranges down to a single sentence", async ({ page }) => {
  const requests: string[][] = [];
  const attempts = new Map<string, number>();
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    const texts = request.items.map(({ text }) => text);
    requests.push(texts);
    for (const text of texts) attempts.set(text, (attempts.get(text) ?? 0) + 1);
    if (texts.includes("문장 1의 내용을 검토합니다.")) {
      await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_TIMEOUT" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => ({ changed: false, revisedText: text, reasons: [] })),
    ) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const sentences = Array.from({ length: 8 }, (_, index) => `문장 ${index + 1}의 내용을 검토합니다.`);
  await page.getByLabel("윤문할 텍스트 입력").fill(sentences.join("\n"));
  await page.evaluate(() => {
    const readings: number[] = [];
    (window as Window & { __polishProgressReadings?: number[] }).__polishProgressReadings = readings;
    new MutationObserver(() => {
      const match = /윤문 처리 중 (\d+)\/8/u.exec(document.querySelector(".compact-progress strong")?.textContent ?? "");
      if (match && readings.at(-1) !== Number(match[1])) readings.push(Number(match[1]));
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-text-results");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 7");
  await expect(result.locator(".polish-summary-line")).toContainText("검토 미완료 1");
  expect(requests.map((items) => items.length)).toEqual([8, 8, 4, 2, 1, 1, 2, 4]);
  expect(attempts.get(sentences[0])).toBe(5);
  expect(attempts.get(sentences[1])).toBe(5);
  expect(attempts.get(sentences[4])).toBe(3);
  expect(requests.at(-1)).toEqual(sentences.slice(4));
  const readings = await page.evaluate(() => (window as Window & { __polishProgressReadings?: number[] }).__polishProgressReadings ?? []);
  expect(readings.length).toBeGreaterThan(0);
  expect(readings.every((value, index) => value >= 0 && value <= 8 && (index === 0 || value >= readings[index - 1]))).toBe(true);
});

test("retries malformed batch JSON once and still rejects protected-value changes", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
      return;
    }
    const request = route.request().postDataJSON() as PolishBatchRequest;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => text.includes("1,250")
        ? { changed: true, revisedText: text.replace("1,250", "1,500"), reasons: ["표현 정리"] }
        : { changed: false, revisedText: text, reasons: [] }),
    ) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill(
    "이번 매출은 1,250만원으로 집계되었습니다.\n다음 회의를 함께 검토 부탁드립니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-text-results");
  await expect(result.locator(".polish-summary-line")).toContainText("수정안 미적용 1");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 1");
  await expect(result.locator(".polish-summary-line")).not.toContainText("검토 미완료");
  expect(requests).toBe(2);
});

test("bounds long Polish candidates by total characters as well as count", async ({ page }) => {
  const sizes: number[] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    const chars = request.items.reduce((sum, item) => sum + item.text.length, 0);
    expect(request.items.length).toBeLessThanOrEqual(8);
    expect(chars).toBeLessThanOrEqual(2400);
    sizes.push(request.items.length);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => ({ changed: false, revisedText: text, reasons: [] })),
    ) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const sentences = Array.from({ length: 9 }, (_, index) =>
    `문장 ${index + 1}의 내용을 검토합니다. ` + "관련 내용을 함께 검토 부탁드립니다. ".repeat(16));
  await page.getByLabel("윤문할 텍스트 입력").fill(sentences.join("\n"));
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".polish-text-results .polish-summary-line")).toContainText("변경 없음 9");
  expect(sizes.length).toBeGreaterThan(1);
  expect(sizes[0]).toBeLessThan(8);
});

test("bounds PDF Polish requests while preserving every sentence", async ({ page }) => {
  const sentences = Array.from({ length: 58 }, (_, index) => `문장 ${index + 1}의 업무 내용을 함께 검토 부탁드립니다.`);
  const pdf = await createUnicodePdf(Array.from({ length: 5 }, (_, index) =>
    sentences.slice(index * 12, (index + 1) * 12).map((text) => ({ text }))));
  const fixture = path.join(FIXTURE_DIR, "윤문_58문장.pdf");
  await writeFile(fixture, pdf);
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    requests++;
    expect(request.kind).toBe("polish-batch");
    expect(request.items.length).toBeLessThanOrEqual(8);
    expect(request.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(2400);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      polishBatchResponse(request.items, (text) => ({ changed: false, revisedText: text, reasons: [] })),
    ) });
  });
  await page.goto("/");
  await upload(page, fixture);
  await page.getByRole("checkbox", { name: "윤문_58문장.pdf 선택", exact: true }).check();
  await navigateWorkspace(page, "윤문");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  const result = page.locator(".polish-results:not(.polish-text-results)");
  await expect(result.locator(".polish-summary-line")).toContainText("변경 없음 58");
  expect(requests).toBe(8);
});

test("stops a pending Retry-After wait without sending another batch", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    requests++;
    await route.fulfill({
      status: 429, contentType: "application/json",
      headers: { "Retry-After": "2" },
      body: JSON.stringify({ error: { code: "AI_RATE_LIMITED" } }),
    });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("첫 번째 문장을 검토합니다.\n두 번째 문장을 검토합니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: "중지", exact: true }).click();
  await expect(page.locator(".polish-text-results .result-status")).toHaveText("중지됨", { timeout: 800 });
  await page.waitForTimeout(2_100);
  expect(requests).toBe(1);
});

test("does not split or storm the provider after a persistent rate limit", async ({ page }) => {
  const requests: number[] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    requests.push(request.items.length);
    await route.fulfill({
      status: 429, contentType: "application/json",
      headers: { "Retry-After": "1" },
      body: JSON.stringify({ error: { code: "AI_RATE_LIMITED" } }),
    });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill(
    Array.from({ length: 9 }, (_, index) => `문장 ${index + 1}의 내용을 검토합니다.`).join("\n"));
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".polish-text-results .polish-summary-line")).toContainText("검토 미완료 8");
  expect(requests).toEqual([8, 8]);
});

test("stops Polish at a configuration error without retrying or accusing unattempted sentences", async ({ page }) => {
  const attempts: string[][] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    attempts.push(request.items.map(({ text }) => text));
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_NOT_CONFIGURED" } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("첫 번째 문장은 그대로 둡니다.\n두 번째 문장은 검토합니다.\n세 번째 문장은 아직 남았습니다.\n네 번째 문장은 아직 남았습니다.\n다섯 번째 문장은 아직 남았습니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".notice.error")).toContainText("윤문을 완료하지 못했습니다.");
  await expect(page.locator(".polish-text-results .polish-summary-line")).toContainText("검토 미완료 5");
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toHaveLength(5);
});

test("keeps completed Polish work when the user stops an in-flight sentence", async ({ page }) => {
  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const attempts: string[] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as PolishBatchRequest;
    attempts.push(...request.items.map(({ text }) => text));
    if (request.items.some(({ text }) => text.includes("문장 9의"))) {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
        polishBatchResponse(request.items, (text) => ({ changed: false, revisedText: text, reasons: [] })),
      ) });
    } catch {
      // The browser has already aborted the request being fulfilled.
    }
  });
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill(
    Array.from({ length: 9 }, (_, index) => `문장 ${index + 1}의 내용을 검토합니다.`).join("\n"));
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await secondStarted.promise;
  await page.getByRole("button", { name: "중지", exact: true }).click();
  releaseSecond.resolve();
  await expect(page.locator(".polish-text-results .result-status")).toHaveText("중지됨");
  await expect(page.locator(".polish-text-results .polish-summary-line")).toContainText("변경 없음 8");
  await expect(page.locator(".polish-text-results .polish-summary-line")).not.toContainText("검토 미완료");
  await expect(page.locator(".notice.error")).toHaveCount(0);
  expect(attempts).toHaveLength(9);
});

test("runs Ask, Analyze, Polish, Check and Extract through the server AI boundary", async ({ page }) => {
  const seen = new Set<string>();
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims" | "polish-batch" | "extract";
      request?: { operation: string };
      items?: Array<{ handle: string; id: string; text: string }>;
      field?: string;
    };
    let data: object;
    if (request.kind === "claims") {
      const evidence = request.items?.[0];
      if (!evidence || !request.request) throw new Error("Mocked claims request is missing evidence.");
      seen.add(request.request.operation);
      data = {
        kind: "claims",
        claims: [{ text: evidence.text, handles: [evidence.handle], confidence: "high",
          ...(request.request.operation === "analyze" ? { presentation: { role: "summary" } } : {}) }],
      };
    } else if (request.kind === "polish-batch") {
      seen.add("polish");
      data = polishBatchResponse(request.items ?? [], (text) => ({ changed: false, revisedText: text, reasons: [] })).data;
    } else {
      seen.add("extract");
      data = {
        kind: "extract",
        proposal: { field: request.field ?? "", value: null, handles: [], confidence: "low" },
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();

  await navigateWorkspace(page, "질문");
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("답변 완료");
  expect([...seen]).toEqual(["ask"]);

  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("분석 완료");
  expect([...seen].sort()).toEqual(["analyze", "ask"]);

  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("운임 현황을 검토 부탁드립니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("윤문 완료");
  expect([...seen].sort()).toEqual(["analyze", "ask", "polish"]);

  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행", exact: true }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");
  expect([...seen].sort()).toEqual(["analyze", "ask", "polish", "semantic-check"]);

  await navigateWorkspace(page, "추출");
  await page.getByRole("radio", { name: "항목 지정" }).check();
  await page.getByLabel("추출할 항목").fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("추출 완료");

  expect([...seen].sort()).toEqual(["analyze", "ask", "extract", "polish", "semantic-check"]);
});

test("uses only the disabled action button for single-request progress", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: string;
      items?: Array<{ handle: string; text: string }>;
      text?: string;
      field?: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    const evidence = request.items?.[0];
    const data = request.kind === "claims"
      ? {
          kind: "claims",
          claims: evidence ? [{ text: evidence.text, handles: [evidence.handle], confidence: "high" }] : [],
        }
      : request.kind === "polish"
        ? { kind: "polish", proposal: { changed: false, revisedText: request.text ?? "", reasons: [] } }
        : { kind: "extract", proposal: { field: request.field ?? "", value: null, handles: [], confidence: "low" } };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "요약", exact: true })).toHaveCount(0);
  await upload(page, files.v1);
  await upload(page, files.v2);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();

  const runs: Array<{ tab: "Analyze" | "Ask" | "Compare" | "Check"; label: string }> = [
    { tab: "Analyze", label: "분석" },
    { tab: "Ask", label: "질문" },
    { tab: "Compare", label: "비교" },
    { tab: "Check", label: "검수" },
  ];
  for (const run of runs) {
    await navigateWorkspace(page, run.label);
    if (run.tab === "Ask") {
      await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
    }
    const action = page.locator(".operation-actions button");
    await action.click();
    await expect(action).toHaveText("처리 중…");
    await expect(action).toBeDisabled();
    await expect(page.locator(".processing-bar")).toHaveCount(0);
    await expect(action).toHaveText("실행", { timeout: 15_000 });
    await expect(action).toBeEnabled();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await navigateWorkspace(page, "분석");
  const mobileAction = page.locator(".operation-actions button");
  await mobileAction.click();
  await expect(mobileAction).toHaveText("처리 중…");
  await expect(page.locator(".processing-bar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(mobileAction).toHaveText("실행", { timeout: 15_000 });
});

test("keeps compact counted progress for Polish and Extract", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: string;
      items?: PolishBatchRequest["items"];
      field?: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
    const data = request.kind === "polish-batch"
      ? polishBatchResponse(request.items ?? [], (text) => ({ changed: false, revisedText: text, reasons: [] })).data
      : { kind: "extract", proposal: { field: request.field ?? "", value: null, handles: [], confidence: "low" } };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();

  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("운임 현황을 검토 부탁드립니다.");
  const polishAction = page.getByRole("button", { name: "윤문 실행" });
  await polishAction.click();
  await expect(polishAction).toHaveText("처리 중…");
  await expect(polishAction).toBeDisabled();
  const polishProgress = page.locator(".compact-progress");
  await expect(polishProgress).toContainText(/윤문 처리 중 0\/\d+/);
  await expect(polishProgress).toContainText("문장별 검증을 유지하며 묶음으로 처리하고 있습니다.");
  await expect(polishProgress.getByRole("button", { name: "중지", exact: true })).toBeVisible();
  await expect(polishProgress).not.toHaveClass(/status-panel/);
  await expect(polishProgress).toHaveCSS("border-width", "0px");
  await expect(polishAction).toHaveText("실행", { timeout: 15_000 });
  await expect(polishAction).toBeEnabled();
  await expect(polishProgress).toHaveCount(0);

  await navigateWorkspace(page, "추출");
  await page.getByRole("radio", { name: "항목 지정" }).check();
  await page.getByLabel("추출할 항목").fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const extractAction = page.getByRole("button", { name: "추출 실행" });
  await extractAction.click();
  await expect(extractAction).toHaveText("처리 중…");
  await expect(extractAction).toBeDisabled();
  const extractProgress = page.locator(".compact-progress");
  await expect(extractProgress).toContainText("항목 확인 중 0/1");
  await expect(extractProgress).toContainText("관련 근거를 확인하고 있습니다.");
  await expect(extractProgress).toBeVisible();
  const stop = extractProgress.getByRole("button", { name: "중지", exact: true });
  await expect(stop).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await stop.click();
  await expect(extractProgress).toHaveCount(0);
  await expect(extractAction).toHaveText("실행");
  await expect(extractAction).toBeEnabled();
  await expect(page.locator(".notice.error")).toHaveCount(0);
});

test("connects each Ask answer directly to its file and evidence", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims";
      items: Array<{ handle: string; text: string }>;
    };
    const evidence = request.items.slice(0, 2);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kind: "claims",
          claims: evidence.map((item) => ({ text: item.text, handles: [item.handle], confidence: "high" })),
        },
      }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "질문");
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();

  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "답변", exact: true })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText("답변 완료");
  await expect(page.locator(".notice.success")).toHaveCount(0);
  await expect(panel).not.toContainText("ASK RESULT");
  await expect(panel).not.toContainText("추론:");
  await expect(panel).not.toContainText("해석 · 근거 검증됨");
  await expect(panel).not.toContainText("FILE FACT");
  await expect(panel).not.toContainText("해석");
  await expect(panel).not.toContainText("근거별 주장");
  await expect(panel).not.toContainText("claims");
  await expect(panel).not.toContainText("근거 연결 결과");
  await expect(panel.getByRole("button", { name: /윤문/ })).toHaveCount(0);

  const answer = panel.locator(".ask-answer");
  const rows = panel.locator(".ask-answer-row");
  await expect(answer).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(panel.locator(".ask-evidence")).toHaveCount(0);
  await expect(rows.locator(".ask-answer-files")).toHaveText(["운임현황_v1.xlsx", "운임현황_v1.xlsx"]);

  const answerText = (await rows.first().locator("p").innerText()).trim();
  expect(answerText).not.toContain("추론:");
  await expect(panel.getByText(answerText, { exact: true })).toHaveCount(1);
  await expect(rows.first().locator(".result-source")).toBeVisible();
  await expect(rows.first().locator(".source-action")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await rows.first().locator(".source-action").click();
  await expect(page.locator(".evidence-inspector")).toBeVisible();
});

test("shows an informational Ask alert without inventing sources", async ({ page }) => {
  let serverError = false;
  await page.route("**/api/ai", async (route) => {
    await route.fulfill(serverError
      ? { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_NOT_CONFIGURED" } }) }
      : { status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "질문");
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();

  const notice = page.locator(".status-panel.notice.info");
  await expect(notice).toContainText("선택한 파일에서 관련 내용을 찾지 못했습니다.");
  await expect(notice).toContainText("질문을 바꾸거나 다른 파일을 선택해 주세요.");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await expect(page.locator(".results-panel")).toHaveCount(0);
  await expect(page.locator(".ask-evidence .result-source")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(notice).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  serverError = true;
  await page.getByRole("button", { name: "질문 실행" }).click();
  await expect(page.locator(".status-panel.notice.error")).toContainText("질문을 처리하지 못했습니다.");
  await expect(page.locator(".notice.info")).toHaveCount(0);
});

test("keeps grounded Ask and Analyze summaries when another claim is rejected", async ({ page }) => {
  const operations: string[] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims";
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    operations.push(request.request.operation);
    const evidence = request.request.operation === "analyze"
      ? request.items.find((item) => item.text.includes("비용이 늘어나면"))
      : request.items[0];
    if (!evidence) throw new Error("Mocked claims request is missing evidence.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [
        { text: evidence.text, handles: [evidence.handle], confidence: "high",
          ...(request.request.operation === "analyze" ? { presentation: { role: "summary" } } : {}) },
        { text: "문서에 없는 내용", handles: ["missing-handle"], confidence: "high",
          ...(request.request.operation === "analyze" ? { presentation: { role: "insight" } } : {}) },
      ] } }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "질문");
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();
  const askPanel = page.locator(".results-panel");
  await expect(askPanel.locator(".result-status")).toHaveText("답변 완료");
  await expect(askPanel).not.toContainText("문서에 없는 내용");

  await upload(page, files.analyzePptx);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "기업요약.pptx 선택", exact: true }).check();

  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "핵심 요약", exact: true })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.locator(".analysis-summary-section .analysis-reading-row")).toHaveCount(1);
  await expect(panel).not.toContainText("문서에 없는 내용");
  await expect(panel.getByRole("heading", { name: "분석 인사이트" })).toHaveCount(0);
  const source = panel.locator(".analysis-summary-section .source-action").first();
  await source.click();
  const detail = page.getByRole("complementary", { name: "근거 상세" });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "닫기" }).click();
  await expect(source).toBeFocused();
  expect(operations).toEqual(["ask", "analyze"]);
  await expect(page.locator(".notice.error")).toHaveCount(0);
});

test("groups repeated Analyze summary sources without losing drawer coverage", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as { kind: "claims"; items: Array<{ handle: string; text: string }> };
    const byText = new Map<string, Array<{ handle: string; text: string }>>();
    for (const item of request.items) {
      const group = byText.get(item.text) ?? [];
      group.push(item);
      byText.set(item.text, group);
    }
    const repeated = [...byText.values()].find((group) => group.length > 1 && group[0].text.includes("비용이 늘어나면"));
    if (!repeated) throw new Error("Mocked Analyze request is missing repeated cross-file evidence.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [
        { text: repeated[0].text, handles: repeated.slice(0, 2).map((item) => item.handle),
          confidence: "high", presentation: { role: "summary" } },
      ] } }),
    });
  });

  await page.goto("/");
  await upload(page, files.analyzePptx);
  await upload(page, files.analyzeCopy);
  await page.getByRole("checkbox", { name: "기업요약.pptx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "기업요약_사본.pptx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();

  const panel = page.locator(".results-panel");
  const item = panel.locator(".analysis-summary-section .analysis-reading-row").first();
  const source = item.locator(".source-action");
  await expect(item.locator(".source-locator")).toContainText("외 1곳");
  await source.click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail.locator(".evidence-entry")).toHaveCount(2);
  await expect(detail.locator(".evidence-file-list")).toContainText("기업요약.pptx");
  await expect(detail.locator(".evidence-file-list")).toContainText("기업요약_사본.pptx");
  await detail.getByRole("button", { name: "닫기" }).click();
  await expect(source).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await item.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps deterministic Analyze results when the model abstains", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [] } }),
    });
  });

  await page.goto("/");
  await upload(page, files.analyzePptx);
  await page.getByRole("checkbox", { name: "기업요약.pptx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  const panel = page.locator(".results-panel");
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.getByRole("heading", { name: "핵심 요약", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "분석 인사이트", exact: true })).toHaveCount(0);
  await expect(panel).toContainText("시가총액");
  await expect(page.locator(".notice.error")).toHaveCount(0);
});

test("summarizes a short notice without inventing an insight section", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/ai", async (route) => {
    const body = route.request().postDataJSON() as {
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    expect(body.request.operation).toBe("analyze");
    requests += 1;
    const schedule = body.items.find((item) => item.text.includes("9월 28일"));
    const audience = body.items.find((item) => item.text.includes("현장 관리자"));
    if (!schedule || !audience) throw new Error("Notice evidence is missing.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [
        { text: "교육은 9월 28일 3층 대회의실에서 진행됩니다.", handles: [schedule.handle], confidence: "high", presentation: { role: "summary" } },
        { text: "참석 대상은 현장 관리자입니다.", handles: [audience.handle], confidence: "high", presentation: { role: "summary" } },
      ] } }),
    });
  });
  await page.goto("/");
  await upload(page, files.noticePptx);
  await page.getByRole("checkbox", { name: "교육안내.pptx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  const panel = page.locator(".results-panel");
  await expect(panel.locator(".result-status")).toHaveText("분석 완료");
  await expect(panel.locator(".analysis-summary-section .analysis-reading-row")).toHaveCount(2);
  await expect(panel.locator(".analysis-summary-section .source-action")).toHaveCount(2);
  // Main content adds only what the summary does not already say.
  await expect(panel.locator(".analysis-core-items-section .analysis-reading-row")).toHaveCount(1);
  await expect(panel.locator(".analysis-core-items-section")).toContainText("필기도구를 준비해 주세요.");
  await expect(panel.locator(".analysis-insight-section")).toHaveCount(0);
  expect(requests).toBe(1);
});

test("uses one Analyze request for document-wide summary and relational insight", async ({ page }) => {
  const requests: Array<Array<{ handle: string; text: string }>> = [];
  await page.route("**/api/ai", async (route) => {
    const body = route.request().postDataJSON() as {
      kind: "claims";
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    expect(body.request.operation).toBe("analyze");
    requests.push(body.items);
    const summary = body.items.find((item) => item.text.includes("시가총액"));
    const price = body.items.find((item) => item.text.includes("목표주가"));
    const insight = body.items.find((item) => item.text.includes("비용이 늘어나면"));
    if (!summary || !price || !insight) throw new Error("Analyze must cover both facts and conditional rules.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [
        { text: "기업 개요의 특징은 시가총액: 3,420억원, 목표주가: 64,550원 두 지표를 함께 제시한다는 점입니다.", handles: [...new Set([summary.handle, price.handle])], confidence: "high", presentation: { role: "summary", section: "" } },
        { text: "비용이 늘어나면 예산을 다시 검토합니다.", handles: [insight.handle], confidence: "high", presentation: { role: "insight", section: "" } },
      ] } }),
    });
  });
  await page.goto("/");
  await upload(page, files.analyzePptx);
  await page.getByRole("checkbox", { name: "기업요약.pptx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  const panel = page.locator(".results-panel");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].some((item) => item.text.includes("시가총액"))).toBe(true);
  expect(requests[0].some((item) => item.text.includes("비용"))).toBe(true);
  await expect(panel.locator(".analysis-summary-section")).toContainText("시가총액");
  await expect(panel.getByRole("heading", { name: "분석 인사이트" })).toBeVisible();
  await expect(panel).toContainText("예산을 다시 검토합니다");
  const headings = await panel.locator("h2, h3").allTextContents();
  expect(headings.indexOf("핵심 요약")).toBeLessThan(headings.indexOf("분석 인사이트"));
  const source = panel.locator(".analysis-summary-section .source-action").first();
  await source.click();
  await expect(page.getByLabel("근거 상세")).toBeVisible();
  await page.getByLabel("근거 상세").getByRole("button", { name: "닫기" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  const mobileHeadings = await panel.locator("h2, h3").allTextContents();
  expect(mobileHeadings.indexOf("핵심 요약")).toBeLessThan(mobileHeadings.indexOf("분석 인사이트"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("integrates enrichment behind one action and preserves every deterministic result on failure", async ({ page }) => {
  let failEnrichment = false;
  const operations: string[] = [];
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims";
      request: { operation: string };
      items: Array<{ handle: string; text: string }>;
    };
    operations.push(request.request.operation);
    if (failEnrichment) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "AI_PROVIDER_UNAVAILABLE", retryable: true } }),
      });
      return;
    }
    const evidence = request.items[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kind: "claims",
          claims: [{ text: evidence.text, handles: [evidence.handle], confidence: "high",
            ...(request.request.operation === "analyze" ? { presentation: { role: "summary" } } : {}) }],
        },
      }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  await upload(page, files.checkPptx);

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("분석 완료");

  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  await expect(page.locator(".results-panel .result-status")).toHaveText("비교 완료");

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");

  failEnrichment = true;
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");
  await expect(page.locator(".result-inline-warning")).toHaveCount(0);
  await expect(page.locator(".notice.warning")).toHaveCount(0);
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "검수 실행" })).toBeEnabled();

  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .analysis-core-items-section .analysis-reading-row").first()).toBeVisible();
  await expect(page.locator(".result-inline-warning")).toContainText("기본 분석은 완료됐습니다. 요약과 인사이트를 불러오지 못했습니다.");
  await expect(page.locator(".results-panel .result-status")).toHaveText("기본 분석 완료");
  await expect(page.locator(".results-panel .result-status")).toHaveClass(/warning/);

  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  await expect(page.locator(".result-inline-warning")).toHaveCount(0);
  await expect(page.locator(".comparison-semantic-section")).toHaveCount(0);
  await expect(page.locator(".enrichment-results")).toHaveCount(0);
  await expect(page.locator(".results-panel .result-status")).toHaveText("비교 완료");
  await expect(page.locator(".notice.error")).toHaveCount(0);

  expect(operations).toEqual([
    "analyze",
    "semantic-check",
    "semantic-check",
    "semantic-check",
    "analyze",
    "semantic-check",
  ]);
});


test("reviews PPTX writing, consistency and data findings with filters and exact slide evidence", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();

  const panel = page.locator(".results-panel");
  const overview = page.locator(".qa-overview");
  await expect(panel.getByRole("heading", { name: "검수 결과", exact: true })).toHaveCount(1);
  await expect(panel).not.toContainText("문서 품질 검수");
  await expect(overview.locator(".qa-summary-line")).toContainText("중요");
  await expect(overview.locator(".qa-summary-line")).toContainText("주의");
  await expect(overview.locator(".qa-summary-line")).toContainText("제안");
  const emptySeverities = overview.locator(".qa-summary-line span.muted");
  expect(await emptySeverities.count()).toBeGreaterThan(0);
  expect(await emptySeverities.first().evaluate((element) => getComputedStyle(element).color)).toBe(await emptySeverities.first().locator("b").evaluate((element) => getComputedStyle(element).color));
  const overviewStyle = await overview.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: element.getBoundingClientRect().width,
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    };
  });
  expect(overviewStyle.width).toBeLessThanOrEqual(450);
  expect(overviewStyle).toMatchObject({ background: "rgb(255, 255, 255)", borderWidth: "1px", boxShadow: "rgba(15, 23, 42, 0.04) 0px 1px 2px 0px, rgba(15, 23, 42, 0.04) 0px 4px 12px 0px" });
  expect(await overview.locator(".qa-summary-line span").nth(1).evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe("1px");
  await expect(page.getByText("낮은 확신 포함")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "용어 사전" })).toBeVisible();
  expect(await page.getByRole("button", { name: "용어 사전" }).evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("1px");
  await expect(page.locator(".check-filter-status")).toHaveCount(0);

  // The result heading and file area define the outer grid. Summary, filter
  // text, issue accent and dictionary share those edges without extra inset.
  const edges = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const heading = box(".result-heading");
    const fileArea = box(".file-list");
    const summary = box(".qa-overview");
    const line = box(".qa-summary-line");
    const filterText = document.createRange();
    filterText.selectNodeContents(document.querySelector(".check-filters-compact > button")!);
    const card = box(".check-issue");
    const dictionary = box(".dictionary-trigger");
    return {
      headingLeft: Math.round(heading.left),
      headingRight: Math.round(heading.right),
      fileLeft: Math.round(fileArea.left),
      fileRight: Math.round(fileArea.right),
      summaryLeft: Math.round(summary.left),
      filterLeft: Math.round(filterText.getClientRects()[0].left),
      cardLeft: Math.round(card.left),
      dictionaryRight: Math.round(dictionary.right),
      cardRight: Math.round(card.right),
      slack: Math.round(summary.right - line.right),
    };
  });
  expect(edges.summaryLeft).toBe(edges.headingLeft);
  expect(edges.filterLeft).toBe(edges.headingLeft);
  expect(edges.cardLeft).toBe(edges.headingLeft);
  expect(edges.fileLeft).toBe(edges.headingLeft);
  expect(edges.dictionaryRight).toBe(edges.headingRight);
  expect(edges.cardRight).toBe(edges.headingRight);
  expect(edges.fileRight).toBe(edges.headingRight);
  expect(edges.slack).toBeLessThanOrEqual(16);

  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await expect(typo).toContainText("문장");
  await expect(typo).toContainText("주의");
  await expect(typo.locator(".source-locator")).toHaveText("Slide 1");
  await expect(typo.getByRole("button", { name: "Slide 1 근거 보기" })).toBeVisible();
  expect(await typo.locator(".check-recommendation, .check-source").evaluateAll((nodes) =>
    nodes.map((node) => node.className))).toEqual(["check-recommendation", "check-source"]);
  await expect(typo.locator(".check-recommendation")).toContainText("수정 제안");
  const suggestionHierarchy = await typo.evaluate((issue) => {
    const recommendation = issue.querySelector<HTMLElement>(".check-recommendation")!;
    const label = recommendation.querySelector<HTMLElement>(".check-field-label")!;
    const suggestion = recommendation.querySelector<HTMLElement>("p")!;
    const description = issue.querySelector<HTMLElement>(".check-issue-name > p")!;
    const source = issue.querySelector<HTMLElement>(".source-locator")!;
    const recommendationStyle = getComputedStyle(recommendation);
    return {
      background: recommendationStyle.backgroundColor,
      borderWidth: recommendationStyle.borderWidth,
      boxShadow: recommendationStyle.boxShadow,
      paddingLeft: recommendationStyle.paddingLeft,
      labelWeight: getComputedStyle(label).fontWeight,
      // Engines round fractional rem sizes differently (14.3 vs 14.2969).
      suggestionSize: Math.round(Number.parseFloat(getComputedStyle(suggestion).fontSize) * 10) / 10,
      descriptionSize: Math.round(Number.parseFloat(getComputedStyle(description).fontSize) * 10) / 10,
      suggestionColor: getComputedStyle(suggestion).color,
      descriptionColor: getComputedStyle(description).color,
      sourceSize: Math.round(Number.parseFloat(getComputedStyle(source).fontSize) * 10) / 10,
    };
  });
  expect(suggestionHierarchy).toMatchObject({
    background: "rgb(245, 249, 255)",
    borderWidth: "1px",
    boxShadow: "none",
    paddingLeft: "10px",
    labelWeight: "600",
    suggestionSize: 16.5,
    descriptionSize: 16.5,
    sourceSize: 14.3,
  });
  expect(suggestionHierarchy.suggestionColor).not.toBe(suggestionHierarchy.descriptionColor);
  expect(await typo.evaluate((issue) => getComputedStyle(issue).backgroundColor)).toBe("rgb(255, 255, 255)");
  expect(await page.locator(".check-issue .check-recommendation").evaluateAll((recommendations) =>
    recommendations.every((recommendation) => getComputedStyle(recommendation).backgroundColor === "rgb(245, 249, 255)"))).toBe(true);
  await expect(typo.locator(".check-source .check-field-label")).toHaveCount(0);
  await expect(typo.locator(".issue-detail-toggle")).toHaveCount(0);
  expect((await typo.innerText()).split("최종검수.pptx").length - 1).toBe(0);
  const rowTops = await typo.locator(".check-issue-summary, .check-recommendation, .check-source").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(rowTops[0]).toBeLessThan(rowTops[1]);
  expect(rowTops[1]).toBeLessThan(rowTops[2]);
  const findingActions = typo.locator(".finding-actions");
  const desktopActionBoxes = await findingActions.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { top: Math.round(box.top), right: Math.round(box.right) };
    }));
  expect(new Set(desktopActionBoxes.map((box) => box.top)).size).toBe(1);
  const [issueBox, actionsBox] = await Promise.all([typo.boundingBox(), findingActions.boundingBox()]);
  expect(Math.abs(issueBox!.x + issueBox!.width - (actionsBox!.x + actionsBox!.width))).toBeLessThanOrEqual(24);

  await typo.locator(".source-action").click();
  const evidence = page.getByLabel("근거 상세");
  await expect(evidence).toBeVisible();
  await expect(evidence.locator(".evidence-location-list")).toContainText("Slide 1");
  await expect(evidence).toContainText(/문서에서 확인된 근거 · \d+곳/u);
  await expect(evidence).not.toContainText(/\d+개 위치/u);
  await expect(evidence.locator(".evidence-context")).toHaveCount(0);
  await expect(evidence).not.toContainText("수정 제안");
  await expect(evidence.getByRole("button", { name: "닫기" })).toBeVisible();
  await page.screenshot({ path: "artifacts/inspo-evidence-desktop-1440.png" });
  await evidence.getByRole("button", { name: "닫기" }).click();

  await page.getByRole("button", { name: /일관성 2/ }).click();
  await expect(page.locator(".check-issue").filter({ hasText: "용어 일관성" })).toHaveCount(1);
  await expect(page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" })).toHaveCount(0);
  await page.getByRole("button", { name: /전체 8/ }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();

  await expect(page.getByRole("button", { name: "문장 검수", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/inspo-check-desktop-1440.png", fullPage: true });
  if (testInfo.project.name === "chromium-desktop") expect(consoleErrors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(typo).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const mobileEdges = await page.evaluate(() => ({
    heading: document.querySelector(".result-heading")!.getBoundingClientRect().right,
    dictionary: document.querySelector(".dictionary-trigger")!.getBoundingClientRect().right,
    filters: document.querySelector(".check-filters-compact")!.scrollWidth,
    visibleFilters: document.querySelector(".check-filters-compact")!.clientWidth,
  }));
  expect(Math.abs(mobileEdges.dictionary - mobileEdges.heading)).toBeLessThanOrEqual(1);
  expect(mobileEdges.filters).toBeGreaterThan(mobileEdges.visibleFilters);
  const mobileOrder = await typo.locator(".check-recommendation, .check-source").evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().top));
  expect(mobileOrder[0]).toBeLessThan(mobileOrder[1]);
  await page.screenshot({ path: "artifacts/check-suggestion-mobile-390.png", fullPage: true });
  const longSuggestion = await typo.locator(".check-recommendation p").evaluate((paragraph) => {
    paragraph.textContent = `https://example.com/${"long-segment-".repeat(24)}`;
    const bounds = paragraph.getBoundingClientRect();
    return {
      height: bounds.height,
      lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      width: bounds.width,
      parentWidth: paragraph.parentElement!.clientWidth,
    };
  });
  expect(longSuggestion.height).toBeGreaterThan(longSuggestion.lineHeight);
  expect(longSuggestion.width).toBeLessThanOrEqual(longSuggestion.parentWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await findingActions.evaluate((element) => getComputedStyle(element).justifyContent)).toBe("flex-start");
});

test("reports an English typo at one severity whichever detector finds it", async ({ page }) => {
  const deck = path.join(FIXTURE_DIR, "영문_오타.pptx");
  await writeFile(deck, createPptxSlides([[
    "Quarterly update",
    "We should re-check teh assumptions.",
    "Please make sure every attachement is included.",
    "Forecast review",
    "The forecast value is late.",
  ]]));
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as { items: Array<{ handle: string; text: string }> };
    const handle = (word: string) => request.items.find((item) => item.text.includes(word))!.handle;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [
      { text: "‘teh’는 ‘the’로 표기해야 합니다.", handles: [handle("teh")], confidence: "high" },
      { text: "‘attachement’는 ‘attachment’로 표기해야 합니다.", handles: [handle("attachement")], confidence: "high" },
    ] } }) });
  });
  await page.goto("/");
  await upload(page, deck);
  await page.getByRole("checkbox", { name: "영문_오타.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();

  const panel = page.locator(".results-panel");
  const issues = page.locator(".check-issue");
  const spelling = issues.filter({ hasText: "영문 철자 오류 가능성" });
  // The rule and sentence review both report "teh": one issue, same wording and severity as "attachement".
  await expect(spelling).toHaveCount(2);
  await expect(spelling.filter({ hasText: "\"teh\"의 철자를 확인하세요." })).toHaveCount(1);
  const reviewed = spelling.filter({ hasText: "\"attachement\"의 철자를 확인하세요." });
  await expect(reviewed).toHaveClass(/severity-warning/);
  await expect(reviewed).toContainText("\"attachment\"(으)로 교정하세요.");
  await expect(reviewed.getByRole("button", { name: "Slide 1 근거 보기" })).toBeVisible();
  await expect(spelling.filter({ has: page.locator(".check-severity", { hasText: "제안" }) })).toHaveCount(0);
  await expect(panel).not.toContainText("추론");
  await expect(panel).not.toContainText("문장 검토 의견");
  // Choosing between "Forecast" and "forecast" stays a consistency suggestion.
  await expect(issues.filter({ hasText: "\"Forecast\"" }).first()).toHaveClass(/severity-suggestion/);

  const summaryCount = async (label: string) => Number(await page.locator(".qa-summary-line span", { hasText: label }).locator("b").textContent());
  expect(await summaryCount("주의")).toBe(await issues.locator(".check-severity", { hasText: "주의" }).count());
  expect(await summaryCount("제안")).toBe(await issues.locator(".check-severity", { hasText: "제안" }).count());

  // Adding the reviewed word to the personal dictionary removes it and its count, like any rule finding.
  const warningsBefore = await summaryCount("주의");
  await reviewed.getByRole("button", { name: "내 용어에 추가" }).click();
  await expect(spelling).toHaveCount(1);
  expect(await summaryCount("주의")).toBe(warningsBefore - 1);
});

test("keeps the personal dictionary and ignore actions inside this browser", async ({ page, browser }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();

  const before = await page.locator(".check-issue").count();
  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await typo.getByRole("button", { name: "내 용어에 추가" }).click();
  await expect(page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" })).toHaveCount(0);
  await expect(page.locator(".check-issue")).toHaveCount(before - 1);

  // Only the term strings are persisted; no document text ever reaches storage.
  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(window.localStorage)));
  expect(Object.keys(storage)).toEqual(["worklens:user-dictionary:v1"]);
  expect(JSON.parse(storage["worklens:user-dictionary:v1"])).toContain("전먕");
  expect(JSON.stringify(storage)).not.toContain("향후 13주");

  await page.getByRole("button", { name: "용어 사전" }).click();
  await expect(page.locator(".dictionary-panel")).toContainText("개인 사전은 이 브라우저에만 저장됩니다.");
  await expect(page.locator(".dictionary-panel")).toContainText("WorkLens");
  await page.getByRole("button", { name: "용어 사전" }).click();

  // Ignoring a rule removes the whole family from the current result.
  const remaining = page.locator(".check-issue").first();
  const ignoredIssue = await remaining.locator(".check-issue-name > strong").innerText();
  await remaining.getByRole("button", { name: "동일 규칙 무시" }).click();
  await expect(page.locator(".check-issue").filter({ hasText: ignoredIssue })).toHaveCount(0);
  const exclusionCount = await page.locator(".check-issue").count();
  const excluded = page.locator(".check-issue").first();
  await excluded.getByRole("button", { name: "이번 항목 제외" }).click();
  await expect(page.locator(".check-issue")).toHaveCount(exclusionCount - 1);

  // The dictionary survives a reload of the same browser profile.
  await page.reload();
  await expect(page.evaluate(() => JSON.parse(window.localStorage.getItem("worklens:user-dictionary:v1") ?? "[]"))).resolves.toContain("전먕");

  // A separate browser context starts with an empty personal dictionary.
  const isolated = await browser.newContext();
  const otherPage = await isolated.newPage();
  await otherPage.goto(page.url());
  await expect(otherPage.evaluate(() => window.localStorage.getItem("worklens:user-dictionary:v1"))).resolves.toBeNull();
  await isolated.close();
});


test("uses the loaded company dictionary in both the page and review popup across changes and fallback", async ({ page }) => {
  let terms = ["I&C", "WorkLens", "ISO 27001", "R&D", "Winstal", "운영", "품질", "안전"];
  let unavailable = false;
  let requests = 0;
  await page.route("**/api/company-terms", (route) => {
    requests += 1;
    return route.fulfill(unavailable
      ? { status: 503, body: "unavailable" }
      : {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { source: "d1", terms: terms.map((term, index) => ({
          id: index + 1, term, description: null, active: true,
        })) } }),
      });
  });
  await mockEmptyClaims(page);

  const inspect = async (expected: string[], source: "d1" | "seed", expectedRequests: number) => {
    await page.goto("/");
    await navigateWorkspace(page, "Dictionary");
    const dictionary = page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first();
    await expect(dictionary.locator("h4")).toContainText(`COMPANY TERMS ${expected.length}`);
    if (source === "seed") await expect(dictionary).toContainText("공용 사전 저장소에 연결하지 못해 기본 목록을 표시합니다.");
    const pageTerms = await dictionary.locator(".dictionary-term").allTextContents();
    await navigateWorkspace(page, "분석");
    await upload(page, files.checkPptx);
    await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
    await navigateWorkspace(page, "검수");
    await page.getByRole("button", { name: "검수 실행" }).click();
    await expect(page.locator(".check-issue").first()).toBeVisible();
    await page.getByRole("button", { name: "용어 사전" }).click();
    const popup = page.getByRole("dialog", { name: "용어 사전" });
    const company = popup.locator(".dictionary-section").first();
    await expect(company.locator("h4")).toContainText(`회사 용어 ${expected.length}`);
    const shown = expected.slice(0, 12);
    await expect(company.locator(".dictionary-term:not(.muted)")).toHaveText(shown);
    expect(pageTerms).toEqual(expected);
    if (expected.length > 12) await expect(company.locator(".dictionary-term.muted")).toHaveText(`외 ${expected.length - 12}개`);
    else await expect(company.locator(".dictionary-term.muted")).toHaveCount(0);
    expect(requests).toBe(expectedRequests);
  };
  await inspect(terms, "d1", 1);
  terms = [...terms, "새 회사 용어"];
  await inspect(terms, "d1", 2);
  terms = terms.filter((term) => term !== "I&C");
  await inspect(terms, "d1", 3);
  unavailable = true;
  const parsedSeed: unknown = JSON.parse(await readFile(path.join(process.cwd(), "src/config/company-terms.json"), "utf8"));
  if (!parsedSeed || typeof parsedSeed !== "object" || !("terms" in parsedSeed) || !Array.isArray(parsedSeed.terms) || !parsedSeed.terms.every((term) => typeof term === "string")) throw new Error("Invalid seed terms");
  await inspect(parsedSeed.terms, "seed", 4);
});

test("keeps empty upload actions singular and restores header actions after upload", async ({ page }) => {
  await page.goto("/");
  const context = page.locator(".context-bar");
  const dropzone = page.locator(".dropzone");

  await expect(context.locator(".context-files")).toContainText("작업 파일");
  await expect(context.locator(".context-counts")).toHaveText("0개");
  await expect(context).not.toContainText("선택 0개");
  await expect(context).not.toContainText("선택 없음");
  await expect(context.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
  await expect(context.getByRole("button", { name: "모두 삭제" })).toHaveCount(0);
  await expect(dropzone.getByRole("button", { name: "파일 추가" })).toBeVisible();
  await expect(dropzone).toContainText("파일 업로드");
  await expect(dropzone).toContainText("XLSX, CSV, PDF, DOCX, PPTX · 파일당 최대 100 MB · 전체 최대 300 MB");
  await expect(dropzone).not.toContainText("여기로 끌어놓기");

  await dropzone.dispatchEvent("dragenter");
  await expect(dropzone).toHaveClass(/drag-active/);
  await dropzone.dispatchEvent("dragleave");
  await expect(dropzone).not.toHaveClass(/drag-active/);

  await upload(page, files.v1);
  await expect(dropzone).toHaveCount(0);
  await expect(context.getByRole("button", { name: "파일 추가" })).toBeVisible();
  await expect(context.getByRole("button", { name: "모두 삭제" })).toBeVisible();
  await expect(context.locator(".context-counts")).toContainText("1개");
  await expect(context.locator(".context-counts")).toContainText("선택 0개");

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await expect(context.locator(".context-counts")).toContainText("선택 1개");
  await upload(page, files.v2);
  await expect(context.locator(".context-counts")).toContainText("2개");

  await page.reload();
  await expect(page.locator(".dropzone")).toBeVisible();
  await expect(page.locator(".context-bar").getByRole("button", { name: "모두 삭제" })).toHaveCount(0);
});

test("uploads a dropped file and returns to populated header actions", async ({ page }) => {
  await page.goto("/");
  const bytes = Array.from(await createXlsx(RATE_SHEET_V1));
  await page.locator(".dropzone").evaluate((element, payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload)], "드롭업로드.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, bytes);
  await expect(page.getByRole("checkbox", { name: "드롭업로드.xlsx 선택", exact: true })).toBeVisible();
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.locator(".context-bar").getByRole("button", { name: "파일 추가" })).toBeVisible();
  await expect(page.locator(".context-bar").getByRole("button", { name: "모두 삭제" })).toBeVisible();
});

test("aligns fileless text Polish controls to one desktop and mobile baseline", async ({ page }) => {
  await page.goto("/");
  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await expect(page.locator(".dropzone")).toBeVisible();

  const alignment = async () => {
    const title = page.getByRole("heading", { name: "텍스트 윤문", exact: true });
    const inputModes = page.locator(".polish-input-modes");
    const polishModes = page.locator(".polish-modes");
    const pasteLabel = page.locator(".polish-paste").getByText("윤문할 내용을 붙여넣으세요.", { exact: true });
    const paste = page.getByLabel("윤문할 텍스트 입력");
    const count = page.locator(".polish-paste small");
    const action = page.getByRole("button", { name: "윤문 실행" });
    const boxes = await Promise.all([title, inputModes, polishModes, pasteLabel, paste, count, action].map((locator) => locator.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    const left = boxes[0]!.x;
    for (const box of boxes.slice(1, 6)) expect(Math.abs(box!.x - left)).toBeLessThanOrEqual(1);
    return { modes: boxes[2]!, paste: boxes[4]!, action: boxes[6]!, left };
  };

  // Desktop: 실행 follows the style choice it applies, on the same row.
  const desktop = await alignment();
  expect(Math.abs(desktop.action.y + desktop.action.height / 2 - (desktop.modes.y + desktop.modes.height / 2))).toBeLessThanOrEqual(2);
  expect(desktop.action.x - (desktop.modes.x + desktop.modes.width)).toBeGreaterThanOrEqual(8);
  expect(desktop.action.x - (desktop.modes.x + desktop.modes.width)).toBeLessThanOrEqual(24);
  const initialViewport = page.viewportSize();
  expect(desktop.paste.width).toBeGreaterThanOrEqual(initialViewport && initialViewport.width < 1000 ? 600 : 700);
  expect(desktop.paste.width).toBeLessThanOrEqual(960);
  await page.getByLabel("윤문할 텍스트 입력").fill("파일 없이도 텍스트 윤문을 실행할 수 있습니다.");
  await expect(page.getByRole("button", { name: "윤문 실행" })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  // Mobile: 실행 wraps under the options onto the shared left edge.
  const mobile = await alignment();
  expect(Math.abs(mobile.action.x - mobile.left)).toBeLessThanOrEqual(1);
  expect(mobile.paste.width).toBeLessThanOrEqual(358);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps file context and upload controls out of utility destinations", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await navigateWorkspace(page, "Dictionary");

  await expect(page.getByRole("heading", { name: "용어 사전", exact: true })).toBeVisible();
  await expect(page.locator(".notice")).toHaveCount(0);
  await expect(page.locator(".context-files")).toHaveCount(0);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
  await expect(page.getByText("회사 공통 용어입니다. 관리자만 수정할 수 있습니다.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("공용 용어 검색")).toBeVisible();
  await expect(page.getByText("등록된 개인 용어가 없습니다.")).toBeVisible();

  await navigateWorkspace(page, "Settings");
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await expect(page.locator(".notice")).toHaveCount(0);
  await expect(page.locator(".context-files")).toHaveCount(0);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
  await expect(page.locator(".settings-list").getByText("AI 기능은 필요한 질문·문장·근거만 서버 AI로 전송해 처리합니다. 원본 파일은 전송하지 않습니다.", { exact: true })).toBeVisible();
  await expect(page.locator(".settings-list")).not.toContainText("Groq");
  await expect(page.locator(".settings-list")).not.toContainText("Zero Data Retention");
  await expect(page.locator(".settings-list")).not.toContainText("30일");
});

test("keeps legal destinations inside one navigation entry and moves review defaults to Settings", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("worklens:review-preferences:v1", JSON.stringify({
    version: 1, preferences: { documentSource: "text", expandSources: true },
  })));
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true });
  // At 900px and below the sidebar lives in a sheet; open it for nav
  // assertions and close it again so palette steps see a single dialog.
  const narrow = await page.evaluate(() => window.innerWidth <= 900);
  const openMenu = async () => {
    if (narrow) await page.getByRole("button", { name: "작업 공간 메뉴 열기", exact: true }).click();
  };
  const closeSheet = async () => {
    if (narrow) await page.keyboard.press("Escape");
  };

  await openMenu();
  await expect(navigation.getByRole("heading")).toHaveText(["WORKSPACE", "RESEARCH", "TOOLS", "HELP"]);
  await expect(navigation.getByRole("button")).toHaveCount(14);
  for (const hidden of ["판례·결정례", "종합 리서치", "문서 검토", "검토 설정"]) {
    await expect(navigation.getByRole("button", { name: hidden, exact: true })).toHaveCount(0);
  }
  await closeSheet();

  await navigateWorkspace(page, "법령");
  await openMenu();
  await expect(navigation.getByRole("button", { name: "법령", exact: true })).toHaveAttribute("aria-current", "page");
  await closeSheet();
  await expect(page.getByRole("tablist", { name: "법령 자료 유형" }).getByRole("tab")).toHaveText([
    "법령 검색", "판례·결정례", "검증·분석", "종합 리서치",
  ]);

  for (const [command, heading] of [
    ["법령 > 판례·결정례", "판례·결정례"],
    ["법령 > 검증·분석", "검증·분석"],
    ["법령 > 종합 리서치", "종합 리서치"],
    ["법령 > 문서 검토", "문서 검토"],
  ] as const) {
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog").getByText(command, { exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
    await openMenu();
    await expect(navigation.getByRole("button", { name: "법령", exact: true })).toHaveAttribute("aria-current", "page");
    await closeSheet();
  }

  await page.keyboard.press("Control+K");
  await page.getByRole("dialog").getByText("검토 설정", { exact: true }).click();
  await openMenu();
  await expect(navigation.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  await closeSheet();
  await expect(page.getByRole("heading", { name: "법령 리서치 기본값", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "직접 입력", exact: true })).toBeChecked();
  await expect(page.getByRole("switch", { name: "출처 내용을 펼쳐서 표시", exact: true })).toBeChecked();
});

test("uses task-focused labels and concise execution buttons", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();

  const labels = [
    ["분석", "문서 분석"],
    ["질문", "질문하기"],
    ["비교", "파일 비교"],
    ["검수", "문서 검수"],
    ["보완", "문서 보완"],
    ["윤문", "문서 윤문"],
    ["추출", "정보 추출"],
    ["취합", "문서 취합"],
  ] as const;
  for (const [tab, title] of labels) {
    await navigateWorkspace(page, tab);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const run = page.getByRole("button", { name: `${tab} 실행`, exact: true });
    await expect(run).toBeVisible();
    await expect(run).toHaveText("실행");
    await expect(page.locator(".operation-actions").getByRole("button")).toHaveCount(tab === "추출" ? 0 : 1);
  }
  for (const removed of ["심층 분석", "의미 비교", "문장 검수"]) {
    await expect(page.getByRole("button", { name: removed, exact: true })).toHaveCount(0);
  }
});

test("aligns the Admin login action with the password field", async ({ page }) => {
  await page.goto("/admin");
  // The visible field box is the coss control wrapper around the native input.
  const password = page.locator(".admin-login [data-slot='input-control']").filter({ has: page.getByLabel("관리자 비밀번호") });
  const login = page.getByRole("button", { name: "로그인", exact: true });
  await expect(password).toBeVisible();
  await expect(login).toBeVisible();
  const desktop = await Promise.all([password.boundingBox(), login.boundingBox()]);
  expect(desktop[0]).not.toBeNull();
  expect(desktop[1]).not.toBeNull();
  expect(desktop[1]?.x).toBe(desktop[0]?.x);
  expect(desktop[1]?.width).toBe(desktop[0]?.width);
  expect(await login.evaluate((element) => ({
    align: getComputedStyle(element).alignItems,
    justify: getComputedStyle(element).justifyContent,
  }))).toEqual({ align: "center", justify: "center" });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await Promise.all([password.boundingBox(), login.boundingBox()]);
  expect(mobile[1]?.x).toBe(mobile[0]?.x);
  expect(mobile[1]?.width).toBe(mobile[0]?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps a feature's completion notice inside that feature", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석.*완료/);

  // Another feature, the dictionary and the settings page own their own
  // status, so an Analyze result never announces itself there.
  for (const destination of ["검수", "Dictionary", "Settings"]) {
    await navigateWorkspace(page, destination);
    await expect(page.locator(".notice")).toHaveCount(0);
  }

  // Workspace-wide upload errors also stay in document work views.
  await navigateWorkspace(page, "분석");
  await sendFile(page, files.fake);
  await expect(page.locator(".notice.error")).toBeVisible();
  await navigateWorkspace(page, "Settings");
  await expect(page.locator(".notice")).toHaveCount(0);

  await page.goto("/admin");
  await expect(page.locator(".notice")).toHaveCount(0);
});

test("rejects a disguised file with an actionable message", async ({ page }) => {
  await page.goto("/");
  await sendFile(page, files.fake);
  await expect(page.locator(".notice.error")).toContainText("파일 확장자와 실제 내용이 일치하지 않습니다");
  await expect(page.locator(".dropzone")).toBeVisible();
});

test("keeps original files inside the tab and sends only bounded evidence", async ({ page, browser }) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석.*완료/);

  // Parsing and deterministic analysis stay in the browser worker. Only the
  // bounded evidence window uses the same-origin server route.
  expect([...new Set(apiCalls)]).toEqual(["/api/company-terms", "/api/ai"]);
  const stored = await page.evaluate(() => ({
    cookies: document.cookie,
    local: Object.keys(localStorage).length,
    session: Object.keys(sessionStorage).length,
  }));
  expect(stored).toEqual({ cookies: "", local: 0, session: 0 });

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto("/");
  await expect(otherPage.locator(".dropzone")).toBeVisible();
  await otherContext.close();
});

test("keeps browser requests on the same origin during integrated work", async ({ page }) => {
  const hosts: string[] = [];
  page.on("request", (request) => hosts.push(new URL(request.url()).host));
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");

  // Enrichment uses only the same-origin server route; the browser never
  // fetches model assets or contacts a third-party host.
  const origin = new URL(page.url()).host;
  expect([...new Set(hosts)]).toEqual([origin]);
});

test("meets serious accessibility checks and exposes keyboard focus", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test("meets accessibility and keyboard requirements in the populated compare/source state", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();

  const changeTable = page.locator(".change-table");
  await expect(changeTable).toHaveAttribute("role", "table");
  await expect(changeTable.locator('[role="row"]').first()).toBeVisible();
  await expect(changeTable.locator('[role="columnheader"]').first()).toBeVisible();
  await expect(changeTable.locator('[role="cell"]').first()).toBeVisible();

  // Enrichment keeps the run controls busy for a moment after the table
  // appears; scanning mid-run measures a transient state, not the UI.
  await expect(page.getByRole("button", { name: "비교 실행" })).toBeEnabled();

  const results = await new AxeBuilder({ page }).include(".workspace").analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);

  // Keyboard-only: open Source detail and confirm focus moves into the panel,
  // then close it and confirm focus returns to the invoking control.
  const sourceButton = page.locator(".source-action").first();
  await sourceButton.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByLabel("근거 상세");
  await expect(detail).toBeVisible();
  await expect(detail).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(detail).toHaveCount(0);
  await expect(sourceButton).toBeFocused();

  // Keyboard focus must remain visible on the interactive checkbox.
  const checkbox = page.locator(".select-file").getByRole("checkbox").first();
  const restingShadow = await checkbox.evaluate((element) => getComputedStyle(element).boxShadow);
  await checkbox.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(checkbox).toBeFocused();
  // The focus ring animates in; poll until it settles rather than reading the first frame.
  await expect.poll(() => checkbox.evaluate((element, resting) => {
    const style = getComputedStyle(element);
    return (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none")
      || (style.boxShadow !== "none" && style.boxShadow !== resting);
  }, restingShadow)).toBe(true);
});

test("discards every file and result when the tab reloads", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석.*완료/);
  await page.locator(".results-panel .source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toBeVisible();

  await page.reload();

  await expect(page.locator(".dropzone")).toBeVisible();
  await expect(page.getByText("운임현황_v1.xlsx")).toHaveCount(0);
  await expect(page.locator(".results-panel")).toHaveCount(0);
  await expect(page.getByLabel("근거 상세")).toHaveCount(0);
});

test("explicitly clears the in-browser workspace", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("button", { name: "모두 삭제" }).click();
  await page.getByRole("alertdialog", { name: "작업 파일 모두 삭제", exact: true })
    .getByRole("button", { name: "삭제", exact: true }).click();
  const clearedStatus = page.locator(".transient-status");
  await expect(clearedStatus).toHaveText("삭제 완료");
  await expect(page.getByText("브라우저 메모리에서 파일과 결과를 모두 지웠습니다.")).toHaveCount(0);
  await expect(page.locator(".notice-inline")).toHaveCount(0);
  // A one-off result: it clears itself.
  await expect(clearedStatus).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator(".status-panel")).toHaveCount(0);
  await expect(page.getByText("처리 상태", { exact: true })).toHaveCount(0);
  await expect(page.locator(".dropzone")).toBeVisible();

  // The worker was torn down; a new upload must still work in the same tab.
  await upload(page, files.v2);
  await expect(fileRow(page, files.v2)).toContainText("시트: 1");
});

test("keeps the complete mobile workflow inside the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "One Chromium run covers the explicit mobile viewports.");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const expectNoPageOverflow = async () => {
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  };
  await mockEmptyClaims(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "요약", exact: true })).toHaveCount(0);
  await upload(page, files.v1);
  await upload(page, files.v2);
  await upload(page, files.checkPptx);
  await upload(page, files.extractPptx);

  const firstRow = fileRow(page, files.v1);
  await expect(firstRow.locator(".status")).toBeVisible();
  await expect(firstRow.locator(".structure-counts")).toBeVisible();
  await expect(firstRow.locator(".muted").last()).toBeVisible();
  await expectNoPageOverflow();
  await page.screenshot({ path: "artifacts/mobile-file-workflow-390.png", fullPage: true });

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await expect(fileRow(page, files.v1).getByText("1 · 기준 파일", { exact: true })).toBeVisible();
  await expect(fileRow(page, files.v2).getByText("2 · 대상 파일", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  const comparisonWidths = await page.locator(".change-table").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(comparisonWidths.scroll).toBeLessThanOrEqual(comparisonWidths.client);
  expect(await page.getByTestId("change-row").first().evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(1);
  await expectNoPageOverflow();

  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  const mobileFinding = page.locator(".check-issue").first();
  await expect(mobileFinding).toBeVisible();
  await expect(mobileFinding.locator(".check-issue-name")).toBeVisible();
  await expect(mobileFinding.locator(".check-source")).toBeVisible();
  await expectNoPageOverflow();
  await page.screenshot({ path: "artifacts/mobile-check-390.png", fullPage: true });
  await mobileFinding.locator(".source-action").click();
  const mobileEvidence = page.getByLabel("근거 상세");
  await expect(mobileEvidence).toBeVisible();
  const evidenceShell = page.locator(".evidence-inspector");
  expect(await evidenceShell.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  const evidenceBox = await evidenceShell.boundingBox();
  expect(evidenceBox).not.toBeNull();
  expect(evidenceBox!.width).toBeLessThanOrEqual(390);
  await expect(mobileEvidence.locator(".evidence-location-list")).toBeVisible();
  await expect(mobileEvidence.getByRole("button", { name: "닫기" })).toBeVisible();
  await page.screenshot({ path: "artifacts/inspo-evidence-mobile-390.png" });
  await mobileEvidence.getByRole("button", { name: "닫기" }).click();
  await expect(mobileFinding.locator(".source-action")).toBeFocused();
  await expectNoPageOverflow();

  await navigateWorkspace(page, "질문");
  const askInput = page.getByLabel("질문 입력");
  const askAction = page.getByRole("button", { name: "질문 실행" });
  const [askBox, actionBox] = await Promise.all([askInput.boundingBox(), askAction.boundingBox()]);
  expect(askBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThan(askBox!.y + askBox!.height);

  await navigateWorkspace(page, "윤문");
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const paste = page.getByLabel("윤문할 텍스트 입력");
  await expect(paste).toBeVisible();
  expect((await paste.boundingBox())!.width).toBeLessThanOrEqual(358);

  await navigateWorkspace(page, "추출");
  await page.getByRole("checkbox", { name: "최종검수.pptx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "회의자료.pptx 선택", exact: true }).check();
  await page.getByRole("button", { name: "추출 실행" }).click();
  const mobileExtract = page.locator(".extract-results");
  const mobileExtractTable = mobileExtract.locator(".extract-auto-table");
  await expect(mobileExtractTable).toBeVisible();
  await expect(mobileExtract.getByRole("button", { name: "표 보기" })).toHaveCount(0);
  await expect(mobileExtract.getByRole("button", { name: "항목 보기" })).toHaveCount(0);
  const mobileExtractRow = mobileExtractTable.locator(".data-row").first();
  expect(await mobileExtractRow.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(1);
  const mobileExports = mobileExtract.locator(".extract-export-actions");
  await expect(mobileExports.getByRole("button")).toHaveText(["CSV 다운로드", "XLSX 다운로드"]);
  const [csvStyle, xlsxStyle] = await mobileExports.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    const box = button.getBoundingClientRect();
    return { background: style.backgroundColor, left: box.left, right: box.right };
  }));
  expect(csvStyle.background).toBe("rgb(255, 255, 255)");
  expect(xlsxStyle.background).not.toBe(csvStyle.background);
  expect(csvStyle.left).toBeGreaterThanOrEqual(0);
  expect(xlsxStyle.right).toBeLessThanOrEqual(390);
  await expectNoPageOverflow();
  await page.screenshot({ path: "artifacts/inspo-extract-mobile-390.png", fullPage: true });

  await navigateWorkspace(page, "Dictionary");
  await expect(page.locator(".settings-surface[aria-label='Dictionary']")).toBeVisible();
  await expectNoPageOverflow();

  await navigateWorkspace(page, "Settings");
  const settingsRow = page.locator(".settings-list > div").first();
  const [settingsLabel, settingsDescription] = await Promise.all([
    settingsRow.locator("dt").boundingBox(),
    settingsRow.locator("dd").boundingBox(),
  ]);
  expect(settingsDescription!.y).toBeGreaterThanOrEqual(settingsLabel!.y + settingsLabel!.height);
  await expect(page.locator(".notice")).toHaveCount(0);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expectNoPageOverflow();
    for (const destination of ["분석", "질문", "비교", "검수", "윤문", "추출", "Dictionary", "Settings"]) {
      await navigateWorkspace(page, destination);
      await expectNoPageOverflow();
    }
    await page.getByRole("button", { name: "작업 공간 메뉴 열기", exact: true }).click();
    const clippedNavItems = await page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true })
      .getByRole("button").evaluateAll((items) =>
        items.filter((item) => item.scrollWidth > item.clientWidth || item.scrollHeight > item.clientHeight).length);
    expect(clippedNavItems).toBe(0);
    await page.getByRole("button", { name: "메뉴 닫기", exact: true }).click();
  }
  expect(consoleErrors).toEqual([]);
});

test("aligns every workspace category to the file-list boundary", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();

  const assertSharedBoundary = async () => {
    const boxes = await page.locator(".file-list, .work-section-heading, .operation-bar").evaluateAll((elements) =>
      elements.slice(0, 3).map((element) => {
        const box = element.getBoundingClientRect();
        return { left: Math.round(box.left), right: Math.round(box.right) };
      }));
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.left === boxes[0].left)).toBe(true);
    expect(boxes.every((box) => box.right === boxes[0].right)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };

  for (const destination of ["분석", "질문", "비교", "검수", "윤문", "추출", "취합"]) {
    await navigateWorkspace(page, destination);
    await assertSharedBoundary();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const destination of ["분석", "질문", "비교", "검수", "윤문", "추출", "취합"]) {
    await navigateWorkspace(page, destination);
    await assertSharedBoundary();
  }
});

test("keeps compare column rules aligned and numeric values right-aligned", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();

  // A rule that drifts by a pixel between header and body reads as a broken
  // column, so the two share one grid definition and are checked together.
  const rules = await page.evaluate(() => {
    const edges = (cells: HTMLElement[]) => cells.slice(0, -1).map((cell) => Math.round(cell.getBoundingClientRect().right));
    const headCells = [...document.querySelectorAll<HTMLElement>(".change-head > span")];
    const rowCells = [...document.querySelectorAll<HTMLElement>('[data-testid="change-row"]')[0].children] as HTMLElement[];
    return {
      head: edges(headCells),
      row: edges(rowCells),
      headBorders: headCells.map((cell) => getComputedStyle(cell).borderRightWidth),
      rowBorders: rowCells.map((cell) => getComputedStyle(cell).borderRightWidth),
    };
  });
  expect(rules.head).toHaveLength(4);
  expect(rules.row).toEqual(rules.head);
  expect(rules.headBorders).toEqual(["1px", "1px", "1px", "1px", "0px"]);
  expect(rules.rowBorders).toEqual(["1px", "1px", "1px", "1px", "0px"]);

  // Headers and evidence are prose. Numeric values and the delta body alone
  // read from the right.
  const alignment = await page.evaluate(() => {
    const cells = [
      [...document.querySelectorAll(".change-head > span")],
      [...document.querySelectorAll('[data-testid="change-row"]')[0].children],
    ];
    const [head, row] = cells.map((group) => group.map((cell) => {
      const value = getComputedStyle(cell as HTMLElement).textAlign;
      return value === "start" ? "left" : value === "end" ? "right" : value;
    }));
    const sourceCell = document.querySelector<HTMLElement>('[data-testid="change-row"] > .source-actions')!;
    const sourceGroup = sourceCell.querySelector<HTMLElement>(".result-source")!;
    const locator = sourceGroup.querySelector<HTMLElement>(".source-locator")!.getBoundingClientRect();
    const action = sourceGroup.querySelector<HTMLElement>(".source-action")!.getBoundingClientRect();
    const sameLine = Math.abs((locator.top + locator.bottom) / 2 - (action.top + action.bottom) / 2) <= 2;
    const headerCells = [...document.querySelectorAll<HTMLElement>(".change-head > span")];
    const bodyCells = [...document.querySelectorAll<HTMLElement>('[data-testid="change-row"]')[0].children];
    return {
      head,
      row,
      source: {
        cellAlign: getComputedStyle(sourceCell).alignItems,
        cellText: getComputedStyle(sourceCell).textAlign,
        groupAlign: getComputedStyle(sourceGroup).alignSelf,
        groupJustify: getComputedStyle(sourceGroup).justifyContent,
        cellJustify: getComputedStyle(sourceCell).justifyContent,
        groupItems: getComputedStyle(sourceGroup).alignItems,
        childAlign: [
          getComputedStyle(sourceGroup.querySelector<HTMLElement>(".source-locator")!).alignSelf,
          getComputedStyle(sourceGroup.querySelector<HTMLElement>(".source-action")!).alignSelf,
        ],
        actionFollowsLocator: sameLine
          ? action.left >= locator.right - 1
          : Math.abs(action.left - locator.left) <= 1,
      },
      vertical: {
        headerAlign: headerCells.map((cell) => getComputedStyle(cell).alignSelf),
        headerMiddle: headerCells.map((cell) => getComputedStyle(cell).verticalAlign),
        bodyJustify: bodyCells.map((cell) => getComputedStyle(cell).justifyContent),
      },
    };
  });
  expect(alignment.head).toEqual(["left", "left", "left", "left", "left"]);
  expect(alignment.row).toEqual(["left", "right", "right", "right", "left"]);
  expect(alignment.source).toEqual({
    cellAlign: "flex-start",
    cellText: "left",
    cellJustify: "center",
    groupItems: "center",
    childAlign: ["auto", "auto"],
    groupAlign: "flex-start",
    groupJustify: "flex-start",
    actionFollowsLocator: true,
  });
  expect(alignment.vertical).toEqual({
    headerAlign: ["center", "center", "center", "center", "center"],
    headerMiddle: ["middle", "middle", "middle", "middle", "middle"],
    bodyJustify: ["center", "center", "center", "center", "center"],
  });
  expect(await page.locator(".change-row > .change-delta").first().evaluate((element) => getComputedStyle(element).justifyItems)).toBe("end");

  // The reading order is file pair, then summary, then table: each band keeps
  // its own tone instead of one flat white sheet.
  const tones = await page.evaluate(() => {
    const read = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
    return [read(".comparison-file-map > div"), read(".executive-summary"), read(".summary-total"), read(".change-head"), read(".change-row")];
  });
  expect(new Set(tones).size).toBe(4);
  expect(tones[0]).toBe("rgb(255, 255, 255)");
  expect(tones[4]).toBe("rgb(255, 255, 255)");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.getByTestId("change-row").first().locator("> span").first()
    .evaluate((element) => getComputedStyle(element).borderRightWidth)).toBe("0px");
});
test("aligns mixed comparison values by their actual type", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.alignmentA);
  await upload(page, files.alignmentB);
  await page.getByRole("checkbox", { name: "정렬기준_A.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "정렬기준_B.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();

  const alignmentFor = async (text: string) => {
    const row = page.getByTestId("change-row").filter({ hasText: text }).first();
    await expect(row).toBeVisible();
    return row.locator('[data-label="대상 파일 값"]').evaluate((cell) => getComputedStyle(cell).textAlign);
  };

  expect(await alignmentFor("2026.09.30 14:00")).toBe("left");
  expect(await alignmentFor("3층 대회의실")).toBe("left");
  expect(await alignmentFor("이도윤")).toBe("left");
  expect(await alignmentFor("2,258,000원")).toBe("right");
  expect(await alignmentFor("75명")).toBe("right");
  expect(await page.locator(".change-row > .change-delta").evaluateAll((cells) =>
    cells.every((cell) => getComputedStyle(cell).textAlign === "right"))).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("shows the same continued R sequence in preview and the downloaded workbook", async ({ page }) => {
  await page.goto("/");
  for (const [name, numbers] of [
    ["기준.xlsx", ["BP-08-01", "BP-08-02", "BP-08-03"]],
    ["추가.xlsx", ["BP-08-01", "", "BP-08-02"]],
  ] as const) {
    const bytes = await createXlsx({ "개선 Bank": [
      ["R", "내용", "상태"],
      ...numbers.map((number, index) => [number, `${name} ${index + 1}`, "진행"]),
    ] });
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(bytes) });
    await expect(page.locator(".file-row").filter({ hasText: name })).toBeVisible();
    await page.getByRole("checkbox", { name: `${name} 선택`, exact: true }).check();
  }
  await navigateWorkspace(page, "취합");
  await page.getByRole("button", { name: "취합 실행" }).click();
  const preview = page.getByRole("region", { name: "개선 Bank 미리보기" }).locator(".aggregation-preview tbody tr td:first-child");
  const expected = ["BP-08-01", "BP-08-02", "BP-08-03", "BP-08-04", "BP-08-05", "BP-08-06"];
  await expect(preview).toHaveText(expected);
  await page.screenshot({ path: "artifacts/aggregation-sequence-preview.png", fullPage: true });
  const download = page.waitForEvent("download");
  await page.locator(".aggregation-results").getByRole("button", { name: "XLSX 다운로드" }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await readFile(await (await download).path())) as unknown as ExcelJS.Buffer);
  expect(expected.map((_, index) => workbook.getWorksheet("개선 Bank")!.getCell(index + 2, 1).value)).toEqual(expected);
});

test("aggregates workbooks into one XLSX result without profile-specific actions", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "운임현황_v2.xlsx 선택", exact: true }).check();
  await navigateWorkspace(page, "비교");
  const comparisonBadge = fileRow(page, files.v1).locator(".compare-selection-role");
  const appearance = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.border, style.borderRadius, style.color, style.fontFamily, style.fontSize, style.padding];
  };
  const expectedAppearance = await comparisonBadge.evaluate(appearance);
  await navigateWorkspace(page, "취합");
  const first = fileRow(page, files.v1);
  const second = fileRow(page, files.v2);
  await expect(first.locator(".compare-selection-role")).toHaveText("기준 파일");
  expect(await first.locator(".compare-selection-role").evaluate(appearance)).toEqual(expectedAppearance);
  await expect(second.locator(".compare-selection-role")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "기준/대상 바꾸기" })).toHaveCount(0);
  await expect(first).not.toContainText("1 ·");
  await page.getByRole("button", { name: "취합 실행" }).click();

  const panel = page.locator(".aggregation-results");

  await expect(panel.locator(".result-status")).toHaveText("취합 완료");
  await expect(panel.getByRole("button", { name: "XLSX 다운로드" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /PPTX 다운로드/ })).toHaveCount(0);
  await expect(panel).not.toContainText("개선 Bank");
  await expect(panel).not.toContainText("Backdata");
  await expect(panel).not.toContainText("스키마 그룹");
  await expect(panel).not.toContainText("호환 그룹");
  await expect(panel.getByRole("heading", { name: /결과 시트 \d+개/ })).toBeVisible();
  await expect(panel.locator(".aggregation-result-sheets li strong")).toHaveText(["운송단가"]);
  await expect(panel).toContainText("모든 항목을 기준 파일 항목에 자동으로 연결했습니다.");
  await expect(panel.locator(".aggregation-preview thead th").first()).toHaveText("지역");
  await expect(panel.locator(".aggregation-preview")).not.toContainText("[object");
  const fileBox = await page.locator(".file-list").boundingBox();
  const summaryBox = await panel.locator(".check-summary-line").boundingBox();
  const downloadBox = await panel.getByRole("button", { name: "XLSX 다운로드" }).boundingBox();
  const sectionBox = await panel.locator(".aggregation-section").first().boundingBox();
  const headingBox = await panel.getByRole("heading", { name: "취합할 시트" }).boundingBox();
  const descriptionBox = await panel.getByText("첫 번째 파일의 시트 구성을 결과로 사용하고").boundingBox();
  const listBox = await panel.locator(".aggregation-workbooks").boundingBox();
  expect(fileBox && summaryBox && downloadBox && sectionBox && headingBox && descriptionBox && listBox).toBeTruthy();
  expect(summaryBox!.x).toBe(fileBox!.x);
  expect(downloadBox!.x + downloadBox!.width).toBe(fileBox!.x + fileBox!.width);
  expect(sectionBox!.x).toBe(fileBox!.x);
  expect(sectionBox!.width).toBe(fileBox!.width);
  expect(headingBox!.x).toBe(fileBox!.x);
  expect(descriptionBox!.x).toBe(fileBox!.x);
  expect(listBox!.x).toBe(fileBox!.x);
  // Outer layout stays flat on the canvas; only data blocks carry a white surface.
  const surfaces = await panel.evaluate((element) => {
    const background = (selector: string) => getComputedStyle(element.querySelector(selector) ?? element).backgroundColor;
    return {
      panel: getComputedStyle(element).backgroundColor,
      heading: background(".result-heading"),
      toolbar: background(".aggregation-result-toolbar"),
      section: background(".aggregation-section"),
      sectionRadius: getComputedStyle(element.querySelector(".aggregation-section")!).borderRadius,
      workbook: background(".aggregation-workbook"),
      table: background(".aggregation-preview-wrap"),
    };
  });
  expect(surfaces).toEqual({
    panel: "rgba(0, 0, 0, 0)",
    heading: "rgba(0, 0, 0, 0)",
    toolbar: "rgba(0, 0, 0, 0)",
    section: "rgba(0, 0, 0, 0)",
    sectionRadius: "0px",
    workbook: "rgb(255, 255, 255)",
    table: "rgb(255, 255, 255)",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole("button", { name: "XLSX 다운로드" })).toBeVisible();
  await expect(panel.locator(".aggregation-workbooks")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await download).suggestedFilename()).toBe("worklens-aggregation.xlsx");
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).uncheck();
  await expect(second.locator(".compare-selection-role")).toHaveText("기준 파일");
  await expect(first.locator(".compare-selection-role")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "전체 선택 해제", exact: true }).uncheck();
  await expect(page.locator(".file-row .compare-selection-role")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await expect(first.locator(".compare-selection-role")).toHaveText("기준 파일");
  await expect(second.locator(".compare-selection-role")).toHaveCount(0);
});

test("blocks unsupported files from aggregation without offering PPTX export", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.trainingSepPptx);
  await page.getByRole("checkbox", { name: "WL_교육운영_9월.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "취합");

  await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
  await expect(page.getByText("Excel이 아닌 파일이 포함되어 있습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("Excel 파일만 취합할 수 있습니다. 해당 파일을 선택 해제한 후 다시 실행해 주세요.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Excel·CSV/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /PPTX 다운로드/ })).toHaveCount(0);
});

test("does not silently aggregate supported files from a mixed selection", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.trainingSepPptx);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "WL_교육운영_9월.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "취합");

  await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
  await expect(page.getByText("Excel이 아닌 파일이 포함되어 있습니다.", { exact: true })).toBeVisible();
  await expect(page.locator(".aggregation-results")).toHaveCount(0);
});

test("keeps CSV out of aggregation while other features still accept it", async ({ page }) => {
  await mockEmptyClaims(page);
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.csv);
  await page.getByRole("checkbox", { name: "운임.csv 선택", exact: true }).check();
  await navigateWorkspace(page, "취합");

  // CSV alone: nothing to aggregate.
  await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
  await expect(page.getByText("Excel이 아닌 파일이 포함되어 있습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("Excel 파일만 취합할 수 있습니다. 해당 파일을 선택 해제한 후 다시 실행해 주세요.", { exact: true })).toBeVisible();

  // Workbook plus CSV: the workbook is not aggregated behind the user's back.
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
  await expect(page.locator(".aggregation-results")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Excel이 아닌 파일이 포함되어 있습니다.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Deselecting the CSV restores the run.
  await page.getByRole("checkbox", { name: "운임.csv 선택", exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "취합 실행" })).toBeEnabled();

  // The same CSV still works in the rest of WorkLens.
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "운임.csv 선택", exact: true }).check();
  await navigateWorkspace(page, "분석");
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석 완료/);
});

for (const [format, file] of [["PDF", files.pdf], ["DOCX", files.docx]] as const) {
  test(`blocks ${format} files from aggregation`, async ({ page }) => {
    await mockEmptyClaims(page);
    await page.goto("/");
    await upload(page, file);
    await page.getByRole("checkbox", { name: `${path.basename(file)} 선택`, exact: true }).check();
    await navigateWorkspace(page, "취합");

    await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
    await expect(page.getByText("Excel이 아닌 파일이 포함되어 있습니다.", { exact: true })).toBeVisible();
  });
}

test("keeps selected files and reports a worker deletion failure", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        const envelope = message as { id: string; request: { kind: string } };
        if (envelope.request.kind === "forget") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: { id: envelope.id, ok: false, error: { code: "WORKER_FAILED", message: "unavailable" } },
          })));
          return;
        }
        super.postMessage(message, options as StructuredSerializeOptions);
      }
    };
  });
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await expect(page.locator(".notice.error")).toContainText("선택한 파일을 삭제하지 못했습니다.");
  await expect(page.getByRole("checkbox", { name: "운임현황_v1.xlsx 선택", exact: true })).toBeChecked();
  await expect(page.locator(".transient-status")).toHaveCount(0);
});

test("shows incomplete AI extraction without discarding deterministic fields", async ({ page }) => {
  await page.route("**/api/ai", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "unavailable" } }),
  }));
  await page.goto("/");
  await upload(page, files.extractPptx);
  await page.getByRole("checkbox", { name: "회의자료.pptx 선택", exact: true }).check();
  await navigateWorkspace(page, "추출");
  await page.getByRole("radio", { name: "항목 지정" }).check();
  await page.getByLabel("추출할 항목").fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.getByRole("status").filter({ hasText: "AI 항목 확인이 중단되어 나머지 항목은 확인하지 못했습니다." })).toBeVisible();
  await expect(page.locator(".extract-results")).toContainText("찾지 못함");
});

async function runSupplementOn(page: Page, deck: string) {
  await upload(page, deck);
  await page.getByRole("checkbox", { name: `${path.basename(deck)} 선택`, exact: true }).check();
  await navigateWorkspace(page, "보완");
  await page.getByRole("button", { name: "보완 실행" }).click();
}

test("보완 waits out a rate-limited re-check and still completes it, on desktop and mobile", async ({ page }) => {
  const deck = path.join(FIXTURE_DIR, "보완_재시도.pptx");
  await writeFile(deck, createPptxSlides([["2026년 9월 비용 보고", "운영 현황"], ["비용 현황", "물류비가 전월 대비 18% 증가했습니다."]]));
  let calls = 0;
  await page.route("**/api/ai", (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill({ status: 429, headers: { "Retry-After": "0" }, contentType: "application/json",
        body: JSON.stringify({ error: { code: "AI_RATE_LIMITED", message: "AI 사용 한도에 도달했습니다." } }) });
    }
    const { checks } = route.request().postDataJSON() as { checks: Array<{ id: string }> };
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ data: { kind: "supplement-review", verdicts: checks.map(({ id }) => ({ id, verdict: "not_found", handles: [] })) } }) });
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    calls = 0;
    await page.setViewportSize(viewport);
    await page.goto("/");
    await runSupplementOn(page, deck);
    const results = page.locator(".supplement-results");
    await expect(results.locator(".supplement-item")).toContainText("원인 설명 확인 필요");
    // The first answer was a 429; the batch was retried, so the re-check is complete, not partial.
    expect(calls).toBe(2);
    await expect(page.getByText("일부 항목의 재확인을 완료하지 못했습니다.")).toHaveCount(0);
    await expect(results).not.toContainText("의미 기반 재확인을 마치지 못했습니다");
    // Title, summary text and the white meta box start on one line; nothing overflows.
    const lines = await page.evaluate(() => {
      const textLeft = (selector: string) => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(selector)!);
        return Math.round(range.getClientRects()[0].left);
      };
      return { title: textLeft(".results-panel h2"), filters: textLeft(".supplement-filters button"), box: Math.round(document.querySelector(".supplement-meta")!.getBoundingClientRect().left) };
    });
    expect(new Set(Object.values(lines)).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("보완 gives up after three rate-limited attempts and says the re-check is partial", async ({ page }) => {
  const deck = path.join(FIXTURE_DIR, "보완_한도.pptx");
  await writeFile(deck, createPptxSlides([["2026년 9월 비용 보고", "운영 현황"], ["비용 현황", "물류비가 전월 대비 18% 증가했습니다."]]));
  let calls = 0;
  await page.route("**/api/ai", (route) => {
    calls += 1;
    return route.fulfill({ status: 429, headers: { "Retry-After": "0" }, contentType: "application/json",
      body: JSON.stringify({ error: { code: "AI_RATE_LIMITED", message: "AI 사용 한도에 도달했습니다." } }) });
  });
  await page.goto("/");
  await runSupplementOn(page, deck);
  await expect(page.getByText("일부 항목의 재확인을 완료하지 못했습니다.")).toBeVisible({ timeout: 20_000 });
  expect(calls).toBe(3);
  await expect(page.locator(".supplement-item")).toContainText("원인 설명 확인 필요");
});
