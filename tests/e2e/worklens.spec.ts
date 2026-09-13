import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDocx, createPdf, createPptx, createXlsx, RATE_SHEET_V1, RATE_SHEET_V2 } from "../fixtures";
import { E2E } from "../../playwright.config";

const FIXTURE_DIR = path.join(process.cwd(), "artifacts", "fixtures");
const files = {
  v1: path.join(FIXTURE_DIR, "운임현황_v1.xlsx"),
  v1Copy: path.join(FIXTURE_DIR, "운임현황_v1_사본.xlsx"),
  v2: path.join(FIXTURE_DIR, "운임현황_v2.xlsx"),
  pdf: path.join(FIXTURE_DIR, "계약서.pdf"),
  csv: path.join(FIXTURE_DIR, "운임.csv"),
  docx: path.join(FIXTURE_DIR, "계약.docx"),
  pptx: path.join(FIXTURE_DIR, "계획.pptx"),
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
  await expect(page.getByRole("heading", { name: "분석 파일" })).toBeVisible();
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
  const uploaded = await page.evaluate(async () => (await (await fetch("/api/files")).json()).data.files[0].id);
  const noStore = await page.evaluate(async (fileId) => {
    const csrf = (await (await fetch("/api/session", { method: "POST" })).json()).data.csrfToken;
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-worklens-csrf": csrf },
      body: JSON.stringify({ fileIds: [fileId] }),
    });
    return { status: response.status, cacheControl: response.headers.get("cache-control") };
  }, uploaded);
  expect(noStore.status).toBe(200);
  expect(noStore.cacheControl).toContain("no-store");
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

test("rejects a disguised file with an actionable message", async ({ page }) => {
  await page.goto("/");
  await sendFile(page, files.fake);
  await expect(page.locator(".notice.error")).toContainText("파일 확장자와 실제 내용이 일치하지 않습니다");
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
});

test("isolates files between anonymous sessions", async ({ page, browser }) => {
  await page.goto("/");
  await upload(page, files.v1);

  const ownerFiles = await page.evaluate(async () => {
    const response = await fetch("/api/files");
    return { status: response.status, body: await response.json() };
  });
  expect(ownerFiles.status).toBe(200);
  expect(ownerFiles.body.data.files.length).toBe(1);
  const fileId: string = ownerFiles.body.data.files[0].id;
  const crossSite = await page.request.post("/api/check", {
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    data: { fileIds: [fileId] },
  });
  expect(crossSite.status()).toBe(403);
  expect(JSON.stringify(await crossSite.json())).not.toContain("운임현황");

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();

  const stolen = await otherPage.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/session", { method: "POST" })).json()).data.csrfToken;
    const response = await fetch("/api/compare", {
      method: "POST",
      headers: { "content-type": "application/json", "x-worklens-csrf": csrf },
      body: JSON.stringify({ baseFileId: id, targetFileId: id }),
    });
    return { status: response.status, body: await response.json() };
  }, fileId);
  expect([400, 404, 410]).toContain(stolen.status);
  expect(JSON.stringify(stolen.body)).not.toContain("운임현황");
  await otherContext.close();
});

test("never caches session responses", async ({ page }) => {
  const response = await page.request.post("/api/session", {
    headers: { origin: new URL(page.url() || "http://127.0.0.1:3311").origin },
  });
  expect(response.headers()["cache-control"]).toContain("no-store");
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

test("deletes temporary data when the session expires", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  const before = await readdir(E2E.TEMP_DIR);
  expect(before.length).toBeGreaterThan(0);

  await page.getByLabel("운임현황_v1.xlsx 선택").check();
  await page.getByRole("button", { name: "Analyze 실행" }).click();
  await expect(page.getByText("구조 및 수치 분석을 완료했습니다.")).toBeVisible();
  await page.locator(".results-panel .source-link").first().click();
  await expect(page.getByLabel("Source detail")).toBeVisible();

  // Do not wait for a later 410 — the client tracks the server-issued expiresAt
  // and must clear sensitive on-screen content proactively when it elapses.
  await page.evaluate(() => {
    const heartbeat = (window as unknown as { __worklensHeartbeat?: number }).__worklensHeartbeat;
    if (heartbeat !== undefined) window.clearInterval(heartbeat);
  });

  await expect(page.getByRole("heading", { name: "세션이 만료되었습니다" })).toBeVisible({ timeout: E2E.TTL_MS + 5000 });
  await expect(page.getByText("운임현황_v1.xlsx")).toHaveCount(0);
  await expect(page.getByLabel("Source detail")).toHaveCount(0);
  await expect(page.locator(".results-panel")).toHaveCount(0);

  const expired = await page.evaluate(async () => {
    const response = await fetch("/api/files");
    return { status: response.status, body: await response.json() };
  });
  expect(expired.status).toBe(410);
  expect(expired.body.error.code).toBe("SESSION_EXPIRED");
  const expiredExport = await page.evaluate(async () => (await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json", "x-worklens-csrf": "expired-session-token" },
    body: JSON.stringify({ fileIds: ["00000000-0000-4000-8000-000000000000"], format: "csv" }),
  })).status);
  expect(expiredExport).toBe(403);

  for (const directory of await readdir(E2E.TEMP_DIR)) {
    const contents = await readdir(path.join(E2E.TEMP_DIR, directory));
    expect(contents.filter((entry) => entry.endsWith(".xlsx"))).toEqual([]);
  }
});

test("releases the workspace when the tab goes away", async ({ page }) => {
  let lease: { tabId: string; releaseToken: string; releaseNonce: string } | undefined;
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/session/tabs") && response.request().method() === "POST" && response.ok()) {
      const data = (await response.json()).data;
      lease ??= { tabId: data.tabId, releaseToken: data.releaseToken, releaseNonce: data.releaseNonce };
    }
  });
  await page.goto("/");
  await upload(page, files.v1);
  await expect.poll(() => lease).toBeDefined();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  expect(lease).toBeDefined();
  const released = await page.evaluate(async (value) => {
    const response = await fetch("/api/session/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId: value.tabId, releaseNonce: value.releaseNonce }),
    });
    return { status: response.status, body: await response.text() };
  }, lease!);
  expect(released.status, `${JSON.stringify(lease)} ${released.body}`).toBe(200);
  const resumed = await page.evaluate(async () => (await fetch("/api/files")).status);
  expect(resumed).toBe(200);
  const secondLease = await page.evaluate(async () => {
    const csrf = (await (await fetch("/api/session", { method: "POST" })).json()).data.csrfToken;
    const data = (await (await fetch("/api/session/tabs", {
      method: "POST",
      headers: { "x-worklens-csrf": csrf },
    })).json()).data;
    return { tabId: data.tabId, releaseNonce: data.releaseNonce };
  });
  await page.evaluate(() => {
    const heartbeat = (window as unknown as { __worklensHeartbeat?: number }).__worklensHeartbeat;
    if (heartbeat !== undefined) window.clearInterval(heartbeat);
  });
  await page.evaluate(async (value) => fetch("/api/session/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  }), secondLease);
  await page.waitForTimeout(16_000);
  const afterGrace = await page.evaluate(async () => (await fetch("/api/files")).status);
  expect(afterGrace).toBe(410);
});

test("explicitly deletes all temporary data and starts a clean session", async ({ page }) => {
  await page.goto("/");
  await upload(page, files.v1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "모두 삭제" }).click();
  await expect(page.getByRole("heading", { name: "세션이 만료되었습니다" })).toBeVisible();
  await page.getByRole("button", { name: "새 세션 시작" }).click();
  await expect(page.getByText("아직 파일이 없습니다.", { exact: false })).toBeVisible();
});
