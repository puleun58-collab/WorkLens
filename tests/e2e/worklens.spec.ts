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

  await seoul.locator(".source-action").first().click();
  const detail = page.getByLabel("Source detail");
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
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
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
    const detail = page.getByLabel("Source detail");
    await expect(detail).toBeVisible();
    const entries = detail.locator(".evidence-entry h3");
    const heading = await entries.count() > 0
      ? await entries.first().innerText()
      : await detail.locator("h2").innerText();
    inspectorLabels.push(heading);
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
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Compare 실행" }).click();
  const row = page.getByTestId("change-row").first();
  await expect(row).toBeVisible();

  // The row stays locator-first and summarises both revisions; 기준/현재 tells
  // them apart in the row, and the inspector names each file separately —
  // upload order, not a version hash, is what the user reads.
  const summary = await row.locator(".source-locator").innerText();
  expect(summary).toContain("기준");
  expect(summary).toContain("외 1곳");

  await row.locator(".source-action").click();
  const detail = page.getByLabel("Source detail");
  await expect(detail).toBeVisible();
  const headings = await detail.locator(".evidence-entry h3").allInnerTexts();
  expect(headings.some((heading) => heading.includes("기준"))).toBe(true);
  expect(headings.some((heading) => heading.includes("현재"))).toBe(true);
  expect(headings.some((heading) => heading.includes("동일이름.xlsx (2)"))).toBe(true);
  expect(headings.every((heading) => !/[a-f0-9]{8}/.test(heading))).toBe(true);
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
    await page.getByRole("button", { name: "Extract", exact: true }).click();
    // The full-text mode lists every paragraph and table, so every format's
    // locator vocabulary is visible here.
    await page.getByRole("radio", { name: "전체 텍스트 내보내기" }).check();
    await page.getByRole("button", { name: "Extract 실행" }).click();
    await expect(page.getByText("전체 텍스트를 준비했습니다.")).toBeVisible();
    const locator = page.locator(".results-panel .source-locator").first();
    await expect(locator).toBeVisible();
    const text = await locator.innerText();
    expect(text, `${name} locator`).toMatch(pattern);
    expect(text).not.toContain(name);
    await expect(page.locator(".results-panel .source-action").first()).toHaveText("근거 보기");
    await fileRow(page, file).getByRole("checkbox").uncheck();
  }
});


test("runs deterministic Analyze, Check, Extract and export paths", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();

  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
  await expect(page.locator(".results-panel")).toContainText("numeric");
  await expect(page.locator(".results-panel .source-action").first()).toBeVisible();
  await page.locator(".results-panel .source-action").first().click();
  await expect(page.getByLabel("Source detail")).toBeVisible();
  await page.getByLabel("닫기").click();

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();
  await expect(page.getByText("콘텐츠 및 개인정보 점검을 완료했습니다.")).toBeVisible();

  await page.getByRole("button", { name: "Extract", exact: true }).click();
  await page.getByRole("button", { name: "Extract 실행" }).click();
  await expect(page.getByText(/추출 항목 \d+개/)).toBeVisible();
  const structuredDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 다운로드" }).click();
  expect((await structuredDownload).suggestedFilename()).toContain(".csv");

  // The old paragraph/table dump is still available as the secondary mode.
  await page.getByRole("radio", { name: "전체 텍스트 내보내기" }).check();
  await page.getByRole("button", { name: "Extract 실행" }).click();
  await expect(page.getByText("전체 텍스트를 준비했습니다.")).toBeVisible();
  const textDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await textDownload).suggestedFilename()).toContain(".xlsx");

});

test("extracts fields and records without a model and exports the structured table", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.extractPptx);
  await page.getByLabel("회의자료.pptx 선택").check();
  await page.getByRole("button", { name: "Extract", exact: true }).click();

  // Automatic mode: labelled pairs become FIELD/VALUE rows with a locator.
  await page.getByRole("button", { name: "Extract 실행" }).click();
  await expect(page.locator(".check-summary-line")).toContainText("추출 항목");
  const autoTable = page.locator(".extract-auto-table");
  await expect(autoTable).toBeVisible();
  await expect(autoTable.locator(".data-row").first().locator(".source-locator")).toBeVisible();
  // A value is the document's own wording, never a rewritten one.
  await expect(autoTable).toContainText("경영지원팀");

  // Field mode: a value explicitly present in the document needs no model.
  await page.getByRole("radio", { name: "항목 지정" }).check();
  const field = page.getByLabel("추출할 항목");
  await field.fill("작성부서");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "Extract 실행" }).click();
  const table = page.locator(".results-panel table.extract-table").first();
  await expect(table.locator("th").nth(1)).toHaveText("작성부서");
  await expect(table).toContainText("경영지원팀");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "XLSX 다운로드" }).click();
  expect((await download).suggestedFilename()).toContain(".xlsx");
});


test("offers file and pasted-text polish without touching the workspace", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "Polish", exact: true }).click();

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
  await expect(page.getByRole("button", { name: "Polish 실행" })).toBeDisabled();
  await paste.fill("안녕하세요.\n- 3분기 운영 보고 관련하여 검토 부탁드리고자 합니다.\n1. 매출은 1,250만원입니다.");
  await expect(page.locator(".polish-paste small")).toContainText("/ 5,000자");
  await expect(page.getByRole("button", { name: "Polish 실행" })).toBeEnabled();
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
  await page.getByRole("button", { name: "Polish", exact: true }).click();
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

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByPlaceholder("선택한 문서에서 확인할 내용을 입력하세요").fill("SEOUL 단가는 얼마인가요?");
  await page.getByRole("button", { name: "Ask 실행" }).click();
  await expect(page.getByText("Ask 결과를 준비했습니다.")).toBeVisible();

  await page.getByRole("button", { name: "Brief", exact: true }).click();
  await page.getByRole("button", { name: "Brief 실행" }).click();
  await expect(page.getByText("Brief 결과를 준비했습니다.")).toBeVisible();

  await page.getByRole("button", { name: "Polish", exact: true }).click();
  await page.getByRole("radio", { name: "텍스트 윤문" }).check();
  await page.getByLabel("윤문할 텍스트 입력").fill("운임 현황을 검토 부탁드립니다.");
  await page.getByRole("button", { name: "Polish 실행" }).click();
  await expect(page.getByText(/윤문 완료 · 변경 제안 0건 · 변경 없음 1건/)).toBeVisible();

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "AI 문장 검수" }).click();
  await expect(page.getByText(/AI 문장 검수 .*제안/)).toBeVisible();

  await page.getByRole("button", { name: "Extract", exact: true }).click();
  await page.getByRole("radio", { name: "항목 지정" }).check();
  await page.getByLabel("추출할 항목").fill("존재하지 않는 항목");
  await page.getByRole("button", { name: "항목 추가" }).click();
  await page.getByRole("button", { name: "Extract 실행" }).click();
  await expect(page.getByText("추출 항목 0개 · 확인 필요 1개")).toBeVisible();

  expect([...seen].sort()).toEqual(["ask", "brief", "extract", "polish", "semantic-check"]);
});


test("reviews PPTX writing, consistency and data findings with filters and exact slide evidence", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();

  // Left summary reads the review areas, the panel on the right the severity.
  const overview = page.locator(".qa-overview");
  await expect(overview.getByRole("heading", { name: "문서 제출 전 최종 검수" })).toBeVisible();
  await expect(overview.locator(".check-summary-line")).toContainText("Writing");
  await expect(overview.locator(".check-summary-line")).not.toContainText("Critical");
  await expect(overview.locator(".qa-summary")).toContainText("Critical");
  // Low-confidence findings stay hidden: the toggle is not in the main filters.
  await expect(page.getByText("낮은 확신 포함")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "용어 사전" })).toBeVisible();
  const typo = page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" });
  await expect(typo).toContainText("Spelling");
  await expect(typo).toContainText("HIGH");
  await expect(typo.locator(".source-locator")).toHaveText("Slide 1 · 본문");
  await expect(typo.getByRole("button", { name: "Slide 1 · 본문 근거 보기" })).toBeVisible();
  // The file is named once per row, never again inside the source cell.
  expect((await typo.innerText()).split("최종검수.pptx").length - 1).toBe(1);
  // 상세 보기 belongs to the issue, 근거 보기 to the evidence column.
  await expect(typo.locator(".check-issue-name .issue-detail-toggle")).toHaveText("상세 보기");
  await expect(typo.locator(".check-source .issue-detail-toggle")).toHaveCount(0);
  await typo.getByRole("button", { name: /한글 맞춤법 오류 가능성 상세 보기/ }).click();
  await expect(typo).toContainText("향후 13주 유가 전먕");
  await expect(typo).toContainText("향후 13주 유가 전망");
  // The expanded panel explains the finding; it never repeats the source list.
  await expect(typo.locator(".check-issue-detail .result-source")).toHaveCount(0);
  await expect(typo.locator(".check-issue-detail")).toContainText("Actions");
  await expect(typo.locator(".result-source")).toHaveCount(1);

  await page.getByRole("button", { name: /Consistency/ }).click();
  await expect(page.locator(".check-issue").filter({ hasText: "용어 일관성" })).toHaveCount(1);
  await expect(page.locator(".check-issue").filter({ hasText: "한글 맞춤법 오류 가능성" })).toHaveCount(0);
  await page.getByRole("button", { name: /^All/ }).last().click();
  await page.getByRole("button", { name: /Warning/ }).click();
  await expect(page.locator(".check-issue").first()).toBeVisible();
  await expect(page.locator(".check-issue.severity-suggestion")).toHaveCount(0);

  await expect(page.getByRole("button", { name: "AI 문장 검수" })).toBeVisible();
});

test("keeps the personal dictionary and ignore actions inside this browser", async ({ page, browser }) => {
  await page.goto("/");
  await upload(page, files.checkPptx);
  await page.getByLabel("최종검수.pptx 선택").check();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();
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


test("moves upload out of the workspace once files exist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".dropzone")).toBeVisible();
  await expect(page.getByRole("button", { name: "파일 추가" })).toHaveCount(0);

  await upload(page, files.v1);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 추가" })).toBeVisible();

  // Adding another file still works from the context bar action.
  await upload(page, files.v2);
  await expect(page.locator(".file-row")).toHaveCount(2);

  await page.reload();
  await expect(page.locator(".dropzone")).toBeVisible();
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
});

test("keeps file context and upload controls out of utility destinations", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByRole("button", { name: "Dictionary" }).click();

  await expect(page.getByRole("heading", { name: "용어 사전", exact: true })).toBeVisible();
  await expect(page.locator(".context-files")).toHaveCount(0);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
  await expect(page.getByText("회사 공통 용어입니다. 관리자만 수정할 수 있습니다.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("공용 용어 검색")).toBeVisible();
  await expect(page.getByText("등록된 개인 용어가 없습니다.")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await expect(page.locator(".context-files")).toHaveCount(0);
  await expect(page.locator(".dropzone")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 추가" })).toHaveCount(0);
});

test("keeps a feature's completion notice inside that feature", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();

  // Another feature, the dictionary and the settings page own their own
  // status, so an Analyze result never announces itself there.
  for (const destination of ["Check", "Dictionary", "Settings"]) {
    await page.getByRole("button", { name: destination, exact: true }).click();
    await expect(page.locator(".notice")).toHaveCount(0);
  }

  // A workspace-level message is different: it concerns the whole tab.
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await sendFile(page, files.fake);
  await expect(page.locator(".notice.error")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".notice.error")).toBeVisible();
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

test("never fetches model weights or any third-party host during deterministic work", async ({ page }) => {
  const hosts: string[] = [];
  page.on("request", (request) => hosts.push(new URL(request.url()).host));
  await page.goto("/");
  await upload(page, files.v1);
  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Check 실행" }).click();
  await expect(page.getByText("콘텐츠 및 개인정보 점검을 완료했습니다.")).toBeVisible();

  // The model is downloaded lazily on the first AI request only, so a session
  // that never asks the model must stay on its own origin.
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
  const sourceButton = page.locator(".source-action").first();
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
  await page.locator(".results-panel .source-action").first().click();
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
