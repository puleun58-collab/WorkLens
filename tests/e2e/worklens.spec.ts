import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createCheckPptx, createDocx, createExtractPptx, createPdf, createPptx, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "../fixtures";

const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures");
const files = {
  v1: path.join(FIXTURE_DIR, "운임현황_v1.xlsx"),
  v1Copy: path.join(FIXTURE_DIR, "운임현황_v1_사본.xlsx"),
  v2: path.join(FIXTURE_DIR, "운임현황_v2.xlsx"),
  pdf: path.join(FIXTURE_DIR, "계약서.pdf"),
  csv: path.join(FIXTURE_DIR, "운임.csv"),
  docx: path.join(FIXTURE_DIR, "계약.docx"),
  pptx: path.join(FIXTURE_DIR, "계획.pptx"),
  checkPptx: path.join(FIXTURE_DIR, "최종검수.pptx"),
  extractPptx: path.join(FIXTURE_DIR, "회의자료.pptx"),
  fake: path.join(FIXTURE_DIR, "위장파일.xlsx"),
};

test.beforeAll(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(files.v1, await createXlsx(RATE_SHEET_V1));
  await writeFile(files.v1Copy, await createXlsx(RATE_SHEET_V1));
  await writeFile(files.v2, await createXlsx(RATE_SHEET_V2));
  await writeFile(files.pdf, await createPdf(["WorkLens contract page one", "WorkLens contract page two"]));
  await writeFile(files.csv, "지역,금액\r\n서울,145000\r\n부산,90000\r\n");
  await writeFile(files.docx, createDocx());
  await writeFile(files.pptx, createPptx());
  await writeFile(files.checkPptx, createCheckPptx());
  await writeFile(files.extractPptx, createExtractPptx());
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

test("uploads XLSX files, compares them and shows source evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "작업 파일" })).toBeVisible();
  await expect(page.locator(".dropzone")).toBeVisible();

  await upload(page, files.v1);
  await upload(page, files.v2);

  const firstRow = fileRow(page, files.v1);
  await expect(firstRow).toContainText("시트: 1");
  await expect(firstRow).toContainText("행: 5");

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v2.xlsx 선택").check();
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();

  const rows = page.getByTestId("change-row");
  await expect(rows.first()).toBeVisible();
  const seoul = rows.filter({ hasText: "145000" }).first();
  await expect(seoul).toContainText("158000");
  await expect(seoul).toContainText("13000");
  await expect(seoul).toContainText("8.97%");
  await expect(page.locator('[data-category="Important Change"]').first()).toBeVisible();
  await expect(rows.filter({ hasText: "INCHEON" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "DAEGU" }).first()).toBeVisible();

  const jeju = rows.filter({ hasText: "JEJU" }).first();
  await expect(jeju).toBeVisible();

  await seoul.locator(".source-action").first().click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("운송단가 · B2");
  await page.screenshot({ path: "artifacts/compare-evidence.png", fullPage: true });
});

test("renders distinguishable evidence for two files sharing an identical cell locator", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v1Copy);

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v1_사본.xlsx 선택").check();

  // Two files hold the same cell. The result rows stay locator-only — the file
  // name belongs to the section header — and the evidence inspector is what
  // names the file and its version, so the two are never confused.
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석.*완료/);
  await page.locator(".analysis-details > summary").click();
  const sections = page.locator(".results-panel .document-result");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0).locator(".document-result-heading h3")).toHaveText("운임현황_v1.xlsx");
  await expect(sections.nth(1).locator(".document-result-heading h3")).toHaveText("운임현황_v1_사본.xlsx");

  // A row summarises its sources; no file name appears inside a locator.
  const locators = page.locator(".results-panel .source-locator");
  await expect(locators.filter({ hasText: "운송단가" }).first()).toBeVisible();
  for (const text of await locators.allTextContents()) {
    expect(text).not.toContain(".xlsx");
  }

  // The inspector is where the full set lives, and it names the file. The
  // document version stays internal, so no hash reaches the screen.
  const inspectorLabels: string[] = [];
  for (const index of [0, 1]) {
    await sections.nth(index).locator(".source-action").first().click();
    const detail = page.getByLabel("근거 상세");
    await expect(detail).toBeVisible();
    inspectorLabels.push(await detail.locator(".evidence-file-list").innerText());
    await page.getByLabel("닫기").click();
  }
  expect(inspectorLabels[0]).toContain("운임현황_v1.xlsx");
  expect(inspectorLabels[1]).toContain("운임현황_v1_사본.xlsx");
  expect(inspectorLabels.every((label) => label.includes("버전"))).toBe(false);
  expect(new Set(inspectorLabels).size).toBe(2);
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
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();
  const row = page.getByTestId("change-row").first();
  await expect(row).toBeVisible();

  // The row stays locator-first and summarises both revisions; 기준/현재 tells
  // them apart in the row, and the inspector names each file separately —
  // upload order, not a version hash, is what the user reads.
  const summary = await row.locator(".source-locator").innerText();
  expect(summary).toContain("기준");
  expect(summary).toContain("외 1곳");

  await row.locator(".source-action").click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail).toBeVisible();
  const headings = await detail.locator(".evidence-entry h3").allInnerTexts();
  const locations = await detail.locator(".evidence-location-list li").allInnerTexts();
  expect(locations.some((location) => location.includes("기준"))).toBe(true);
  expect(locations.some((location) => location.includes("현재"))).toBe(true);
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

  // One locator vocabulary across formats, and no file name inside a source.
  for (const [file, pattern] of [
    [files.csv, /^Row \d+$/],
    [files.pdf, /^Page \d+$/],
    [files.docx, /^Paragraph \d+$/],
    [files.pptx, /^Slide \d+ · (본문|표)$/],
    [files.v1, /^.+ · [A-Z]+\d+(:[A-Z]+\d+)?$/],
  ] as const) {
    const name = path.basename(file);
    await fileRow(page, file).getByRole("checkbox").check();
    await page.getByRole("button", { name: "추출", exact: true }).click();
    // The full-text mode lists every paragraph and table, so every format's
    // locator vocabulary is visible here.
    await page.getByRole("radio", { name: "전체 텍스트" }).check();
    await page.getByRole("button", { name: "추출 실행" }).click();
    await expect(page.locator(".results-panel .result-status")).toHaveText("추출 완료");
    const locator = page.locator(".results-panel .source-summary-link").first();
    await expect(locator).toBeVisible();
    const text = await locator.innerText();
    expect(text, `${name} locator`).toMatch(pattern);
    expect(text).not.toContain(name);
    await expect(locator).toHaveAccessibleName(/근거 상세 보기$/);
    await fileRow(page, file).getByRole("checkbox").uncheck();
  }
});


test("runs deterministic Analyze, Check, Extract and export paths", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석.*완료/);
  await expect(page.locator(".results-panel")).toContainText("numeric");
  await expect(page.locator(".results-panel .source-action").first()).toBeVisible();
  await page.locator(".results-panel .source-action").first().click();
  await expect(page.getByLabel("근거 상세")).toBeVisible();
  await page.getByLabel("닫기").click();

  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toContainText("검수 완료");

  await page.getByRole("button", { name: "추출", exact: true }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("추출 완료");
  const structuredDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드" }).click();
  expect((await structuredDownload).suggestedFilename()).toContain(".csv");

  // The old paragraph/table dump is still available as the secondary mode.
  await page.getByRole("radio", { name: "전체 텍스트" }).check();
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("추출 완료");
  const textExtractPanel = page.locator(".results-panel");
  await expect(textExtractPanel.locator(".document-result").first()).toBeVisible();
  await expect(textExtractPanel.getByRole("button", { name: /윤문/ })).toHaveCount(0);
  const textDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await textDownload).suggestedFilename()).toContain(".xlsx");

});

test("extracts fields and records without a model and exports the structured table", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.extractPptx);
  await page.getByLabel("회의자료.pptx 선택").check();
  await page.getByRole("button", { name: "추출", exact: true }).click();

  // Automatic mode: labelled pairs become FIELD/VALUE rows with a locator.
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".check-summary-line")).toContainText("추출 항목");
  const autoTable = page.locator(".extract-auto-table");
  await expect(autoTable).toBeVisible();
  await expect(autoTable.locator(".data-row").first().locator(".source-summary-link")).toBeVisible();
  // A value is the document's own wording, never a rewritten one.
  await expect(autoTable).toContainText("경영지원팀");

  // Field mode: a value explicitly present in the document needs no model.
  await page.getByRole("radio", { name: "항목 지정" }).check();
  const field = page.getByLabel("추출할 항목");
  await field.fill("작성부서");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  const table = page.locator(".results-panel .extract-fields-table");
  await expect(table.locator('[role="columnheader"]').nth(0)).toHaveText("항목");
  await expect(table).toContainText("경영지원팀");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await download).suggestedFilename()).toContain(".xlsx");
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
  await page.getByLabel("회의자료.pptx 선택").check();
  await page.getByRole("button", { name: "추출", exact: true }).click();
  await page.getByRole("radio", { name: "항목 지정" }).check();
  const field = page.getByLabel("추출할 항목");
  for (const name of ["검토부서", "존재하지 않는 항목"]) {
    await field.fill(name);
    await page.getByRole("button", { name: "항목 추가" }).click();
  }
  await page.getByRole("button", { name: "추출 실행" }).click();

  const panel = page.locator(".extract-results");
  await expect(panel.locator(".check-summary-line")).toContainText("확인 필요 1");
  await expect(panel.locator(".check-summary-line")).toContainText("낮은 확신 1");
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
  const hierarchy = await exports.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, color: style.color, border: style.borderStyle };
  }));
  expect(hierarchy[0].background).toBe("rgb(255, 255, 255)");
  expect(hierarchy[1].background).toBe("rgb(37, 99, 235)");
  expect(hierarchy[0].border).not.toBe("none");
  expect(hierarchy[1].border).not.toBe("none");
  await page.screenshot({ path: "artifacts/inspo-extract-desktop-1440.png", fullPage: true });
  if (testInfo.project.name === "chromium-desktop") expect(consoleErrors).toEqual([]);
});


test("offers file and pasted-text polish without touching the workspace", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "윤문", exact: true }).click();

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
  await expect(page.locator(".polish-paste small")).toContainText("/ 5,000자");
  await expect(page.getByRole("button", { name: "윤문 실행" })).toBeEnabled();
  await expect(page.locator(".source-locator")).toHaveCount(0);

  // Switching back restores the workspace file and its selection.
  await page.getByRole("radio", { name: "파일 윤문" }).check();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await expect(page.getByLabel("최종검수.pptx 선택")).toBeChecked();
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
  await page.getByRole("button", { name: "윤문", exact: true }).click();
  await expect(page.getByRole("radio", { name: "파일 윤문" })).toBeChecked();
});

test("runs Ask, Brief, Polish, Check and Extract through the server AI boundary", async ({ page }) => {
  const seen = new Set<string>();
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims" | "polish" | "extract";
      request?: { operation: string };
      items?: Array<{ handle: string; text: string }>;
      text?: string;
      field?: string;
    };
    let data: object;
    if (request.kind === "claims") {
      const evidence = request.items?.[0];
      if (!evidence || !request.request) throw new Error("Mocked claims request is missing evidence.");
      seen.add(request.request.operation);
      data = {
        kind: "claims",
        claims: [{ text: evidence.text, handles: [evidence.handle], confidence: "high" }],
      };
    } else if (request.kind === "polish") {
      seen.add("polish");
      data = {
        kind: "polish",
        proposal: { changed: false, revisedText: request.text ?? "", reasons: [] },
      };
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
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  await page.getByRole("button", { name: "질문", exact: true }).click();
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("답변 완료");
  expect([...seen]).toEqual(["ask"]);

  await page.getByRole("button", { name: "요약", exact: true }).click();
  await page.getByRole("button", { name: "요약 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("요약 완료");
  expect([...seen].sort()).toEqual(["ask", "brief"]);

  await page.getByRole("button", { name: "윤문", exact: true }).click();
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("운임 현황을 검토 부탁드립니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("윤문 완료");
  expect([...seen].sort()).toEqual(["ask", "brief", "polish"]);

  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행", exact: true }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");
  expect([...seen].sort()).toEqual(["ask", "brief", "polish", "semantic-check"]);

  await page.getByRole("button", { name: "추출", exact: true }).click();
  await page.getByRole("radio", { name: "항목 지정" }).check();
  await page.getByLabel("추출할 항목").fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("추출 완료");

  expect([...seen].sort()).toEqual(["ask", "brief", "extract", "polish", "semantic-check"]);
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
  await upload(page, files.v1);
  await upload(page, files.v2);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v2.xlsx 선택").check();

  const runs: Array<{ tab: "Analyze" | "Ask" | "Compare" | "Check" | "Brief"; label: string }> = [
    { tab: "Analyze", label: "분석" },
    { tab: "Ask", label: "질문" },
    { tab: "Compare", label: "비교" },
    { tab: "Check", label: "검수" },
    { tab: "Brief", label: "요약" },
  ];
  for (const run of runs) {
    await page.getByRole("button", { name: run.label, exact: true }).click();
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
  await page.getByRole("button", { name: "요약", exact: true }).click();
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
      text?: string;
      field?: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
    const data = request.kind === "polish"
      ? { kind: "polish", proposal: { changed: false, revisedText: request.text ?? "", reasons: [] } }
      : { kind: "extract", proposal: { field: request.field ?? "", value: null, handles: [], confidence: "low" } };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  await page.getByRole("button", { name: "윤문", exact: true }).click();
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("운임 현황을 검토 부탁드립니다.");
  await page.getByRole("button", { name: "윤문 실행" }).click();
  await expect(page.locator(".compact-progress")).toContainText(/윤문 처리 중 0\/\d+/);
  await expect(page.getByRole("button", { name: "윤문 실행" })).toBeEnabled({ timeout: 15_000 });

  await page.getByRole("button", { name: "추출", exact: true }).click();
  await page.getByRole("radio", { name: "항목 지정" }).check();
  await page.getByLabel("추출할 항목").fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "추출 실행" }).click();
  await expect(page.locator(".compact-progress")).toContainText("항목 확인 중 0/1");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".compact-progress")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "추출 실행" })).toBeEnabled({ timeout: 15_000 });
});

test("presents Ask as one answer followed by compact clickable evidence", async ({ page }) => {
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
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "질문", exact: true }).click();
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();

  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "파일 답변", exact: true })).toBeVisible();
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
  const evidence = panel.locator(".ask-evidence");
  await expect(answer).toBeVisible();
  await expect(evidence).toBeVisible();
  expect(await panel.locator(".ask-answer, .ask-evidence").evaluateAll((nodes) =>
    nodes.map((node) => node.className),
  )).toEqual(["ask-answer", "ask-evidence"]);


  const answerText = (await answer.locator("p").innerText()).trim();
  expect(answerText).not.toContain("추론:");
  await expect(panel.getByText(answerText, { exact: true })).toHaveCount(1);

  const sourceBlock = evidence.locator(".result-source");
  await expect(sourceBlock).toBeVisible();
  await expect(evidence.locator(".subsection-heading > span")).toHaveText(/\d+곳/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(answer).toBeVisible();
  await expect(evidence).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await sourceBlock.locator(".source-action").click();
  await expect(page.locator(".evidence-inspector")).toBeVisible();

});

test("keeps an unanswerable Ask as a grounded error without invented sources", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [] } }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "질문", exact: true }).click();
  await page.getByLabel("질문 입력").fill("문서에 없는 값을 알려주세요.");
  await page.getByRole("button", { name: "질문 실행" }).click();

  await expect(page.locator(".notice.error")).toContainText("선택한 문서에서 답변에 필요한 근거를 찾지 못했습니다.");
  await expect(page.locator(".results-panel")).toHaveCount(0);
  await expect(page.locator(".ask-evidence .result-source")).toHaveCount(0);
});

test("keeps grounded Ask and Brief content when another claim is rejected", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims";
      items: Array<{ handle: string; text: string }>;
    };
    const evidence = request.items[0];
    if (!evidence) throw new Error("Mocked claims request is missing evidence.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kind: "claims",
          claims: [
            { text: evidence.text, handles: [evidence.handle], confidence: "high" },
            { text: "문서에 없는 내용", handles: ["missing-handle"], confidence: "high" },
          ],
        },
      }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  await page.getByRole("button", { name: "질문", exact: true }).click();
  await page.getByLabel("질문 입력").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "질문 실행" }).click();
  const askPanel = page.locator(".results-panel");
  await expect(askPanel.locator(".result-status")).toHaveText("답변 완료");
  await expect(askPanel.locator(".result-inline-warning")).toHaveText("일부 내용은 문서 근거와 연결되지 않아 결과에서 제외했습니다.");
  await expect(askPanel).not.toContainText("문서에 없는 내용");
  await expect(page.locator(".notice.error, .notice.warning")).toHaveCount(0);

  await page.getByRole("button", { name: "요약", exact: true }).click();
  await page.getByRole("button", { name: "요약 실행" }).click();
  const briefPanel = page.locator(".results-panel");
  await expect(briefPanel.getByRole("heading", { name: "핵심 요약", exact: true })).toBeVisible();
  await expect(briefPanel.locator(".result-status")).toHaveText("요약 완료");
  await expect(briefPanel.locator(".result-inline-warning")).toHaveText("일부 내용은 문서 근거와 연결되지 않아 결과에서 제외했습니다.");
  await expect(briefPanel.locator(".brief-body")).toBeVisible();
  await expect(briefPanel.getByRole("heading", { name: "주요 근거", exact: true })).toBeVisible();
  const briefSource = briefPanel.locator(".brief-evidence-item .source-summary-link").first();
  await expect(briefSource).toBeVisible();
  await expect(briefPanel.locator(".claim-row")).toHaveCount(0);
  await expect(briefPanel).not.toContainText("문서에 없는 내용");
  await expect(briefPanel).not.toContainText("해석 · 근거 검증됨");
  await expect(briefPanel).not.toContainText("FILE FACT");
  await expect(briefPanel).not.toContainText("근거별 주장");
  await expect(briefPanel).not.toContainText("claims");
  await expect(briefPanel).not.toContainText("BRIEF RESULT");
  await expect(briefPanel).not.toContainText("근거 연결 결과");
  const briefOrder = await briefPanel.locator(".brief-body, .brief-evidence").evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(briefOrder).toEqual(["ask-answer brief-body", "ask-evidence brief-evidence"]);
  await briefSource.click();
  const briefDetail = page.getByRole("complementary", { name: "근거 상세" });
  await expect(briefDetail).toBeVisible();
  await briefDetail.getByRole("button", { name: "닫기" }).click();
  await expect(briefSource).toBeFocused();
  await expect(briefPanel.getByRole("button", { name: /윤문/ })).toHaveCount(0);
  await expect(page.locator(".notice.error, .notice.warning")).toHaveCount(0);
});

test("groups repeated Summary sources without losing drawer coverage", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    const request = route.request().postDataJSON() as {
      kind: "claims";
      items: Array<{ handle: string; text: string }>;
    };
    const byText = new Map<string, Array<{ handle: string; text: string }>>();
    for (const item of request.items) {
      const group = byText.get(item.text) ?? [];
      group.push(item);
      byText.set(item.text, group);
    }
    const repeated = [...byText.values()].find((group) => group.length > 1 && group[0].text.trim());
    if (!repeated) throw new Error("Mocked summary request is missing repeated cross-file evidence.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          kind: "claims",
          claims: [{ text: repeated[0].text, handles: repeated.slice(0, 2).map((item) => item.handle), confidence: "high" }],
        },
      }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v1Copy);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v1_사본.xlsx 선택").check();
  await page.getByRole("button", { name: "요약", exact: true }).click();
  await page.getByRole("button", { name: "요약 실행" }).click();

  const panel = page.locator(".results-panel");
  await expect(panel.getByRole("heading", { name: "핵심 요약", exact: true })).toBeVisible();
  await expect(panel.locator(".result-status")).toHaveText("요약 완료");
  const item = panel.locator(".brief-evidence-item").first();
  const source = item.locator(".source-summary-link");
  await expect(source).toContainText("외 1곳");
  await expect(item).not.toContainText("근거 보기");
  await page.screenshot({ path: "artifacts/inspo-summary-desktop-1440.png", fullPage: true });

  await source.click();
  const detail = page.getByLabel("근거 상세");
  await expect(detail.locator(".evidence-entry")).toHaveCount(2);
  await expect(detail.locator(".evidence-file-list")).toContainText("운임현황_v1.xlsx");
  await expect(detail.locator(".evidence-file-list")).toContainText("운임현황_v1_사본.xlsx");
  await detail.getByRole("button", { name: "닫기" }).click();
  await expect(source).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await item.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/inspo-summary-mobile-390.png", fullPage: true });
});

test("shows a Brief-specific error when no grounded content remains", async ({ page }) => {
  await page.route("**/api/ai", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { kind: "claims", claims: [] } }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "요약", exact: true }).click();
  await page.getByRole("button", { name: "요약 실행" }).click();

  const error = page.locator(".notice.error");
  await expect(error).toContainText("선택한 문서에서 요약에 필요한 근거를 찾지 못했습니다.");
  await expect(error).not.toContainText("파일 형식과 선택 상태");
  await expect(page.locator(".results-panel")).toHaveCount(0);
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
          claims: [{ text: evidence.text, handles: [evidence.handle], confidence: "high" }],
        },
      }),
    });
  });

  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v2);
  await upload(page, files.checkPptx);

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .document-result")).toHaveCount(1);
  await expect(page.locator(".results-panel .result-status")).toHaveText("분석 완료");

  await page.getByLabel("운임현황_v2.xlsx 선택").check();
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  await expect(page.locator(".results-panel .result-status")).toHaveText("비교 완료");

  await page.getByLabel("운임현황_v1.xlsx 선택").uncheck();
  await page.getByLabel("운임현황_v2.xlsx 선택").uncheck();
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");

  failEnrichment = true;
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  await expect(page.locator(".result-inline-warning")).toContainText("기본 검수는 완료했습니다.");
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "검수 실행" })).toBeEnabled();

  await page.getByLabel("최종검수.pptx 선택").uncheck();
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .document-result")).toHaveCount(1);
  await expect(page.locator(".result-inline-warning")).toContainText("기본 분석은 완료했습니다.");

  await page.getByLabel("운임현황_v2.xlsx 선택").check();
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  await expect(page.locator(".result-inline-warning")).toContainText("기본 비교는 완료했습니다.");
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
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행" }).click();

  const overview = page.locator(".qa-overview");
  await expect(overview.getByRole("heading", { name: "문서 품질 검수" })).toBeVisible();
  await expect(overview.locator(".qa-summary")).toContainText("Critical");
  await expect(overview.locator(".qa-summary")).toContainText("Warning");
  await expect(page.getByText("낮은 확신 포함")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "용어 사전" })).toBeVisible();
  await expect(page.locator(".check-filter-status")).toHaveText("8건 표시");

  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await expect(typo).toContainText("문장");
  await expect(typo).toContainText("Warning");
  await expect(typo.locator(".source-locator")).toHaveText("Slide 1 · 본문");
  await expect(typo.getByRole("button", { name: "Slide 1 · 본문 근거 보기" })).toBeVisible();
  expect((await typo.innerText()).split("최종검수.pptx").length - 1).toBe(1);
  await expect(typo.locator(".check-issue-row > .issue-detail-toggle")).toHaveText("상세 보기");
  await expect(typo.locator(".check-source .issue-detail-toggle")).toHaveCount(0);
  await typo.getByRole("button", { name: /한글 맞춤법 오류 가능성 상세 보기/ }).click();
  await expect(typo).toContainText("향후 13주 유가 전먕");
  await expect(typo).toContainText("향후 13주 유가 전망");
  await expect(typo.locator(".check-issue-detail .result-source")).toHaveCount(0);
  await expect(typo.locator(".check-issue-detail")).toContainText("이유");
  await expect(typo.locator(".result-source")).toHaveCount(1);
  const detailStyle = await typo.locator(".check-issue-detail").evaluate((element) => {
    const original = element.querySelector(".original-copy blockquote");
    const suggested = element.querySelector(".suggested-copy blockquote");
    return {
      original: original ? getComputedStyle(original).borderLeftColor : "",
      suggested: suggested ? getComputedStyle(suggested).borderLeftColor : "",
    };
  });
  expect(detailStyle.original).not.toBe(detailStyle.suggested);

  await typo.locator(".source-action").click();
  const evidence = page.getByLabel("근거 상세");
  await expect(evidence).toBeVisible();
  await expect(evidence.locator(".evidence-location-list")).toContainText("Slide 1 · 본문");
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
});

test("keeps the personal dictionary and ignore actions inside this browser", async ({ page, browser }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();

  const before = await page.locator(".check-issue").count();
  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await typo.getByRole("button", { name: /한글 맞춤법 오류 가능성 상세 보기/ }).click();
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
  await remaining.locator(".issue-detail-toggle").click();
  await remaining.getByRole("button", { name: "동일 규칙 무시" }).click();
  await expect(page.locator(".check-issue").filter({ hasText: ignoredIssue })).toHaveCount(0);

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


test("keeps empty upload actions singular and restores header actions after upload", async ({ page }) => {
  await page.goto("/");
  const context = page.locator(".context-bar");
  const dropzone = page.locator(".dropzone");

  await expect(page.locator(".rail-group-label")).toHaveText("WORKSPACE");
  await expect(page.locator(".rail-list .rail-item span")).toHaveText(["분석", "질문", "비교", "검수", "윤문", "추출", "요약"]);
  await expect(context.locator(".context-files")).toContainText("작업 파일");
  await expect(context.locator(".context-counts")).toHaveText("0개");
  await expect(context).not.toContainText("선택 0개");
  await expect(context).not.toContainText("선택 없음");
  await expect(context.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
  await expect(context.getByRole("button", { name: "모두 삭제" })).toHaveCount(0);
  await expect(dropzone.getByRole("button", { name: "파일 추가" })).toBeVisible();
  await expect(dropzone).toContainText("XLSX, CSV, PDF, DOCX, PPTX · 파일당 100 MB · 최대 300 MB");
  await expect(dropzone).toContainText("여기로 끌어놓기");

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

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
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
  await expect(page.getByLabel("드롭업로드.xlsx 선택")).toBeVisible();
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.locator(".context-bar").getByRole("button", { name: "파일 추가" })).toBeVisible();
  await expect(page.locator(".context-bar").getByRole("button", { name: "모두 삭제" })).toBeVisible();
});

test("aligns fileless text Polish controls to one desktop and mobile baseline", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "윤문", exact: true }).click();
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await expect(page.locator(".dropzone")).toBeVisible();

  const alignment = async () => {
    const title = page.getByRole("heading", { name: "텍스트 윤문", exact: true });
    const inputModes = page.locator(".polish-input-modes");
    const polishModes = page.locator(".polish-modes");
    const pasteLabel = page.locator(".polish-paste > span");
    const paste = page.getByLabel("윤문할 텍스트 입력");
    const count = page.locator(".polish-paste small");
    const action = page.getByRole("button", { name: "윤문 실행" });
    const boxes = await Promise.all([title, inputModes, polishModes, pasteLabel, paste, count, action].map((locator) => locator.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    const left = boxes[0]!.x;
    for (const box of boxes.slice(1)) expect(Math.abs(box!.x - left)).toBeLessThanOrEqual(1);
    return { paste: boxes[4]!, action: boxes[6]! };
  };

  const desktop = await alignment();
  const initialViewport = page.viewportSize();
  expect(desktop.paste.width).toBeGreaterThanOrEqual(initialViewport && initialViewport.width < 1000 ? 600 : 700);
  expect(desktop.paste.width).toBeLessThanOrEqual(960);
  await page.getByLabel("윤문할 텍스트 입력").fill("파일 없이도 텍스트 윤문을 실행할 수 있습니다.");
  await expect(page.getByRole("button", { name: "윤문 실행" })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await alignment();
  expect(mobile.paste.width).toBeLessThanOrEqual(358);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps file context and upload controls out of utility destinations", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("button", { name: "Dictionary" }).click();

  await expect(page.getByRole("heading", { name: "용어 사전", exact: true })).toBeVisible();
  await expect(page.locator(".notice")).toHaveCount(0);
  await expect(page.locator(".context-files")).toHaveCount(0);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
  await expect(page.getByText("회사 공통 용어입니다. 관리자만 수정할 수 있습니다.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("공용 용어 검색")).toBeVisible();
  await expect(page.getByText("등록된 개인 용어가 없습니다.")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
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

test("uses task-focused labels and concise execution buttons", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  const labels = [
    ["분석", "문서 분석"],
    ["질문", "질문하기"],
    ["비교", "파일 비교"],
    ["검수", "문서 검수"],
    ["윤문", "문서 윤문"],
    ["추출", "정보 추출"],
    ["요약", "요약"],
  ] as const;
  await expect(page.locator(".rail-list .rail-item span")).toHaveText(labels.map(([label]) => label));
  for (const [tab, title] of labels) {
    await page.getByRole("button", { name: tab, exact: true }).click();
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

test("keeps a feature's completion notice inside that feature", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "분석 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText(/분석.*완료/);

  // Another feature, the dictionary and the settings page own their own
  // status, so an Analyze result never announces itself there.
  for (const destination of ["검수", "Dictionary", "Settings"]) {
    await page.getByRole("button", { name: destination, exact: true }).click();
    await expect(page.locator(".notice")).toHaveCount(0);
  }

  // Workspace-wide upload errors also stay in document work views.
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await sendFile(page, files.fake);
  await expect(page.locator(".notice.error")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
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
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "검수", exact: true }).click();
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.getByText(/(?:기본 검수|문서 검수를 완료)/)).toBeVisible();

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
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v2.xlsx 선택").check();
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();

  const changeTable = page.locator(".change-table");
  await expect(changeTable).toHaveAttribute("role", "table");
  await expect(changeTable.locator('[role="row"]').first()).toBeVisible();
  await expect(changeTable.locator('[role="columnheader"]').first()).toBeVisible();
  await expect(changeTable.locator('[role="cell"]').first()).toBeVisible();

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

  // Keyboard focus on the opacity-0 file checkbox must be visibly indicated.
  const checkboxInput = page.locator(".select-file input").first();
  await checkboxInput.focus();
  await expect(checkboxInput).toBeFocused();
  const outlineWidth = await checkboxInput.evaluate((element) => {
    const sibling = element.nextElementSibling;
    return sibling ? getComputedStyle(sibling).outlineWidth : "0px";
  });
  expect(outlineWidth).not.toBe("0px");
});

test("discards every file and result when the tab reloads", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
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
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "모두 삭제" }).click();
  const clearedStatus = page.getByText("브라우저 메모리에서 파일과 결과를 모두 지웠습니다.", { exact: true });
  await expect(clearedStatus).toBeVisible();
  await expect(clearedStatus).toHaveClass(/notice-inline/);
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

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v2.xlsx 선택").check();
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await page.getByRole("button", { name: "비교 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  const comparisonWidths = await page.locator(".change-table").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(comparisonWidths.scroll).toBeGreaterThan(comparisonWidths.client);
  await expectNoPageOverflow();

  await page.getByLabel("운임현황_v1.xlsx 선택").uncheck();
  await page.getByLabel("운임현황_v2.xlsx 선택").uncheck();
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "검수", exact: true }).click();
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

  await page.getByRole("button", { name: "질문", exact: true }).click();
  const askInput = page.getByLabel("질문 입력");
  const askAction = page.getByRole("button", { name: "질문 실행" });
  const [askBox, actionBox] = await Promise.all([askInput.boundingBox(), askAction.boundingBox()]);
  expect(askBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThan(askBox!.y + askBox!.height);

  await page.getByRole("button", { name: "윤문", exact: true }).click();
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  const paste = page.getByLabel("윤문할 텍스트 입력");
  await expect(paste).toBeVisible();
  expect((await paste.boundingBox())!.width).toBeLessThanOrEqual(358);

  await page.getByRole("button", { name: "추출", exact: true }).click();
  await page.getByLabel("최종검수.pptx 선택").uncheck();
  await page.getByLabel("회의자료.pptx 선택").check();
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
  expect(xlsxStyle.background).toBe("rgb(37, 99, 235)");
  expect(csvStyle.left).toBeGreaterThanOrEqual(0);
  expect(xlsxStyle.right).toBeLessThanOrEqual(390);
  await expectNoPageOverflow();
  await page.screenshot({ path: "artifacts/inspo-extract-mobile-390.png", fullPage: true });

  await page.getByRole("button", { name: "요약", exact: true }).click();
  const briefInput = page.getByLabel("요약 중점 입력");
  const briefAction = page.getByRole("button", { name: "요약 실행" });
  const [briefBox, briefActionBox] = await Promise.all([briefInput.boundingBox(), briefAction.boundingBox()]);
  expect(briefActionBox!.y).toBeGreaterThan(briefBox!.y + briefBox!.height);

  await page.getByRole("button", { name: "Dictionary", exact: true }).click();
  await expect(page.locator(".settings-surface[aria-label='Dictionary']")).toBeVisible();
  await expectNoPageOverflow();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
    for (const destination of ["분석", "질문", "비교", "검수", "윤문", "추출", "요약", "Dictionary", "Settings"]) {
      await page.getByRole("button", { name: destination, exact: true }).click();
      await expectNoPageOverflow();
    }
    const clippedNavItems = await page.locator(".rail-item").evaluateAll((items) =>
      items.filter((item) => item.scrollWidth > item.clientWidth || item.scrollHeight > item.clientHeight).length);
    expect(clippedNavItems).toBe(0);
  }
  expect(consoleErrors).toEqual([]);
});
