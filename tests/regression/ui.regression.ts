import { expect, type Page } from "@playwright/test";
import { createCheckPptx, createXlsx } from "../fixtures";
import { noHorizontalOverflow, openView, regressionCase, selectFiles, upload, writeFixture } from "./record";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
}
async function companyTerms(page: Page) {
  await page.route("**/api/company-terms", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { source: "d1", terms: [
      { id: 1, term: "근로계약", description: null, active: true },
      { id: 2, term: "ISO 27001", description: null, active: true },
      { id: 3, term: "R&D", description: null, active: true },
    ] } }),
  }));
}
async function checkDocument(page: Page) {
  await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }));
  await ready(page);
  const file = await writeFixture("ui-check.pptx", createCheckPptx());
  await upload(page, file);
  await selectFiles(page, file);
  await openView(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");
  await expect(page.locator(".check-issue").first()).toBeVisible();
}
async function law(page: Page, status: number, body: unknown) {
  await page.route("**/api/law*", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
  await ready(page);
  await openView(page, "법령");
  await page.getByRole("searchbox", { name: "법령명 또는 키워드 검색" }).fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
}
async function noRawLawMarkers(page: Page) {
  await expect(page.locator(".law-search-results")).not.toContainText(/\[(?:NOT_FOUND|FAILED)\]|MCP|api\/law|law_search|search_law/u);
}
const make = (id: number, category: "Dictionary" | "Settings" | "Law" | "UI", input: string, expected: string, mobile = false) => ({
  id: `UI-${String(id).padStart(2, "0")}`, category, input, format: "browser UI", structure: "interactive workspace", expected, mobile,
});

regressionCase(make(1, "Dictionary", "Korean company-term search", "A Korean term filters the company list"), async ({ page, note }) => {
  await companyTerms(page); await ready(page); await openView(page, "Dictionary");
  const search = page.getByRole("textbox", { name: "공용 용어 검색" });
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section h4').first()).toContainText("3");
  await search.fill("근로");
  const list = page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-term-list').first();
  await expect(list.locator(".dictionary-term")).toHaveCount(1);
  await expect(list).toContainText("근로계약");
  note("Korean substring 근로 returned the one company term 근로계약.");
});
regressionCase(make(2, "Dictionary", "Mixed English/digit company-term search", "ISO 27001 matches and unrelated entries disappear"), async ({ page, note }) => {
  await companyTerms(page); await ready(page); await openView(page, "Dictionary");
  await page.getByRole("textbox", { name: "공용 용어 검색" }).fill("iso 27001");
  const list = page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-term-list').first();
  await expect(list.locator(".dictionary-term")).toHaveCount(1);
  await expect(list).toContainText("ISO 27001"); note("Case-insensitive ISO 27001 yields exactly one company term.");
});
regressionCase(make(3, "Dictionary", "Special characters and no-result search", "Literal search neither executes nor invents matches"), async ({ page, note }) => {
  await companyTerms(page); await ready(page); await openView(page, "Dictionary");
  const search = page.getByRole("textbox", { name: "공용 용어 검색" });
  await search.fill("R&D");
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-term-list').first().locator(".dictionary-term")).toHaveCount(1);
  await search.fill("<script>[NOT_FOUND]</script>");
  await expect(page.getByText("일치하는 공용 용어가 없습니다.")).toBeVisible();
  expect(await page.locator('.settings-surface[aria-label="Dictionary"] script').count()).toBe(0);
  note("R&D matched literally; HTML-like unmatched input displayed only the safe no-results state.");
});
regressionCase(make(4, "Dictionary", "Long personal term persists then deletes", "64-character term survives reload and removal survives another reload", true), async ({ page, note }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await openView(page, "Dictionary");
  const term = "긴용어".repeat(12) + "A";
  await page.getByRole("textbox", { name: "개인 용어 추가" }).fill(term);
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await expect(page.getByRole("button", { name: `${term} 삭제` })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.reload(); await openView(page, "Dictionary");
  await expect(page.getByRole("button", { name: `${term} 삭제` })).toBeVisible();
  await page.getByRole("button", { name: `${term} 삭제` }).click();
  await expect(page.getByText("등록된 개인 용어가 없습니다.")).toBeVisible();
  await page.reload(); await openView(page, "Dictionary");
  await expect(page.getByText("등록된 개인 용어가 없습니다.")).toBeVisible();
  note("Long term persisted across reload, stayed within viewport, then removal persisted.");
});
regressionCase(make(5, "Dictionary", "Dictionary keyboard focus and submission", "Tab reaches search and Enter adds a personal term"), async ({ page, note }) => {
  await ready(page); await openView(page, "Dictionary");
  const search = page.getByRole("textbox", { name: "공용 용어 검색" });
  await search.focus(); await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /전체 보기/u })).toBeFocused();
  await page.keyboard.press("Tab");
  const entry = page.getByRole("textbox", { name: "개인 용어 추가" });
  await expect(entry).toBeFocused(); await entry.fill("키보드용어"); await entry.press("Enter");
  await expect(page.getByRole("button", { name: "키보드용어 삭제" })).toBeVisible();
  note("Tab navigation reached dictionary controls and Enter submitted a personal term.");
});
regressionCase(make(6, "Dictionary", "In-result dictionary popover", "Check result opens editable floating dictionary", true), async ({ page, note }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await checkDocument(page);
  const trigger = page.locator(".dictionary-trigger"); await trigger.click();
  const popup = page.getByRole("dialog", { name: "용어 사전" });
  await expect(popup).toBeVisible();
  await popup.getByRole("textbox", { name: "개인 용어 추가" }).fill("검수사전");
  await popup.getByRole("button", { name: "추가" }).click();
  await expect(popup.getByRole("button", { name: "검수사전 삭제" })).toBeVisible();
  const shadow = await popup.evaluate((e) => getComputedStyle(e).boxShadow);
  expect(shadow).not.toBe("none");
  note("Check result popover added a personal term and has floating shadow.");
});
regressionCase(make(7, "Settings", "Settings privacy and storage information", "Five explicit categories explain memory, local storage, AI and law"), async ({ page, note }) => {
  await ready(page); await openView(page, "Settings");
  const surface = page.locator('.settings-surface[aria-label="Settings"]');
  await expect(surface.locator("dt")).toHaveText(["저장 위치", "localStorage", "무시한 규칙", "서버 AI", "법령 기능 외부 연동"]);
  await expect(surface).toContainText("원본 파일은 전송하지 않습니다.");
  await expect(surface).toContainText("문서 본문, 근거, 질문과 답변은 브라우저 저장소에 저장하지 않습니다.");
  note("All five settings definitions explain storage and outbound processing.");
});
regressionCase(make(8, "Settings", "Ignored rule survives reload and can be restored", "Check ignores a rule persistently; Settings restore removes it"), async ({ page, note }) => {
  await checkDocument(page);
  const issue = page.locator(".check-issue").first();
  const total = Number(await page.locator(".check-filters-compact button").first().locator("b").innerText());
  await issue.getByRole("button", { name: "동일 규칙 무시" }).click();
  await expect.poll(async () => Number(await page.locator(".check-filters-compact button").first().locator("b").innerText())).toBeLessThan(total);
  await openView(page, "Settings");
  const restore = page.locator('.settings-surface[aria-label="Settings"]').getByRole("button", { name: /복원$/u }).first();
  await expect(restore).toBeVisible(); const rule = (await restore.getAttribute("aria-label"))!.replace(/ 복원$/u, "");
  await page.reload(); await openView(page, "Settings");
  await expect(page.getByRole("button", { name: `${rule} 복원` })).toBeVisible();
  await page.getByRole("button", { name: `${rule} 복원` }).click();
  await expect(page.getByText("없음", { exact: true })).toBeVisible();
  note(`Ignored rule ${rule} persisted over reload, and restoration cleared it.`);
});
regressionCase(make(9, "Settings", "Long settings text wraps at mobile width", "Every definition fits the viewport", true), async ({ page, note }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await openView(page, "Settings"); await noHorizontalOverflow(page);
  for (const dd of await page.locator(".settings-list dd").all()) {
    expect(await dd.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
  note("All settings definitions wrap without horizontal scrolling at 390px.");
});
regressionCase(make(10, "UI", "All guide categories show complete steps", "Every tab has three or four nonempty named steps", true), async ({ page, note }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await openView(page, "Guide");
  const tabs = page.getByRole("tablist", { name: "기능 선택" }).getByRole("tab");
  // The guide is lazily loaded; wait for its tabs before reading them.
  await expect(tabs).toHaveCount(11); const labels = await tabs.allTextContents();
  for (const label of labels) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    const panel = page.getByRole("tabpanel"); await expect(panel.getByRole("heading", { name: label, exact: true })).toBeVisible();
    const steps = panel.locator(".usage-guide-step"); const count = await steps.count();
    expect(count).toBeGreaterThanOrEqual(3); expect(count).toBeLessThanOrEqual(4);
    for (const step of await steps.all()) { await expect(step.locator(":scope > strong")).not.toBeEmpty(); await expect(step.locator(".usage-guide-text")).not.toBeEmpty(); }
    await noHorizontalOverflow(page);
  }
  note(`All ${labels.length} guide tabs rendered 3–4 descriptive steps at mobile width.`);
});
regressionCase(make(11, "UI", "Guide arrow/Home/End keyboard controls", "Roving tab focus and panel synchronize at both ends"), async ({ page, note }) => {
  await ready(page); await openView(page, "Guide");
  const analysis = page.getByRole("tab", { name: "분석" }); await analysis.focus();
  await analysis.press("ArrowLeft"); await expect(page.getByRole("tab", { name: "용어 사전" })).toBeFocused();
  await expect(page.getByRole("tabpanel")).toContainText("단어 추가");
  await page.keyboard.press("Home"); await expect(analysis).toBeFocused();
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("tab", { name: "질문" })).toBeFocused();
  await page.keyboard.press("End"); await expect(page.getByRole("tab", { name: "용어 사전" })).toBeFocused();
  note("Arrow keys wrap, Home/End select endpoints, and visible guide content follows focus.");
});
regressionCase(make(12, "Law", "Law FOUND result", "Named and dated result appears without internal markers"), async ({ page, note }) => {
  await law(page, 200, { data: { found: true, text: "internal raw", laws: [{ name: "근로기준법", lawId: "001872", status: "현행", kind: "법률", effectiveDate: "20260820" }] } });
  await expect(page.getByRole("heading", { name: "검색 결과 · 1건" })).toBeVisible();
  await expect(page.locator(".law-search-list li")).toContainText("시행일 2026.08.20");
  await expect(page.locator(".law-search-results")).not.toContainText("internal raw"); await noRawLawMarkers(page);
  note("FOUND rendered one named current law and formatted effective date without raw payload.");
});
regressionCase(make(13, "Law", "Law NOT_FOUND is an empty result", "Normal status, no error and no raw marker"), async ({ page, note }) => {
  await law(page, 200, { data: { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" } });
  await expect(page.getByRole("heading", { name: "검색 결과 · 0건" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "검색 결과가 없습니다." })).toBeVisible();
  await expect(page.locator(".law-search-error")).toHaveCount(0); await noRawLawMarkers(page);
  note("NOT_FOUND became a zero-result status, not an outage or raw API marker.");
});
regressionCase(make(14, "Law", "Law FAILED upstream response", "Safe error alert distinct from empty results"), async ({ page, note }) => {
  await law(page, 502, { error: { code: "FAILED", message: "법령 서비스를 이용할 수 없습니다." }, data: { marker: "FAILED" } });
  await expect(page.locator('.law-search-error[role="alert"]')).toHaveText("법령 서비스를 이용할 수 없습니다.");
  await expect(page.getByText("검색 결과가 없습니다.")).toHaveCount(0); await noRawLawMarkers(page);
  note("FAILED rendered the safe service-error alert, never an empty-results message.");
});
regressionCase(make(15, "Law", "Law upstream timeout 504", "Timeout message distinct from FAILED and NOT_FOUND"), async ({ page, note }) => {
  await law(page, 504, { error: { code: "LAW_UPSTREAM_TIMEOUT", message: "법령 검색 응답이 지연되고 있습니다." } });
  await expect(page.locator('.law-search-error[role="alert"]')).toHaveText("법령 검색 응답이 지연되고 있습니다.");
  await expect(page.getByText("법령 서비스를 이용할 수 없습니다.")).toHaveCount(0); await noRawLawMarkers(page);
  note("504 displayed a timeout-specific alert without upstream error identifiers.");
});
regressionCase(make(16, "UI", "Empty workspace and disabled operation", "Upload prompt exists; run stays disabled until selection"), async ({ page, note }) => {
  await ready(page);
  await expect(page.locator(".dropzone")).toContainText("파일 업로드");
  await expect(page.getByRole("button", { name: "분석 실행" })).toBeDisabled();
  await expect(page.locator(".file-row")).toHaveCount(0);
  note("Empty workspace showed upload affordance and disabled Analyze run.");
});
regressionCase(make(17, "UI", "Parsed file with no selection", "Upload alone does not enable execution"), async ({ page, note }) => {
  await ready(page);
  const file = await writeFixture("ui-unselected.xlsx", await createXlsx({ 데이터: [["구분", "수량"], ["완료", 4]] }));
  await upload(page, file);
  await expect(page.locator(".file-row")).toContainText("ui-unselected.xlsx");
  await expect(page.getByRole("button", { name: "분석 실행" })).toBeDisabled();
  note("Parsed XLSX was ready, yet Analyze remained disabled without selection.");
});
regressionCase(make(18, "UI", "Processing transition to success", "Slow AI request shows busy state then complete result"), async ({ page, note }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/ai", async (route) => { await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }); });
  await ready(page);
  const file = await writeFixture("ui-progress.pptx", createCheckPptx()); await upload(page, file); await selectFiles(page, file); await openView(page, "검수");
  await page.getByRole("button", { name: "검수 실행" }).click();
  await expect(page.getByRole("button", { name: "검수 실행" })).toBeDisabled();
  await expect(page.locator(".workspace")).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.locator(".results-panel .result-status")).toHaveText("검수 완료");
  await expect(page.getByRole("button", { name: "검수 실행" })).toBeEnabled();
  note("Check entered aria-busy disabled-run processing, then delivered a successful result.");
});
regressionCase(make(19, "UI", "Upload warning/error then retry", "Invalid signature gets alert; later valid file succeeds"), async ({ page, note, classify }) => {
  await ready(page);
  const invalid = await writeFixture("ui-broken.pdf", "not a pdf file");
  await page.getByLabel("작업 파일 선택").setInputFiles(invalid);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("파일 확장자와 실제 내용이 일치하지 않습니다.");
  classify("Expected");
  const valid = await writeFixture("ui-retry.csv", "지역,금액\r\n서울,145000\r\n");
  await upload(page, valid);
  await expect(page.locator(".file-row")).toContainText("ui-retry.csv");
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
  note("Invalid PDF signature was announced in an alert; retrying with CSV produced a ready row.");
});
regressionCase(make(20, "UI", "Unsupported aggregation warning", "CSV selected for aggregation gives explicit warning status"), async ({ page, note, classify }) => {
  await ready(page);
  const csv = await writeFixture("ui-aggregate.csv", "항목,값\r\n합계,12\r\n");
  await upload(page, csv); await selectFiles(page, csv); await openView(page, "취합");
  await expect(page.locator('.aggregation-selection-error[role="status"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "취합 실행" })).toBeDisabled();
  classify("Unsupported"); note("CSV aggregation selection exposed a status warning and disabled run.");
});
regressionCase(make(21, "UI", "Elevation and structural primary button audit", "Surfaces/CTA lifted, secondary controls flat, every operation-actions last button runs", false), async ({ page, note }) => {
  await ready(page);
  const csv = await writeFixture("ui-shadows.csv", "항목,값\r\n계,4\r\n"); await upload(page, csv); await selectFiles(page, csv);
  const shadow = (selector: string) => page.locator(selector).first().evaluate((e) => getComputedStyle(e).boxShadow);
  expect(await shadow(".file-list")).not.toBe("none");
  await expect(page.locator(".operation-actions button:last-child")).toHaveAttribute("aria-label", "분석 실행");
  expect(await shadow(".operation-actions button:last-child")).not.toBe("none");
  expect(await shadow(".delete-selected")).toBe("none"); expect(await shadow(".delete-all")).toBe("none");
  for (const view of ["분석", "질문", "비교", "검수", "윤문", "취합"] as const) {
    await openView(page, view);
    const last = page.locator(".operation-actions button:last-child");
    await expect(last).toHaveCount(1);
    await expect(last).toHaveAttribute("aria-label", `${view} 실행`);
  }
  await openView(page, "추출");
  await expect(page.locator(".operation-actions")).toHaveCount(0);
  await expect(page.locator(".extract-run")).toHaveAttribute("type", "button");
  await openView(page, "Dictionary"); expect(await shadow(".settings-surface")).not.toBe("none");
  note("Six operation-actions each end in their actual run CTA; Extract uses dedicated extract-run; primary/surface lifted and destructive controls flat.");
});
regressionCase(make(22, "UI", "Keyboard rail, run, focus outline and image names", "Keyboard traverses navigation to run; visible focus and accessible images"), async ({ page, note }) => {
  await ready(page);
  const csv = await writeFixture("ui-keyboard.csv", "항목,값\r\n제품,42\r\n"); await upload(page, csv); await selectFiles(page, csv);
  const rail = page.locator(".rail").getByRole("button", { name: "분석", exact: true });
  await rail.focus(); await expect(rail).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.locator(".rail").getByRole("button", { name: "질문" })).toBeFocused();
  await page.keyboard.press("Tab");
  await rail.focus();
  const outline = await rail.evaluate((e) => getComputedStyle(e).outlineStyle); expect(outline).not.toBe("none");
  const run = page.getByRole("button", { name: "분석 실행" }); await run.focus(); await expect(run).toBeFocused();
  expect(await run.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe("none");
  const unnamedImages = await page.locator("img:not([alt])").count(); expect(unnamedImages).toBe(0);
  note("Rail Tab advanced to next view, run accepted focus, focus indicator computed non-none, every image has alt.");
});
regressionCase(make(23, "UI", "Evidence drawer focus restoration and mobile layer", "Inspector takes focus and returns it on close; overlays sticky controls", true), async ({ page, note }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await checkDocument(page);
  const trigger = page.locator(".check-issue .source-action").first(); await trigger.click();
  const drawer = page.getByRole("complementary", { name: "근거 상세" }); await expect(drawer).toBeVisible();
  await expect(drawer).toBeFocused();
  const layer = await drawer.evaluate((e) => ({ box: e.getBoundingClientRect().toJSON(), z: Number(getComputedStyle(e.closest(".evidence-inspector")!).zIndex), header: Number(getComputedStyle(document.querySelector(".context-bar")!).zIndex) || 0 }));
  expect(layer.box.right).toBeLessThanOrEqual(390); expect(layer.z).toBeGreaterThan(layer.header);
  await drawer.getByRole("button", { name: "닫기" }).click(); await expect(trigger).toBeFocused();
  note(`Mobile inspector focused, z-index ${layer.z} overtopped header ${layer.header}, then focus returned to evidence button.`);
});
regressionCase(make(24, "UI", "Every rail view with a long uploaded filename", "All thirteen destinations fit 390px; transient toast visible and floating", true), async ({ page, note }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page);
  const filename = `${"긴파일이름".repeat(19)}.csv`;
  const file = await writeFixture(filename, "항목,값\r\n제품,42\r\n"); await upload(page, file);
  for (const view of ["분석", "질문", "비교", "검수", "윤문", "추출", "취합", "법령", "PDF 도구", "이미지 도구", "Guide", "Dictionary", "Settings"]) {
    await openView(page, view);
    await expect(page.locator(".context-bar h1")).toBeVisible(); await noHorizontalOverflow(page);
  }
  await openView(page, "분석"); await selectFiles(page, file);
  await page.getByRole("button", { name: "선택 삭제" }).click();
  const toast = page.locator(".transient-status"); await expect(toast).toBeVisible();
  expect(await toast.evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe("none");
  await noHorizontalOverflow(page);
  note("All 13 rail destinations fit at 390px with a long filename, and deletion toast was visible with floating elevation.");
});
regressionCase(make(25, "UI", "Tab and icon controls elevation", "Inactive tabs and icon buttons flat; an active tab uses only the subtle --elevation-active"), async ({ page, note }) => {
  await ready(page);
  const activeToken = await page.evaluate(() => {
    const probe = document.createElement("div"); probe.style.boxShadow = "var(--elevation-active)"; document.body.append(probe);
    const value = getComputedStyle(probe).boxShadow; probe.remove(); return value;
  });
  await openView(page, "Guide");
  const guideActive = await page.getByRole("tab", { name: "분석" }).evaluate((e) => getComputedStyle(e).boxShadow);
  const guideIdle = await page.getByRole("tab", { name: "질문" }).evaluate((e) => getComputedStyle(e).boxShadow);
  await openView(page, "법령");
  const lawIdle = await page.locator('.law-view-tabs button[aria-pressed="false"]').first().evaluate((e) => getComputedStyle(e).boxShadow);
  const a = await writeFixture("ui-swap-a.csv", "항목,값\r\nX,2\r\n");
  const b = await writeFixture("ui-swap-b.csv", "항목,값\r\nX,3\r\n");
  await openView(page, "비교"); await upload(page, a, b); await selectFiles(page, a, b);
  const iconShadow = await page.locator(".compare-swap-icon").evaluate((e) => getComputedStyle(e).boxShadow);
  // The requested guide tab design allows "아주 미세한 active shadow"; it must be the shared token, nothing stronger.
  expect(guideActive).toBe(activeToken);
  expect(guideIdle).toBe("none"); expect(lawIdle).toBe("none"); expect(iconShadow).toBe("none");
  note(`active guide tab = --elevation-active (${activeToken}); idle guide/law tabs and swap icon flat`);
});
