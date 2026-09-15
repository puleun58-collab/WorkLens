import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createCheckPptx, createDocx, createPdf, createPptx, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "../fixtures";

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

test("uploads XLSX files, compares them and shows source evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "작업 파일" })).toBeVisible();
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();

  await upload(page, files.v1);
  await upload(page, files.v2);

  const firstRow = fileRow(page, files.v1);
  await expect(firstRow).toContainText("시트: 1");
  await expect(firstRow).toContainText("행: 5");

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v2.xlsx 선택").check();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Compare 실행" }).click();

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

  await seoul.locator(".source-actions button").first().click();
  const detail = page.getByLabel("Source detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("운송단가!B2");
  await expect(detail).toContainText("145000");
  await page.screenshot({ path: "artifacts/compare-evidence.png", fullPage: true });
});

test("renders distinguishable evidence for two files sharing an identical cell locator", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await upload(page, files.v1Copy);

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByLabel("운임현황_v1_사본.xlsx 선택").check();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Compare 실행" }).click();

  // Identical rate sheets produce no diff rows, but Analyze on the pair still
  // surfaces the shared locator (운송단가!B2) from each file; the UI must
  // disambiguate the two source buttons with filename + role rather than
  // rendering two indistinguishable "운송단가!B2" buttons.
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
  const sourceButtons = page.locator(".results-panel .source-link", { hasText: "운송단가!B2" });
  await expect(sourceButtons.first()).toBeVisible();
  const labels = await sourceButtons.allTextContents();
  const distinctLabels = new Set(labels);
  expect(distinctLabels.size).toBeGreaterThan(1);
  expect(labels.some((label) => label.includes("운임현황_v1.xlsx"))).toBe(true);
  expect(labels.some((label) => label.includes("운임현황_v1_사본.xlsx"))).toBe(true);
  expect(labels.every((label) => label.includes("버전 "))).toBe(true);
});

test("distinguishes same-named uploaded revisions by document version", async ({ page }) => {
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
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Compare 실행" }).click();
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  const sourceLabels = await page.locator(".source-actions button").allTextContents();
  const versions = sourceLabels
    .map((label) => /버전 ([a-f0-9]{8})/.exec(label)?.[1])
    .filter((version): version is string => Boolean(version));
  expect(new Set(versions).size).toBeGreaterThanOrEqual(2);
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

test("runs deterministic Analyze, Check, Extract/export and degrades Local AI only", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
  await expect(page.locator(".results-panel")).toContainText("numeric");
  await expect(page.locator(".results-panel .source-link").first()).toBeVisible();
  await page.locator(".results-panel .source-link").first().click();
  await expect(page.getByLabel("Source detail")).toBeVisible();
  await page.getByLabel("닫기").click();

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();
  await expect(page.getByText("콘텐츠 및 개인정보 점검을 완료했습니다.")).toBeVisible();

  await page.getByRole("button", { name: "Extract", exact: true }).click();
  await page.getByRole("button", { name: "Extract 실행" }).click();
  await expect(page.getByText("구조화 추출을 완료했습니다.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드" }).click();
  expect((await download).suggestedFilename()).toContain(".csv");

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("서울 운임은 얼마인가요?");
  await page.getByRole("button", { name: "Ask 실행" }).click();
  await expect(page.locator(".notice.error")).toContainText("Local AI를 사용할 수 없습니다");

  await page.getByRole("button", { name: "Brief", exact: true }).click();
  await page.getByRole("button", { name: "Brief 실행" }).click();
  await expect(page.locator(".notice.error")).toContainText("Local AI를 사용할 수 없습니다");

  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
});

test("reviews PPTX writing, consistency and data findings with filters and exact slide evidence", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();

  await expect(page.getByRole("heading", { name: "문서 제출 전 최종 검수" })).toBeVisible();
  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await expect(typo).toContainText("Spelling");
  await expect(typo).toContainText("HIGH");
  await expect(typo).toContainText("최종검수.pptx · Slide 1");
  await typo.getByRole("button", { name: /한글 맞춤법 오류 가능성/ }).click();
  await expect(typo).toContainText("향후 13주 유가 전먕");
  await expect(typo).toContainText("향후 13주 유가 전망");

  await page.getByRole("button", { name: /Consistency/ }).click();
  await expect(page.locator(".check-issue").filter({ hasText: "용어 일관성" })).toHaveCount(1);
  await expect(page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" })).toHaveCount(0);
  await page.getByRole("button", { name: /^All/ }).last().click();
  await page.getByRole("button", { name: /Warning/ }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  await expect(page.locator(".check-issue.severity-suggestion")).toHaveCount(0);

  await page.getByRole("button", { name: "Local AI 문장 검수" }).click();
  await expect(page.locator(".notice.error")).toContainText("문장/맞춤법 기반 고급 검수는 현재 사용할 수 없습니다");
});
test("keeps the personal dictionary, ignore actions and confidence filter inside this browser", async ({ page, browser }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();

  const before = await page.locator(".check-issue").count();
  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await typo.getByRole("button", { name: /한글 맞춤법 오류 가능성/ }).click();
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
  await remaining.locator(".check-issue-name > button").click();
  const ignoredIssue = await remaining.locator(".check-issue-name > button").innerText();
  await remaining.getByRole("button", { name: "동일 규칙 무시" }).click();
  await expect(page.locator(".check-issue").filter({ hasText: ignoredIssue.split("\n")[0] })).toHaveCount(0);

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


test("moves upload out of the workspace once files exist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".dropzone")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add files" })).toHaveCount(0);

  await upload(page, files.v1);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add files" })).toBeVisible();

  // Adding another file still works from the context bar action.
  await upload(page, files.v2);
  await expect(page.locator(".file-row")).toHaveCount(2);

  await page.reload();
  await expect(page.locator(".dropzone")).toBeVisible();
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
});

test("rejects a disguised file with an actionable message", async ({ page }) => {
  await page.goto("/");
  await sendFile(page, files.fake);
  await expect(page.locator(".notice.error")).toContainText("파일 확장자와 실제 내용이 일치하지 않습니다");
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
});

test("keeps uploaded files inside the tab and never on the server", async ({ page, browser }) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();

  // Parsing and every deterministic operation run in the browser worker. The
  // only server call is the read-only company dictionary, which carries no
  // document content in either direction.
  expect([...new Set(apiCalls)]).toEqual(["/api/company-terms"]);
  const stored = await page.evaluate(() => ({
    cookies: document.cookie,
    local: Object.keys(localStorage).length,
    session: Object.keys(sessionStorage).length,
  }));
  expect(stored).toEqual({ cookies: "", local: 0, session: 0 });

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
  await otherContext.close();
});

test("rejects cross-site calls to the optional Local AI endpoint", async ({ page }) => {
  const crossSite = await page.request.post("/api/ai", {
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    data: { task: "analyze", documents: [] },
  });
  expect(crossSite.status()).toBe(403);
  expect(crossSite.headers()["cache-control"]).toContain("no-store");
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
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Compare 실행" }).click();
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
  const sourceButton = page.locator(".source-actions button").first();
  await sourceButton.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByLabel("Source detail");
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
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
  await page.locator(".results-panel .source-link").first().click();
  await expect(page.getByLabel("Source detail")).toBeVisible();

  await page.reload();

  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
  await expect(page.getByText("운임현황_v1.xlsx")).toHaveCount(0);
  await expect(page.locator(".results-panel")).toHaveCount(0);
  await expect(page.getByLabel("Source detail")).toHaveCount(0);
});

test("explicitly clears the in-browser workspace", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "모두 삭제" }).click();
  await expect(page.getByText("브라우저 메모리에서 파일과 결과를 모두 지웠습니다.")).toBeVisible();
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();

  // The worker was torn down; a new upload must still work in the same tab.
  await upload(page, files.v2);
  await expect(fileRow(page, files.v2)).toContainText("시트: 1");
});
