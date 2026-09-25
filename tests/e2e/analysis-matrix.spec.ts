import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { createUnicodePdf, createPptxSlides, createXlsx } from "../fixtures";

/**
 * Analyze through the real UI: upload, select, run, read each section and
 * open 근거 보기. Only /api/ai is mocked; parsing, deterministic analysis,
 * evidence selection, grounding and presentation run in the browser worker.
 */
type Item = { handle: string; text: string };
type Claim = { text: string; evidence: RegExp[]; role: "summary" | "insight"; confidence?: "high" | "medium" | "low" };

const MIME = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function upload(page: Page, files: Array<{ name: string; bytes: Uint8Array; mime: string }>) {
  await page.locator('input[type="file"]').setInputFiles(files.map((file) => ({ name: file.name, mimeType: file.mime, buffer: Buffer.from(file.bytes) })));
  for (const file of files) {
    const row = page.locator(".file-row").filter({ hasText: file.name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("ready");
    await row.getByRole("checkbox").check();
  }
}

async function analyze(page: Page) {
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await page.getByRole("button", { name: "분석 실행" }).click();
  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "분석 결과" })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText(/분석 완료/u);
  return panel;
}

/** Answers the Analyze request with claims citing real shortlisted handles. */
async function mockClaims(page: Page, claims: Claim[] | ((items: Item[]) => unknown[])) {
  await page.route("**/api/ai", async (route: Route) => {
    const body = route.request().postDataJSON() as { items: Item[] };
    const resolved = typeof claims === "function" ? claims(body.items) : claims.map((claim) => ({
      text: claim.text,
      handles: claim.evidence.map((pattern) => {
        const item = body.items.find((candidate) => pattern.test(candidate.text));
        if (!item) throw new Error(`not shortlisted: ${pattern}`);
        return item.handle;
      }),
      confidence: claim.confidence ?? "high",
      presentation: { role: claim.role },
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: resolved } }) });
  });
}

async function openEvidence(page: Page, action: Locator) {
  await action.click();
  const drawer = page.getByRole("complementary", { name: "근거 상세" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function closeEvidence(page: Page) {
  await page.getByRole("complementary", { name: "근거 상세" }).getByRole("button", { name: "닫기" }).click();
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

const reportPdf = () => createUnicodePdf([
  [{ text: "하반기 운영 보고", size: 16 }, { text: "이 보고서는 하반기 배송 운영의 개선 결과를 정리합니다." }],
  [{ text: "결과", size: 16 }, { text: "자동 배차 도입 후 평균 배송 시간이 3일에서 2일로 감소했습니다." }, { text: "단, 도서 산간 지역은 기존 일정을 유지합니다." }],
  [{ text: "계획", size: 16 }, { text: "결론적으로 내년 1월부터 모든 센터에 자동 배차를 적용합니다." }],
]);

const kpiWorkbook = () => createXlsx({
  "3분기 영업본부 부서별 실적 현황": [["부서", "목표", "실적"], ["영업1팀", 100, 90], ["영업2팀", 200, 220]],
  요약: [["항목", "값"], ["총 매출", "1,234,000원"], ["전체 달성률", "103%"], ["신규 거래처", 12]],
});

const deck = () => createPptxSlides([
  ["2026 물류 개선 보고", "경영지원팀"],
  ["현황", "출고 오류율은 월 2.4%로 목표 1%를 넘었습니다."],
  ["결론", "10월부터 바코드 검수를 전 센터에 의무화합니다."],
]);

test.describe("Analyze browser matrix", () => {
  test("E2E-PDF Korean report: summary evidence opens the exact page and quote", async ({ page }) => {
    await mockClaims(page, [
      { text: "자동 배차 도입 후 평균 배송 시간이 3일에서 2일로 감소했습니다.", evidence: [/평균 배송 시간/u], role: "summary" },
      { text: "내년 1월부터 모든 센터에 자동 배차를 적용합니다.", evidence: [/내년 1월부터/u], role: "summary" },
    ]);
    await page.goto("/");
    await upload(page, [{ name: "하반기 운영 보고.pdf", bytes: await reportPdf(), mime: MIME.pdf }]);
    const panel = await analyze(page);
    await expect(panel.locator(".analysis-summary-section .analysis-reading-row")).toHaveCount(2);
    await expect(panel.locator(".analysis-core-items-section")).toContainText("도서 산간 지역은 기존 일정을 유지");
    const drawer = await openEvidence(page, panel.locator(".analysis-summary-section .source-action").first());
    await expect(drawer).toContainText("하반기 운영 보고.pdf");
    await expect(drawer).toContainText("Page 2");
    await expect(drawer).toContainText("평균 배송 시간이 3일에서 2일로 감소했습니다.");
  });

  test("E2E-XLSX workbook with a long sheet name: metric evidence names the sheet and exact cell", async ({ page }) => {
    await mockClaims(page, [{ text: "영업2팀 실적 220은 목표 200을 초과했습니다.", evidence: [/영업2팀 실적 · 220/u, /영업2팀 목표 · 200/u], role: "insight" }]);
    await page.goto("/");
    await upload(page, [{ name: "부서 실적.xlsx", bytes: await kpiWorkbook(), mime: MIME.xlsx }]);
    const panel = await analyze(page);
    await expect(panel.locator(".analysis-core-items-section")).toContainText("영업1팀 — 목표: 100 · 실적: 90");
    const row = panel.locator(".analysis-metric-table tbody tr").filter({ hasText: "총 매출" });
    await expect(row).toContainText("1,234,000원");
    const drawer = await openEvidence(page, row.locator(".source-action"));
    await expect(drawer).toContainText("요약 · B2");
    await expect(drawer).toContainText("1,234,000원");
    await closeEvidence(page);
    const insight = await openEvidence(page, panel.locator(".analysis-insight-section .source-action"));
    await expect(insight).toContainText("3분기 영업본부 부서별 실적 현황 · C3");
    await expect(insight).toContainText("3분기 영업본부 부서별 실적 현황 · B3");
  });

  test("E2E-PPTX deck: content evidence opens the exact slide", async ({ page }) => {
    await mockClaims(page, [{ text: "10월부터 바코드 검수를 전 센터에 의무화합니다.", evidence: [/의무화/u], role: "summary" }]);
    await page.goto("/");
    await upload(page, [{ name: "개선 보고.pptx", bytes: deck(), mime: MIME.pptx }]);
    const panel = await analyze(page);
    const summary = await openEvidence(page, panel.locator(".analysis-summary-section .source-action"));
    await expect(summary).toContainText("Slide 3");
    await closeEvidence(page);
    const content = panel.locator(".analysis-core-items-section .analysis-reading-row").filter({ hasText: "출고 오류율" });
    const drawer = await openEvidence(page, content.locator(".source-action"));
    await expect(drawer).toContainText("Slide 2");
    await expect(drawer).toContainText("출고 오류율은 월 2.4%로 목표 1%를 넘었습니다.");
  });

  test("E2E-MIXED PDF + XLSX + PPTX: items name their file and every evidence opens its own file", async ({ page }) => {
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }));
    await page.goto("/");
    await upload(page, [
      { name: "보고.pdf", bytes: await reportPdf(), mime: MIME.pdf },
      { name: "실적.xlsx", bytes: await kpiWorkbook(), mime: MIME.xlsx },
      { name: "발표.pptx", bytes: deck(), mime: MIME.pptx },
    ]);
    const panel = await analyze(page);
    const rows = panel.locator(".analysis-core-items-section .analysis-reading-row");
    const texts = await rows.locator("p").allTextContents();
    for (const name of ["보고.pdf", "실적.xlsx", "발표.pptx"]) expect(texts.some((text) => text.startsWith(`${name}: `)), texts.join(" | ")).toBe(true);
    for (let index = 0; index < await rows.count(); index += 1) {
      const text = texts[index];
      const file = text.slice(0, text.indexOf(": "));
      const drawer = await openEvidence(page, rows.nth(index).locator(".source-action"));
      await expect(drawer).toContainText(file);
      await closeEvidence(page);
    }
  });

  test("VOLUME one summary and no relation: the insight section is not rendered", async ({ page }) => {
    await mockClaims(page, [{ text: "내년 1월부터 모든 센터에 자동 배차를 적용합니다.", evidence: [/내년 1월부터/u], role: "summary" }]);
    await page.goto("/");
    await upload(page, [{ name: "보고.pdf", bytes: await reportPdf(), mime: MIME.pdf }]);
    const panel = await analyze(page);
    await expect(panel.locator(".analysis-summary-section .subsection-heading span")).toHaveText("1건");
    await expect(panel.locator(".analysis-insight-section")).toHaveCount(0);
    await expect(panel.locator(".analysis-warning-section")).toHaveCount(0);
  });

  test("VOLUME four summaries and seven main items render as separated sections", async ({ page }) => {
    const facts = Array.from({ length: 11 }, (_, index) => `${index + 1}번 규정: 담당 부서는 ${index + 1}일 이내에 처리 결과를 보고합니다.`);
    const pdf = await createUnicodePdf([facts.slice(0, 4).map((text) => ({ text })), facts.slice(4, 8).map((text) => ({ text })), facts.slice(8).map((text) => ({ text }))]);
    await mockClaims(page, facts.slice(0, 4).map((text) => ({ text, evidence: [new RegExp(text.slice(0, 5), "u")], role: "summary" as const })));
    await page.goto("/");
    await upload(page, [{ name: "규정 모음.pdf", bytes: pdf, mime: MIME.pdf }]);
    const panel = await analyze(page);
    await expect(panel.locator(".analysis-summary-section .analysis-reading-row")).toHaveCount(4);
    await expect(panel.locator(".analysis-core-items-section .subsection-heading span")).toHaveText(/^[1-7]건$/u);
    const borders = await panel.locator(".analysis-report-section").evaluateAll((sections) =>
      sections.slice(0, -1).map((section) => getComputedStyle(section).borderBottomWidth));
    expect(borders.every((width) => width === "1px")).toBe(true);
  });

  test("VOLUME twenty-plus confirmed metrics stay inside the surface on desktop and at 390px", async ({ page }) => {
    const rows: (string | number)[][] = [["항목", "값"], ...Array.from({ length: 22 }, (_, index) => [`지표 ${index + 1}`, `${(index + 1) * 1250}원`])];
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }));
    await page.goto("/");
    await upload(page, [{ name: "지표가 아주 많은 월간 운영 지표 정리 파일 이름이 긴 경우.xlsx", bytes: await createXlsx({ 지표: rows }), mime: MIME.xlsx }]);
    const panel = await analyze(page);
    await expect(panel.locator(".analysis-metric-table tbody tr")).toHaveCount(22);
    expect(await noOverflow(page)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await noOverflow(page)).toBe(true);
    const drawer = await openEvidence(page, panel.locator(".analysis-metric-table tbody tr").last().locator(".source-action"));
    await expect(drawer).toContainText("지표 · B23");
  });

  for (const failure of [
    { name: "429 rate limit", fulfill: { status: 429, body: { error: { code: "AI_RATE_LIMITED" } } }, detail: "사용 한도" },
    { name: "500 provider error", fulfill: { status: 500, body: { error: { code: "AI_PROVIDER_UNAVAILABLE" } } }, detail: "AI 서비스 일시 오류" },
    { name: "504 gateway timeout", fulfill: { status: 504, body: {} }, detail: "응답 지연" },
    { name: "invalid JSON body", fulfill: { status: 200, raw: "{not json" }, detail: "AI 응답 형식 오류" },
    { name: "network abort", abort: true, detail: "AI 서비스 일시 오류" },
  ] as const) {
    test(`FAIL ${failure.name}: deterministic result stays and the reason is shown`, async ({ page }) => {
      await page.route("**/api/ai", (route) => "abort" in failure
        ? route.abort("timedout")
        : route.fulfill({ status: failure.fulfill.status, contentType: "application/json", body: "raw" in failure.fulfill ? failure.fulfill.raw : JSON.stringify(failure.fulfill.body) }));
      await page.goto("/");
      await upload(page, [{ name: "보고.pdf", bytes: await reportPdf(), mime: MIME.pdf }]);
      const panel = await analyze(page);
      await expect(panel.locator(".result-status")).toHaveText("기본 분석 완료");
      await expect(panel.locator(".analysis-core-items-section .analysis-reading-row").first()).toBeVisible();
      await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);
      const warning = panel.locator(".analysis-warning-section");
      await expect(warning).toContainText("요약과 인사이트를 불러오지 못했습니다");
      await expect(warning).toContainText(failure.detail);
      await expect(panel.locator(".analysis-report-section").last()).toHaveClass(/analysis-warning-section/u);
    });
  }

  test("FAIL empty claims: analysis completes with deterministic sections only", async ({ page }) => {
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }));
    await page.goto("/");
    await upload(page, [{ name: "보고.pdf", bytes: await reportPdf(), mime: MIME.pdf }]);
    const panel = await analyze(page);
    await expect(panel.locator(".result-status")).toHaveText("분석 완료");
    await expect(panel.locator(".analysis-summary-section")).toHaveCount(0);
    await expect(panel.locator(".analysis-core-items-section .analysis-reading-row").first()).toBeVisible();
  });

  test("FAIL all claims fabricated: grounding rejects them, nothing invented is shown", async ({ page }) => {
    await mockClaims(page, (items) => [{ text: "평균 배송 시간이 5일에서 1일로 감소했습니다.", handles: [items.find((item) => /평균 배송 시간/u.test(item.text))!.handle], confidence: "high", presentation: { role: "summary" } }]);
    await page.goto("/");
    await upload(page, [{ name: "보고.pdf", bytes: await reportPdf(), mime: MIME.pdf }]);
    const panel = await analyze(page);
    await expect(panel.locator(".result-status")).toHaveText("기본 분석 완료");
    await expect(panel.locator(".analysis-warning-section")).toContainText("근거 연결 실패");
    await expect(panel).not.toContainText("5일에서 1일");
  });

  test("FAIL partial: the grounded claim is shown and the rejected one is reported, not displayed", async ({ page }) => {
    await mockClaims(page, (items) => {
      const handle = items.find((item) => /평균 배송 시간/u.test(item.text))!.handle;
      return [
        { text: "자동 배차 도입 후 평균 배송 시간이 3일에서 2일로 감소했습니다.", handles: [handle], confidence: "high", presentation: { role: "summary" } },
        { text: "평균 배송 시간이 5일에서 1일로 감소했습니다.", handles: [handle], confidence: "high", presentation: { role: "summary" } },
      ];
    });
    await page.goto("/");
    await upload(page, [{ name: "보고.pdf", bytes: await reportPdf(), mime: MIME.pdf }]);
    const panel = await analyze(page);
    await expect(panel.locator(".analysis-summary-section .analysis-reading-row")).toHaveCount(1);
    await expect(panel.locator(".analysis-warning-section")).toContainText("일부 내용은 문서 근거와 연결되지 않아");
    await expect(panel).not.toContainText("5일에서 1일");
  });

  test("LAYOUT long result at 1440×900 and 390×844: sections separated, text wraps, evidence works, no overflow", async ({ page }) => {
    const long = "이 문장은 줄바꿈 검증을 위해 일부러 길게 작성한 분석 결과 문장으로, 여러 조건과 예외, 담당 부서, 처리 기한을 모두 포함하여 화면 폭을 넘을 만큼 충분히 길게 이어집니다.";
    const pdf = await createUnicodePdf([[{ text: long }, { text: "단, 해외 사업장은 적용에서 제외합니다." }], [{ text: "결론적으로 모든 부서는 분기마다 결과를 보고합니다." }]]);
    await mockClaims(page, [
      { text: long, evidence: [/줄바꿈 검증/u], role: "summary" },
      { text: "해외 사업장은 적용에서 제외되므로 국내 부서만 분기 보고 대상입니다.", evidence: [/해외 사업장/u, /분기마다/u], role: "insight" },
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await upload(page, [{ name: "아주 긴 파일 이름을 가진 분기별 운영 결과 보고서 최종 수정본 2026.pdf", bytes: pdf, mime: MIME.pdf }]);
    const panel = await analyze(page);
    expect(await noOverflow(page)).toBe(true);
    const sections = panel.locator(".analysis-report-section");
    expect(await sections.count()).toBeGreaterThanOrEqual(2);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await noOverflow(page)).toBe(true);
    const rowWidth = await panel.locator(".analysis-summary-section .analysis-reading-row p").first().evaluate((node) => node.getBoundingClientRect().width);
    expect(rowWidth).toBeLessThanOrEqual(390);
    const drawer = await openEvidence(page, panel.locator(".analysis-insight-section .source-action"));
    await expect(drawer).toContainText("Page 1");
    await expect(drawer).toContainText("Page 2");
  });
});
