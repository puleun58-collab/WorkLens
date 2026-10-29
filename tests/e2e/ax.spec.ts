import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxState, type AxDiagnosis, type AxPlan } from "../../src/lib/ax/types";
import { buildAllInOnePrompt, TOOL_GUIDES } from "../../src/lib/ax/guide";
import { exportAxState } from "../../src/lib/ax/transfer";
import { equipmentRuleCase } from "../fixtures/ax-agent-cases";
import { waitForFactorControlReady } from "./ax-ready-state";
async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
async function register(page: Page, name = "월간 취합") {
  await page.getByLabel("업무명", { exact: true }).fill(name);
  await page.getByLabel("업무 설명", { exact: true }).fill("매월 입력 표를 취합하고 담당자가 최종 승인합니다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
}
async function seed(page: Page, value: unknown) {
  await page.evaluate(async record => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(record, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, value);
}
async function record(page: Page): Promise<AxState | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise<AxState | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
    db.close(); return value;
  });
}
async function dataAction(page: Page, name: "데이터 내보내기" | "데이터 가져오기" | "데이터 초기화") {
  await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function importData(page: Page, content: string) {
  const chooser = page.waitForEvent("filechooser");
  await dataAction(page, "데이터 가져오기");
  await (await chooser).setFiles({ name: "ax.json", mimeType: "application/json", buffer: Buffer.from(content) });
}
function mock(page: Page, calls: Record<string, unknown>[] = []) {
  return page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON(); calls.push(req);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
  });
}
async function expectCopyUX(page: Page, section: Locator, tool: "Codex" | "Claude Code") {
  const button = section.getByRole("button", { name: `${tool}용 올인원 지시문 복사`, exact: true });
  const prompt = section.locator(".ax-prompt");
  if (test.info().project.name.startsWith("chromium")) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await button.click();
    await expect(button).toHaveAttribute("data-copied", "true");
    await expect(section.locator(".ax-copy-error")).toHaveCount(0);
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"))
      .toBe((await prompt.textContent())!.replace(/\r\n/g, "\n"));
    await expect(button).not.toHaveAttribute("data-copied", "true", { timeout: 3_000 });
  }
}
test("AX ellipsis menu, keyboard controls and segmented steps", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/"); await ax(page);
  const view = page.getByRole("region", { name: "업무 자동화 진단", exact: true });
  await expect(view.getByText("AI•AX 데이터는 현재 브라우저에 저장됩니다", { exact: true })).toHaveCount(0);
  await expect(view.getByText("이 브라우저에 저장됨", { exact: true })).toHaveCount(0);
  await expect(view.getByText("저장 중", { exact: true })).toHaveCount(0);
  await expect(view.getByRole("button", { name: "데이터 관리", exact: true })).toHaveCount(0);
  const trigger = view.getByRole("button", { name: "AI•AX 데이터 작업", exact: true });
  await expect(trigger).toBeVisible(); await expect(trigger).toBeEnabled();
  await expect(page.getByLabel("AI•AX 데이터 가져오기 파일")).toBeHidden();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible(); await expect(menu.getByRole("menuitem")).toHaveCount(3);
  for (const name of ["데이터 내보내기", "데이터 가져오기", "데이터 초기화"]) {
    await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole("separator")).toHaveCount(1);
  await expect(menu.getByRole("menuitem", { name: "데이터 초기화", exact: true })).toHaveAttribute("data-variant", "destructive");
  await expect(menu).not.toContainText("AI•AX");
  await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible();
  await trigger.focus(); await page.keyboard.press("Enter"); await expect(menu).toBeVisible();
  await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible(); await expect(trigger).toBeFocused();
  const steps = view.getByRole("tablist", { name: "진단 단계" });
  await expect(steps.getByRole("tab")).toHaveText(["업무 등록", "업무 진단", "자동화 매트릭스", "결과·로드맵"]);
  expect(await steps.evaluate(list => list.scrollWidth <= list.clientWidth && getComputedStyle(list).overflowX === "visible" && getComputedStyle(list).overflowY === "visible")).toBe(true);
  expect(await steps.getByRole("tab").evaluateAll(tabs => {
    const widths = tabs.map(tab => tab.getBoundingClientRect().width);
    return Math.max(...widths) - Math.min(...widths) <= 2;
  })).toBe(true);
  await expect(steps.getByRole("tab").first()).toHaveAttribute("data-active", "");
  expect(await steps.locator('[data-slot="tab-indicator"]').evaluate(indicator => !["transparent", "rgba(0, 0, 0, 0)"].includes(getComputedStyle(indicator).backgroundColor))).toBe(true);
  await page.screenshot({ path: `artifacts/ax/registration-desktop-${test.info().project.name}.png` });
});
test("AX registration labels and common empty states", async ({ page }) => {
  await page.goto("/"); await ax(page);
  await expect(page.getByLabel("업무 설명", { exact: true })).toHaveAttribute("required", "");
  await expect(page.locator("form.ax-register")).toBeVisible();
  await expect(page.getByLabel("등록 업무 목록")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "업무 목록", exact: true })).toHaveCount(0);
  await expect(page.getByText("등록된 업무가 없습니다", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "여러 업무 일괄 추가" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다음 단계", exact: true })).toBeDisabled();
  const details = page.getByRole("button", { name: "추가 정보", exact: true });
  const closedBackground = await details.evaluate(element => getComputedStyle(element).backgroundColor);
  await details.click(); await expect(details).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(0, 0);
  await expect.poll(() => details.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(closedBackground);
  for (const [label, placeholder] of [
    ["수행 주기", "예: 매주 월요일, 매월 말일, 필요 시"], ["1회 소요 시간(분)", "예: 30"], ["월 수행 횟수", "예: 8"],
    ["사용 시스템", "예: Excel, ERP, 사내 시스템"], ["입력 자료", "예: 정산 Excel, 청구서, 시스템 조회 데이터"],
    ["산출물", "예: 월간 정산표, 검토 결과, 보고서"], ["담당자 판단·승인 단계", "예: 예외 건 검토, 금액 확인, 최종 승인"],
  ]) await expect(page.getByLabel(label, { exact: true })).toHaveAttribute("placeholder", placeholder);
  await expect(page.getByLabel("1회 소요 시간(분)", { exact: true })).toHaveAttribute("type", "number");
  await expect(page.getByLabel("월 수행 횟수", { exact: true })).toHaveAttribute("type", "number");
  await expect(page.getByText("담당자가 처리·판단하는 단계", { exact: true })).toHaveCount(0);
  const steps = page.getByRole("tablist", { name: "진단 단계", exact: true });
  const target = steps.getByRole("tab", { name: "자동화 매트릭스", exact: true }); const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  const pressed = await steps.evaluate(list => [...list.querySelectorAll('[role="tab"]')].map(tab => ({ active: tab.hasAttribute("data-active"), alpha: Number(/\/\s*([\d.]+)\)$/.exec(getComputedStyle(tab).backgroundColor)?.[1] ?? (getComputedStyle(tab).backgroundColor === "rgba(0, 0, 0, 0)" ? 0 : 1)) })));
  await page.mouse.up();
  expect(pressed.filter(tab => tab.active)).toHaveLength(1);
  for (const tab of pressed.filter(tab => !tab.active)) expect(tab.alpha).toBeLessThanOrEqual(0.06);
  for (const tab of ["업무 진단", "자동화 매트릭스", "결과·로드맵"]) {
    const trigger = page.getByRole("tab", { name: tab, exact: true });
    await trigger.click();
    const panel = page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
    await expect(panel.locator(".ax-empty")).toBeVisible();
    await expect(panel.getByRole("heading")).toHaveCount(0);
  }
});
test("AX registration → diagnosis → correction → matrix → plans → reload → export/reset/import", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.route("**/api/ai", async route => { await page.waitForTimeout(800); await route.fallback(); }, { times: 1 });
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByRole("button", { name: "진단 중…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "AI 작업 중지" })).toHaveCount(0);
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  await expect(page.locator(".ax-score-cards").getByText("담당자 판단 필요도", { exact: true })).toBeVisible();
  for (const old of ["사람 판단 의존도", "담당자 판단 의존도", "선행 확인 필요", "실행 가능성"]) await expect(page.getByText(old, { exact: false })).toHaveCount(0);
  await expect(page.locator(".ax-diag-card .ax-gate-badge")).toBeVisible();
  const diagChecks = page.locator(".ax-diag-card .ax-diag-checks");
  await expect(diagChecks).toContainText("시스템 접근");
  await expect(diagChecks.getByText("확인 필요", { exact: true })).toBeVisible();
  await expect(page.getByText("먼저 확인", { exact: false })).toHaveCount(0);
  await expect(page.locator(".ax-data-actions .ax-utility-message")).toHaveText("업무 진단을 완료했습니다. 필요한 경우 점수를 조정하세요.");
  // 유틸리티 메시지는 단계 박스 위에 있고, 관리 메뉴는 단계 박스 내부 우측 끝에 있다.
  const utility = await page.evaluate(() => { const message = document.querySelector(".ax-utility-message")!.getBoundingClientRect(), menu = document.querySelector('[aria-label="AI•AX 데이터 작업"]')!.getBoundingClientRect(), steps = document.querySelector(".ax-steps")!.getBoundingClientRect(); return { messageAboveSteps: message.bottom <= steps.top, menuInsideSteps: menu.top >= steps.top && menu.bottom <= steps.bottom && menu.left >= steps.left && menu.right <= steps.right, menuAtRightEnd: steps.right - menu.right <= 8 }; });
  expect(utility).toEqual({ messageAboveSteps: true, menuInsideSteps: true, menuAtRightEnd: true });
  // 레이더 차트는 제거됨 — Factor 점수는 진단 항목·점수 카드에서만 확인한다.
  await expect(page.locator(".ax-radar")).toHaveCount(0);
  await expect(page.getByText("진단 항목 분포", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `artifacts/ax/diagnosis-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  // 펼침 높이 전환(200ms) 중 보정 클릭·hover를 하면 패널 내부 스크롤·복원과
  // 부드러운 페이지 스크롤이 겹쳐 툴팁이 관측되지 않는 CI 실패 계열이 있다.
  // 펼침 완료·패널 스크롤 정착·위치 준비를 관측 가능한 조건으로 확인한 뒤
  // 보정한다. 임의 sleep·timeout 확대·reducedMotion은 쓰지 않는다.
  // L167 hover+툴팁 단언은 ax-tooltip-ready.spec.ts로 분리됐다.
  await waitForFactorControlReady(page.getByRole("button", { name: "반복성 1점", exact: true }));
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await expect(page.getByText("사용자 보정 완료", { exact: true }).last()).toBeVisible();
  const reset = page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true });
  await expect(page.getByRole("button", { name: "AI 값으로", exact: true })).toHaveCount(0);
  await expect(reset).toHaveCount(1); await expect(reset).toBeEnabled();
  await expect(reset.locator("svg.lucide-rotate-ccw")).toHaveCount(1);
  await page.locator(".ax-factor-row").first().screenshot({ path: `artifacts/ax/factor-reset-${test.info().project.name}.png` });
  await reset.click(); await expect(reset).toHaveCount(0);
  // A correction equal to the AI suggestion leaves nothing to restore.
  await page.getByRole("button", { name: "반복성 4점", exact: true }).click(); await expect(reset).toHaveCount(0);
  await expect(page.locator(".ax-factor-corrected")).toHaveCount(0);
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click(); await expect(reset).toBeEnabled();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: false }).click();
  await expect(page.getByLabel("매트릭스 업무 목록")).toContainText("가치 3 · 실현 4");
  // 매트릭스 하단 TOP 3는 제거됨 — 분류·축 점수는 선택 업무 상세 분석에서 확인한다.
  await expect(page.locator(".ax-matrix-detail .ax-region-chip")).toHaveText("검토 후보");
  // 축 점수는 점수 카드에서 확인한다. 핵심 판단 근거 영역은 간소화로 제거됐고,
  // 고유 근거는 단일 '점수 근거 확인' 펼침의 Factor 근거에서 확인한다.
  await expect(page.locator(".ax-matrix-detail")).toContainText("자동화 가치 5점 만점에 3점");
  await expect(page.locator(".ax-matrix-detail")).toContainText("기술 실현 가능성 5점 만점에 4점");
  await expect(page.locator(".ax-matrix-detail .ax-matrix-rationale")).toHaveCount(0);
  await page.locator(".ax-matrix-detail").getByRole("button", { name: "점수 근거 확인", exact: true }).click();
  await expect(page.locator(".ax-matrix-detail")).toContainText("규칙성");
  await expect(page.locator(".ax-matrix-detail")).toContainText("등록된 반복 업무와 승인 조건 근거");
  await expect(page.locator(".ax-matrix-detail")).not.toContainText("자동화 가치 3점 · 기술 실현 가능성 4점");
  const matrix = await page.evaluate(() => {
    const header = document.querySelector(".ax-matrix-header")!.getBoundingClientRect(), chart = document.querySelector(".ax-matrix")!.getBoundingClientRect();
    const origin = document.querySelector(".ax-x-tick.is-origin")!.getBoundingClientRect();
    const center = (box: DOMRect) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
    const bubbles = [...document.querySelectorAll<HTMLElement>(".ax-bubble")].map(bubble => {
      const button = center(bubble.getBoundingClientRect());
      const dot = center(bubble.querySelector(".ax-bubble-dot")!.getBoundingClientRect());
      return {
        xError: Math.abs(button.x - (chart.left + parseFloat(bubble.style.left) / 100 * chart.width)),
        yError: Math.abs(button.y - (chart.bottom - parseFloat(bubble.style.bottom) / 100 * chart.height)),
        dotXError: Math.abs(dot.x - button.x), dotYError: Math.abs(dot.y - button.y),
      };
    });
    const yTicks = [...document.querySelectorAll(".ax-y-tick")].filter(tick => tick.textContent?.trim()).map(tick => {
      const point = center(tick.getBoundingClientRect()), value = Number(tick.textContent);
      return { value, ...point, error: Math.abs(point.y - (chart.bottom - (value - 1) / 4 * chart.height)) };
    });
    // The shared "1" sits outside both axes; check its crossing separately.
    const xTicks = [...document.querySelectorAll(".ax-x-tick:not(.is-origin)")].map(tick => {
      const point = center(tick.getBoundingClientRect()), value = Number(tick.textContent);
      return { value, ...point, error: Math.abs(point.x - (chart.left + (value - 1) / 4 * chart.width)) };
    });
    const originCenter = center(origin);
    const originXError = Math.abs(originCenter.x - yTicks.find(tick => tick.value === 2)!.x);
    const originYError = Math.abs(originCenter.y - xTicks.find(tick => tick.value === 2)!.y);
    return { gap: chart.top - header.bottom, y: [...document.querySelectorAll(".ax-y-tick")].map(t => t.textContent), x: [...document.querySelectorAll(".ax-x-tick")].map(t => t.textContent), originLeftOfChart: origin.right <= chart.left + 1, originBelowChart: (origin.top + origin.bottom) / 2 >= chart.bottom, gapX: chart.left - origin.right, gapY: origin.top - chart.bottom, bubbles, yTicks, xTicks, originXError, originYError };
  });
  expect(matrix.y).toEqual(["", "2", "3", "4", "5"]);
  expect(matrix.x).toEqual(["1", "2", "3", "4", "5"]);
  expect(matrix.gap).toBeLessThanOrEqual(32);
  expect(matrix.originLeftOfChart && matrix.originBelowChart).toBe(true);
  expect(Math.abs(matrix.gapX - matrix.gapY)).toBeLessThanOrEqual(2);
  expect(matrix.bubbles.length).toBeGreaterThan(0);
  for (const bubble of matrix.bubbles) {
    expect(bubble.xError).toBeLessThanOrEqual(1.5);
    expect(bubble.yError).toBeLessThanOrEqual(1.5);
    expect(bubble.dotXError).toBeLessThanOrEqual(1);
    expect(bubble.dotYError).toBeLessThanOrEqual(1);
  }
  expect(matrix.yTicks.map(tick => tick.value)).toEqual([2, 3, 4, 5]);
  expect(matrix.xTicks.map(tick => tick.value)).toEqual([2, 3, 4, 5]);
  for (const tick of [...matrix.yTicks, ...matrix.xTicks]) expect(tick.error).toBeLessThanOrEqual(1.5);
  expect(matrix.originXError).toBeLessThanOrEqual(1.5);
  expect(matrix.originYError).toBeLessThanOrEqual(1.5);
  await page.screenshot({ path: `artifacts/ax/matrix-${test.info().project.name}.png` });
  await page.getByRole("tab", { name: "결과·로드맵", exact: false }).click();
  const list = page.locator(".ax-step4-overview .ax-priority-list").first();
  await expect(list).toContainText("부분 자동화 (Level 2)");
  await expect(page.locator(".ax-selected-report .ax-report-intro")).toContainText("부분 자동화 (Level 2)");
  await page.screenshot({ path: `artifacts/ax/roadmap-${test.info().project.name}.png`, fullPage: true });
  const packageSection = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(packageSection.getByText("조건부 진행", { exact: true })).toHaveCount(0);
  await expect(packageSection.getByText("먼저 확인할 사항", { exact: false })).toHaveCount(0);
  await expect(packageSection.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
  await expect(packageSection.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeEnabled();
  const generators = packageSection.locator(".ax-plan-generate");
  await expect(generators).toHaveCount(2);
  const generatorStyle = await generators.evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button), card = document.createElement("span"); card.style.background = "var(--card)"; document.body.append(card);
    const result = { white: style.backgroundColor === getComputedStyle(card).backgroundColor, icon: !!button.querySelector("svg.lucide-file-code-2, svg.lucide-file-code-corner, svg[class*='lucide-file-code']"), height: Math.round(button.getBoundingClientRect().height) };
    card.remove(); return result;
  }));
  expect(generatorStyle.every(item => item.white && item.icon)).toBe(true);
  expect(new Set(generatorStyle.map(item => item.height)).size).toBe(1);
  await expect(generators.first()).not.toHaveClass(/bg-primary/);
  await expect(packageSection.locator(".ax-plan-tool-hint")).toHaveCount(0);
  await expect(packageSection.getByRole("button", { name: "설치·시작 가이드", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  const head = packageSection.locator(".ax-plan-head");
  await expect(head.getByRole("heading", { name: "자동화 구현 계획", exact: true })).toBeVisible();
  await expect(head).toContainText("월간 취합");
  await expect(head).toContainText("확인 후 진행");
  const summary = packageSection.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
  const precheck = packageSection.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(summary).toContainText("담당자 승인");
  await expect(summary).toContainText("사용자 수행");
  // 추가 확인 조건도 같은 목록 영역에 표시된다.
  await expect(precheck).toContainText("API와 권한 실제 확인");
  await expect(precheck).toContainText(planFixture.prerequisites[0]);
  // 데이터·시스템 상세 표는 기본 화면에서 제거됐다 (원본 데이터·04 지시문에는 유지).
  await expect(summary).not.toContainText(planFixture.inScope[0]);
  await expect(precheck).not.toContainText(planFixture.asIs[0]);
  await expect(summary).not.toContainText(planFixture.fallback[0]);
  await expect(summary).toContainText("대조 통과");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await summary.screenshot({ path: `artifacts/ax/plan-view-${test.info().project.name}.png` });
  const prompt = packageSection.locator(".ax-prompt");
  const codexPrompt = await prompt.textContent();
  for (const name of ["구현 후 확인 · GitHub 반영", "배포 방법", "상세 구현 계획 보기"]) await expect(packageSection.getByRole("button", { name, exact: true })).toHaveCount(0);
  for (const name of ["운영·복구 계획", "실행 판단 · 조건부 진행"]) await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
  await expect(packageSection.getByRole("button", { name: "설치·시작 가이드", exact: true })).toHaveAttribute("aria-expanded", "false");
  const guide = packageSection.getByRole("button", { name: "설치·시작 가이드", exact: true });
  await expect(guide.locator("svg.lucide-terminal")).toHaveCount(1);
  await expect(guide.locator('[data-slot="accordion-indicator"]')).toHaveCount(1);
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "true");
  const guidePanel = packageSection.locator(".ax-guide-panel");
  await expectGuideTutorial(page, guidePanel, "Codex");
  await page.screenshot({ path: `artifacts/ax/setup-toolbar-${test.info().project.name}.png` });
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "false");
  await expect(guidePanel.locator(".ax-guide-code").first()).toBeHidden();
  await expectCopyUX(page, packageSection, "Codex");

  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true })).toBeVisible();
  await expectCopyUX(page, packageSection, "Claude Code");
  expect(await prompt.textContent()).toBe(codexPrompt);
  await guide.click();
  await expectGuideTutorial(page, guidePanel, "Claude Code");
  await guide.click();
  expect(calls.map(c => c.kind)).toEqual(["ax-diagnosis", "ax-plan", "ax-plan"]);
  expect(calls[1]).toMatchObject({ target: "codex", diagnosis: { factors: expect.arrayContaining([expect.objectContaining({ key: "repetition", finalValue: 1 })]) } });
  expect(calls[2]).toHaveProperty("target", "claude");
  await expect.poll(() => record(page)).toMatchObject({ step: 4, tasks: [{ status: "adjusted", diagnosis: {
    planCodex: planFixture, planClaude: planFixture,
    factors: expect.arrayContaining([expect.objectContaining({ key: "repetition", finalValue: 1 })]),
  } }] });
  const saved = await record(page); expect(saved?.step).toBe(4);
  await page.reload(); await ax(page);
  await expect(page.getByRole("tab", { name: "결과·로드맵" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download"); await dataAction(page, "데이터 내보내기");
  const path = await (await downloaded).path(); const content = await readFile(path!, "utf8");
  expect(JSON.parse(content).data).toEqual(saved);
  await page.evaluate(() => localStorage.setItem("ax-unrelated-fixture", "keep"));
  await dataAction(page, "데이터 초기화"); await page.getByRole("alertdialog").getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page.getByLabel("업무 설명", { exact: true })).toBeVisible();
  await expect(page.getByLabel("등록 업무 목록")).toHaveCount(0);
  await expect.poll(() => record(page)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("ax-unrelated-fixture"))).toBe("keep");
  await importData(page, content);
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  await expect.poll(() => record(page)).toEqual(saved);
  await page.reload(); await ax(page); await page.getByRole("tab", { name: "Claude Code", exact: true }).click(); await expect(page.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true })).toBeVisible();
});
test("AX matrix markers retain rendered coordinates on a 390px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const diagnosed = taskFixture("mobile-matrix", diagnosisFixture);
  await seed(page, { ...emptyAxState(), tasks: [diagnosed], selectedTaskId: diagnosed.id, step: 3 });
  await ax(page);
  const alignment = await page.evaluate(() => {
    const chart = document.querySelector(".ax-matrix")!.getBoundingClientRect();
    const center = (box: DOMRect) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
    const bubbles = [...document.querySelectorAll<HTMLElement>(".ax-bubble")].map(bubble => {
      const button = center(bubble.getBoundingClientRect());
      const dot = center(bubble.querySelector(".ax-bubble-dot")!.getBoundingClientRect());
      return {
        xError: Math.abs(button.x - (chart.left + parseFloat(bubble.style.left) / 100 * chart.width)),
        yError: Math.abs(button.y - (chart.bottom - parseFloat(bubble.style.bottom) / 100 * chart.height)),
        dotError: Math.max(Math.abs(dot.x - button.x), Math.abs(dot.y - button.y)),
      };
    });
    const yTicks = [...document.querySelectorAll(".ax-y-tick")].filter(tick => tick.textContent?.trim()).map(tick => {
      const point = center(tick.getBoundingClientRect()), value = Number(tick.textContent);
      return { value, ...point, error: Math.abs(point.y - (chart.bottom - (value - 1) / 4 * chart.height)) };
    });
    const xTicks = [...document.querySelectorAll(".ax-x-tick:not(.is-origin)")].map(tick => {
      const point = center(tick.getBoundingClientRect()), value = Number(tick.textContent);
      return { value, ...point, error: Math.abs(point.x - (chart.left + (value - 1) / 4 * chart.width)) };
    });
    const originCenter = center(document.querySelector(".ax-x-tick.is-origin")!.getBoundingClientRect());
    return {
      bubbles, yTicks, xTicks,
      originXError: Math.abs(originCenter.x - yTicks.find(tick => tick.value === 2)!.x),
      originYError: Math.abs(originCenter.y - xTicks.find(tick => tick.value === 2)!.y),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(alignment.bubbles.length).toBeGreaterThan(0);
  for (const bubble of alignment.bubbles) {
    expect(bubble.xError).toBeLessThanOrEqual(1.5); expect(bubble.yError).toBeLessThanOrEqual(1.5);
    expect(bubble.dotError).toBeLessThanOrEqual(1);
  }
  for (const tick of [...alignment.yTicks, ...alignment.xTicks]) expect(tick.error).toBeLessThanOrEqual(1.5);
  expect(alignment.originXError).toBeLessThanOrEqual(1.5);
  expect(alignment.originYError).toBeLessThanOrEqual(1.5);
  expect(alignment.overflow).toBe(false);
});
// Permission denial alone can still copy through execCommand. Control both API outcomes
// so this regression deterministically exercises total failure and recovery.
for (const fallbackFailure of ["false", "throw"] as const) {
  test(`AX copy reports clipboard denial plus fallback ${fallbackFailure}, then recovers`, async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "Clipboard permission regression is scoped to Chromium.");
    await context.clearPermissions();
    await page.goto("/");
    const task = taskFixture("copy-failure", { ...diagnosisFixture, planCodex: planFixture });
    await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
    await ax(page);
    const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    const button = section.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true });
    await page.evaluate(failure => {
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => {
        throw new DOMException("Clipboard permission denied", "NotAllowedError");
      } });
      document.execCommand = () => {
        if (failure === "throw") throw new Error("Fallback copy unavailable");
        return false;
      };
    }, fallbackFailure);
    await button.click();
    await expect(section.getByRole("status")).toHaveText("복사하지 못했습니다. 직접 선택해 복사해주세요.");
    await expect(button).not.toHaveAttribute("data-copied", "true");
    await expect(button.locator("svg.lucide-check")).toHaveCount(0);
    await expect(button.locator("svg.lucide-copy")).toHaveCount(1);
    await expect(section.locator('.sr-only[aria-live="polite"]')).toBeEmpty();
    await expect(button).toHaveText("복사");
    await expect(page.locator('textarea[readonly]')).toHaveCount(0);

    await page.evaluate(() => { Reflect.deleteProperty(navigator.clipboard, "writeText"); });
    await expectCopyUX(page, section, "Codex");
    await expect(section.locator(".ax-copy-error")).toHaveCount(0);

    // A successful fallback also uses the normal success feedback.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => {
        throw new DOMException("Clipboard permission denied", "NotAllowedError");
      } });
      document.execCommand = () => true;
    });
    await button.click();
    await expect(button).toHaveAttribute("data-copied", "true");
    await expect(button.locator("svg.lucide-check")).toHaveCount(1);
    await expect(section.locator(".ax-copy-error")).toHaveCount(0);
    await expect(page.locator('textarea[readonly]')).toHaveCount(0);
  });
}
test("AX mobile steps scroll, bottom navigation and task delete", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/"); await ax(page);
  const steps = page.getByRole("tablist", { name: "진단 단계" });
  await expect(steps.getByRole("tab")).toHaveCount(4);
  // Check every label's actual text bounds: document overflow alone misses clipped tablists.
  expect(await steps.evaluate(list => {
    const bounds = list.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth &&
      list.scrollWidth > list.clientWidth && getComputedStyle(list).overflowX === "auto" && getComputedStyle(list).overflowY === "hidden" &&
      Array.from(list.querySelectorAll("[role=tab]")).every(tab => {
        const box = tab.getBoundingClientRect();
        const label = tab.querySelector("span")!;
        const range = document.createRange(); range.selectNodeContents(label);
        return Array.from(range.getClientRects()).every(text => text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom);
      });
  })).toBe(true);
  await expect(steps.getByRole("tab").first()).toBeInViewport({ ratio: 1 });
  await steps.getByRole("tab").last().scrollIntoViewIfNeeded();
  // Firefox reports sub-pixel ratios (0.9995+) for a fully scrolled-in tab; 0.99 still proves full reachability.
  await expect(steps.getByRole("tab").last()).toBeInViewport({ ratio: 0.99 });
  expect(await steps.getByRole("tab").last().evaluate(tab => {
    const box = tab.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await steps.getByRole("tab").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `artifacts/ax/registration-mobile-${test.info().project.name}.png` });
  await register(page);
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "다음 단계", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 등록", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("등록 업무 목록").locator("li", { hasText: "월간 취합" }).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "업무 목록", exact: true })).toHaveCount(0);
  await expect(page.getByText("등록된 업무가 없습니다", { exact: false })).toHaveCount(0);
  await expect.poll(async () => (await record(page))?.tasks.length).toBe(0);
  await page.reload(); await ax(page);
  await expect(page.getByLabel("업무 설명", { exact: true })).toBeVisible();
  await expect(page.getByLabel("등록 업무 목록")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await navigateWorkspace(page, "Guide"); await page.getByRole("tab", { name: "업무 자동화 진단", exact: true }).click();
  await expect(page.getByRole("tabpanel").locator(".usage-guide-step")).toHaveCount(4);
});
test("AX validates imports before replacement, cancel preserves existing data and reset cancel works", async ({ page }) => {
  await page.goto("/"); await ax(page); await register(page, "기존 업무");
  const imported = exportAxState({ ...emptyAxState(), tasks: [taskFixture("imported")] , selectedTaskId: "imported" });
  await importData(page, "{broken"); await expect(page.getByText("올바른 JSON 파일이 아닙니다.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await importData(page, imported); await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText("기존 업무");
  await importData(page, imported); await page.getByRole("alertdialog").getByRole("button", { name: "덮어쓰기", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText("업무 imported");
  await dataAction(page, "데이터 초기화"); await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText("업무 imported");
  await expect.poll(() => record(page)).toEqual(JSON.parse(imported).data);
});
test("AX preserves unsupported IndexedDB records until an explicit reset", async ({ page }) => {
  const original = { schemaVersion: 99, tasks: "broken" };
  await page.goto("/"); await seed(page, original); await ax(page);
  await expect(page.getByRole("status").filter({ hasText: "원본" })).toBeVisible();
  await register(page, "임시 화면 업무");
  await page.getByRole("button", { name: "다음 단계" }).click();
  await navigateWorkspace(page, "분석");
  expect(await record(page)).toEqual(original);
  await ax(page);
  await expect(page.getByLabel("등록 업무 목록")).toHaveCount(0);
  await dataAction(page, "데이터 초기화");
  await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click();
  expect(await record(page)).toEqual(original);
  await dataAction(page, "데이터 초기화");
  await page.getByRole("alertdialog").getByRole("button", { name: "초기화", exact: true }).click();
  await expect.poll(() => record(page)).toBeUndefined();
});
test("AX styled file selection shows filenames and removes draft/session attachments", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page);
  const file = { name: "selected.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기\n취합,매월") };
  const input = page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByLabel("파일 추가", { exact: true });
  await expect(input).toBeHidden();
  const selectFile = async () => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByRole("button", { name: "파일 추가", exact: true }).click();
    await (await chooser).setFiles(file);
    await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
    await expect(page.locator(".ax-file-row").filter({ hasText: "selected.csv" })).toBeVisible();
    await expect(page.locator(".ax-file-row").filter({ hasText: "selected.csv" })).not.toContainText("준비됨");
  };
  await selectFile();
  await page.getByRole("button", { name: "첨부 취소", exact: true }).click();
  await expect(page.getByText("selected.csv", { exact: false })).toHaveCount(0);
  await selectFile(); // The same file can be selected again after removal.
  await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await expect(page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByLabel("파일 추가", { exact: true })).toHaveCount(0);
  await expect(page.locator(".ax-attachment input[type=file]")).toHaveCount(0);
  await expect(page.locator(".ax-attachment")).toContainText("selected.csv");
  await expect(page.locator(".ax-attachment")).not.toContainText("세션 요약 준비됨");
  await page.getByRole("button", { name: "첨부 해제", exact: true }).click();
  await expect(page.locator(".ax-attachment")).toHaveCount(0);
  await page.getByRole("button", { name: "등록 정보 수정", exact: true }).click();
  await expect(input).toBeHidden();
  await selectFile();
  await page.getByRole("button", { name: "수정 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await expect(page.locator(".ax-attachment")).toContainText("selected.csv");
  await expect(page.locator(".ax-attachment")).not.toContainText("세션 요약 준비됨");
  await page.getByRole("button", { name: "첨부 해제", exact: true }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0]).not.toHaveProperty("attachmentSummary");
  await expect.poll(() => record(page)).toMatchObject({ step: 2, tasks: [{ status: "diagnosed", diagnosis: { informationSufficiency: "sufficient" } }] });
  expect((await record(page))?.tasks[0].attachmentMeta).toBeUndefined();
});
test("AX register form: 추가 정보 trigger keeps a transparent background in every state", async ({ page }) => {
  await page.goto("/"); await ax(page);
  const trigger = page.locator(".ax-details-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText("추가 정보");
  const background = () => trigger.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await background()).toBe("rgba(0, 0, 0, 0)");
  await trigger.hover();
  expect(await background()).toBe("rgba(0, 0, 0, 0)");
  // 펼친 상태에서도 배경 음영이 생기지 않고, 입력한 값은 접었다 펴도 유지된다
  await page.getByLabel("업무명", { exact: true }).fill("음영 확인 업무");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await background()).toBe("rgba(0, 0, 0, 0)");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(await background()).toBe("rgba(0, 0, 0, 0)");
  await expect(page.getByLabel("업무명", { exact: true })).toHaveValue("음영 확인 업무");
  // 키보드 Tab으로 도달하면 배경은 그대로 두고 포커스 링으로 식별할 수 있다
  await page.getByLabel("업무명", { exact: true }).click();
  let focused = false;
  for (let i = 0; i < 20 && !focused; i++) {
    await page.keyboard.press("Tab");
    focused = await trigger.evaluate(el => document.activeElement === el);
  }
  expect(focused).toBe(true);
  expect(await background()).toBe("rgba(0, 0, 0, 0)");
  const focusShadow = await trigger.evaluate(el => getComputedStyle(el).boxShadow);
  expect(focusShadow).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
});
test("AX attachment summaries stay out of storage/export and reload requires reattachment", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page);
  await page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByLabel("파일 추가", { exact: true }).setInputFiles({ name: "monthly.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기,처리\n표취합,매월,승인\n보고,매월,담당자 검토") });
  await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
  await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("첨부 파일 요약 기반 진단", { exact: false })).toBeVisible();
  expect(calls[0]).toHaveProperty("attachmentSummary"); expect(calls[0]).not.toHaveProperty("bytes");
  await expect.poll(() => record(page)).toMatchObject({ step: 2, tasks: [{
    attachmentMeta: { name: "monthly.csv", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    diagnosis: { informationSufficiency: "sufficient", sourceNote: expect.stringContaining("첨부 파일 요약 기반 진단") },
  }] });
  const stored = await record(page); expect(stored?.tasks[0].attachmentMeta?.fingerprint).toHaveLength(64);
  expect(JSON.stringify(stored)).not.toContain("attachmentSummary"); expect(JSON.stringify(stored)).not.toContain("bytes");
  const download = page.waitForEvent("download"); await dataAction(page, "데이터 내보내기");
  const exported = await readFile((await (await download).path())!, "utf8");
  expect(exported).not.toContain("attachmentSummary"); expect(exported).not.toContain("bytes");
  expect(JSON.parse(exported).data.tasks[0].attachmentMeta).toEqual(stored?.tasks[0].attachmentMeta);
  await page.reload(); await ax(page);
  await expect(page.locator(".ax-attachment")).toContainText("첨부 파일이 사용됨 — 재분석 시 재첨부 필요");
  await page.getByRole("button", { name: "업무 다시 진단" }).click(); expect(calls).toHaveLength(1);
  await page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByLabel("파일 추가", { exact: true }).setInputFiles({ name: "monthly.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기\n표취합,매월") });
  await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "업무 진단 실행" }).click(); await expect(page.getByText("정보 충분", { exact: true })).toBeVisible(); expect(calls).toHaveLength(2);
});
test("AX follows up on missing information and recalculates provisional decisions", async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/ai", async route => { calls.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: calls.length === 1 ? { ...outputFixture(), informationSufficiency: "needs-check", followUpQuestions: ["최종 승인자는 누구인가요?"] } : outputFixture() } }) }); });
  await page.goto("/"); await ax(page); await register(page); await page.getByRole("button", { name: "다음 단계" }).click(); await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByRole("button", { name: "추가 질문 답변", exact: true })).toBeVisible();
  await expect(page.locator(".ax-diag-card")).not.toContainText("잠정");
  // 핵심 정보 부족 상태에서는 상단 배지가 정보를 전담하고 요약 제목 옆 배지는 중복 표시하지 않는다
  await expect(page.locator(".ax-diag-badges")).toContainText("정보 확인 필요");
  await expect(page.locator(".ax-diag-summary-head")).not.toContainText("핵심 정보 확인 필요");
  // 다음 행동을 누르면 추가 질문 영역으로 스크롤된다
  await page.getByRole("button", { name: "추가 질문 답변", exact: true }).click();
  await expect(page.locator("#ax-answer-section")).toBeVisible();
  await expect.poll(async () => (await page.locator("#ax-answer-section").boundingBox())?.y ?? 9999).toBeLessThan(200);
  await page.getByLabel("최종 승인자는 누구인가요?", { exact: true }).fill("업무 담당 팀장");
  const rediagnose = page.getByRole("button", { name: "답변 반영 후 재진단", exact: true });
  await expect(rediagnose).toHaveAttribute("data-slot", "button"); await expect(rediagnose).toHaveClass(/bg-primary/);
  const [buttonBox, questionsBox] = await Promise.all([rediagnose.boundingBox(), page.locator(".ax-questions").boundingBox()]);
  expect(buttonBox!.width).toBeLessThan(questionsBox!.width / 2);
  expect(Math.abs(buttonBox!.x + buttonBox!.width - (questionsBox!.x + questionsBox!.width - 21))).toBeLessThanOrEqual(2);
  await rediagnose.click(); await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  expect(calls[1].description).toContain("업무 담당 팀장");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "자동화 매트릭스" }).click();
  await expect(page.getByLabel("매트릭스 업무 목록")).toBeVisible(); await expect(page.locator(".ax-matrix-surface")).toBeVisible();
  await expect(page.getByLabel("자동화 매트릭스 산점도")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
test("AX summary next action links to the checks area when needs-check has checks but no questions", async ({ page }) => {
  await page.route("**/api/ai", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: { ...outputFixture(), informationSufficiency: "needs-check" } } }) }));
  await page.goto("/"); await ax(page); await register(page); await page.getByRole("button", { name: "다음 단계" }).click(); await page.locator(".ax-diag-card").getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.locator(".ax-diag-badges")).toContainText("정보 확인 필요");
  await expect(page.locator(".ax-diag-summary-head")).not.toContainText("핵심 정보 확인 필요");
  await expect(page.locator(".ax-diag-card")).toContainText("구현 전 확인 1건");
  await expect(page.locator(".ax-diag-card")).not.toContainText("잠정");
  await page.getByRole("button", { name: "확인할 사항 검토", exact: true }).click();
  await expect(page.locator(".ax-diag-checks")).toBeVisible();
  await expect.poll(async () => (await page.locator(".ax-diag-checks").boundingBox())?.y ?? 9999).toBeLessThan(200);
});
test("AX summary next action links to the block reasons for blocked gates", async ({ page }) => {
  await page.route("**/api/ai", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: { ...outputFixture(), decisionGate: { verdict: "no-go", reasons: ["필수 시스템 접근 불가"] } } } }) }));
  await page.goto("/"); await ax(page); await register(page); await page.getByRole("button", { name: "다음 단계" }).click(); await page.locator(".ax-diag-card").getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.locator(".ax-diag-card")).toContainText("차단 사유를 해결한 뒤 재진단이 필요합니다.");
  await page.getByRole("button", { name: "차단 사유 확인", exact: true }).click();
  await expect(page.locator(".ax-diag-checks")).toContainText("필수 시스템 접근 불가");
  await expect.poll(async () => (await page.locator(".ax-diag-checks").boundingBox())?.y ?? 9999).toBeLessThan(200);
});
test("AX level badge uses the unified label and shows the level description tooltip", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.locator(".ax-diag-card").getByRole("button", { name: "업무 진단 실행" }).click();
  // outputFixture: 자동화 1 · AI 보조 1 · 사람 유지 1 단계, Factor 기준 Level 3(고도 자동화)
  await expect(page.locator(".ax-diag-card")).toContainText("전체 3개 업무 단계 중 자동화 적합 1개 · AI 보조 적합 1개 · 담당자 수행 1개");
  const badge = page.locator(".ax-diag-card .ax-level-badge");
  await expect(badge).toHaveText("고도 자동화 (Level 3)");
  const description = "넓게 자동화하되 승인·안전·법률·권한 관련 단계는 담당자가 유지합니다.";
  // 호버 직후 레이아웃이 움직이면 마우스가 배지를 벗어날 수 있어, 열린 상태가 될 때까지 호버를 되풀이한다.
  await expect(async () => {
    await badge.hover();
    await expect(page.getByText(description, { exact: true })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await page.mouse.move(0, 0);
  await expect(page.getByText(description, { exact: true })).toBeHidden();
  // 키보드 이동으로 배지에 포커스가 가면 같은 설명이 열린다 (프로그래매틱 focus()는 focus-visible로
  // 인정되지 않아 열리지 않으므로 실제 키 입력으로 이동한다).
  await page.getByRole("button", { name: "업무 다시 진단" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toBeFocused();
  await expect(page.getByText(description, { exact: true })).toBeVisible();
});
test.describe("AX level badge touch", () => {
  test.use({ hasTouch: true, isMobile: true });
  // isMobile 터치 에뮬레이션은 Chromium 전용이라 Firefox에서는 건너뛴다 (데스크톱 호버·포커스 경로는 위 툴팁 테스트가 Firefox 포함 전 프로젝트에서 검증).
  test.skip(({ browserName }) => browserName !== "chromium", "touch emulation requires Chromium");
  test("tap toggles the level description on touch devices", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const calls: Record<string, unknown>[] = []; await mock(page, calls);
    await page.goto("/"); await ax(page); await register(page);
    await page.getByRole("button", { name: "다음 단계" }).click();
    await page.locator(".ax-diag-card").getByRole("button", { name: "업무 진단 실행" }).click();
    const badge = page.locator(".ax-diag-card .ax-level-badge");
    await expect(badge).toHaveText("고도 자동화 (Level 3)");
    const description = page.getByText("넓게 자동화하되 승인·안전·법률·권한 관련 단계는 담당자가 유지합니다.", { exact: true });
    await badge.tap();
    await expect(description).toBeVisible();
    const box = (await description.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await badge.tap();
    await expect(description).toBeHidden();
  });
});
test("AX works and exports when IndexedDB is unavailable and rejects failed AI output", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("storage disabled"); } }); });
  await page.route("**/api/ai", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: { informationSufficiency: "sufficient" } } }) }));
  await page.goto("/"); await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("status").filter({ hasText: "자동 저장에 실패했습니다. 필요하면 AI•AX 데이터를 내보내 백업해주세요." })).toBeVisible(); await register(page);
  await expect(page.getByLabel("등록 업무 목록")).toContainText("월간 취합");
  await page.getByRole("button", { name: "다음 단계" }).click(); await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("진단 실패", { exact: false })).toBeVisible(); await expect(page.getByText("진단 결과", { exact: true })).toHaveCount(0);
  const download = page.waitForEvent("download"); await dataAction(page, "데이터 내보내기"); const exported = JSON.parse(await readFile((await (await download).path())!, "utf8")); expect(exported.data.tasks).toHaveLength(1);
});
test("AX flushes pending changes on navigation and preserves the existing workspace", async ({ page }) => {
  await page.goto("/"); await ax(page); await register(page, "화면 이동 전에 등록");
  await navigateWorkspace(page, "Guide");
  await ax(page); await expect(page.getByLabel("등록 업무 목록")).toContainText("화면 이동 전에 등록");
  await expect.poll(async () => (await record(page))?.tasks[0].name).toBe("화면 이동 전에 등록");
  await navigateWorkspace(page, "분석"); await expect(page.getByRole("heading", { name: "문서 분석", exact: true })).toBeVisible();
  await page.reload(); await ax(page); await expect(page.getByLabel("등록 업무 목록")).toContainText("화면 이동 전에 등록");
});
test("AX attachment cleanup leaves another view's AI request running", async ({ page }) => {
  const failed: string[] = [];
  const outcome = new Promise<string>(resolve => {
    page.on("requestfailed", request => { if (new URL(request.url()).pathname === "/api/ai") { failed.push(request.failure()?.errorText ?? "failed"); resolve("failed"); } });
    page.on("requestfinished", request => { if (new URL(request.url()).pathname === "/api/ai") resolve("finished"); });
  });
  let release: (() => void) | undefined;
  await page.route("**/api/ai", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }).catch(() => undefined);
  });
  await page.goto("/");
  await page.getByLabel("작업 파일 선택", { exact: true }).setInputFiles({ name: "existing.csv", mimeType: "text/csv", buffer: Buffer.from("항목,값\n월 자료,2\n취합,3") });
  await page.getByRole("checkbox", { name: "existing.csv 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await expect.poll(() => typeof release).toBe("function");
  await ax(page);
  await page.getByLabel("업무 설명", { exact: true }).fill("매월 취합하는 업무입니다.");
  // Keep the main-thread AX fingerprint operation pending during navigation;
  // the original document worker has its own crypto implementation.
  await page.evaluate(() => { Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: () => new Promise(() => {}) }); });
  await page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByLabel("파일 추가", { exact: true }).setInputFiles({ name: "ax.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기\n취합,월") });
  await expect(page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByRole("button", { name: "파일 추가", exact: true })).toBeDisabled();
  await navigateWorkspace(page, "Guide");
  release?.();
  expect(await outcome).toBe("finished");
  expect(failed).toHaveLength(0);
});
test("AX Execution Gate blocks no-go plans and displays ready tasks before higher-scoring blocked tasks", async ({ page }) => {
  await page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON();
    const output = outputFixture();
    const diagnosis = req.name === "차단 업무" ? {
      ...output,
      decisionGate: { verdict: "no-go", reasons: ["필수 시스템 접근 불가", "두 번째 보류 사유"] },
      factors: output.factors.map(f => ({ ...f, aiValue: f.key === "humanJudgment" || f.key === "operationalRisk" ? 2 : 5 })),
    } : {
      ...output,
      decisionGate: { verdict: "go", reasons: [] },
      technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인" }],
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis } }) });
  });
  await page.goto("/"); await ax(page);
  await register(page, "차단 업무"); await register(page, "가능 업무");
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  const tasks = page.getByLabel("등록 업무 목록").filter({ visible: true });
  await tasks.getByRole("button", { name: "차단 업무", exact: false }).first().click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.locator('.ax-diag-card .ax-gate-badge[data-gate="blocked"]')).toHaveText("진행 보류");
  const blockedChecks = page.locator(".ax-diag-card .ax-diag-checks");
  await expect(blockedChecks).toContainText("보류 사유");
  await expect(blockedChecks).toContainText("필수 시스템 접근 불가");
  await tasks.getByRole("button", { name: "가능 업무", exact: false }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.locator('.ax-diag-card .ax-gate-badge[data-gate="ready"]')).toHaveText("진행 가능");
  await expect(page.locator('.ax-diag-card .ax-check-badge[data-kind="block"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  const list = page.getByRole("list", { name: "업무 목록", exact: true });
  await expect(list.locator("li .ax-task-name")).toHaveText(["가능 업무", "차단 업무"]);
  await expect(page.getByRole("button", { name: "전체 업무 보기", exact: true })).toHaveCount(0);
  const blocked = list.getByRole("listitem").filter({ hasText: "차단 업무" });
  const ready = list.getByRole("listitem").filter({ hasText: "가능 업무" });
  await expect(blocked.locator(".ax-gate-badge")).toHaveText("진행 보류");
  await expect(ready.locator(".ax-rank")).toHaveText("#2");
  await expect(blocked.locator(".ax-rank")).toHaveText("#1");
  await expect(blocked.getByText("진행 보류", { exact: true })).toBeVisible();
  await blocked.getByRole("button").click();
  await expect(page.getByRole("article", { name: "차단 업무 결과·로드맵", exact: true })).toContainText("진행 보류");
  await expect(page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeDisabled();
  const plans = page.locator("section.ax-surface").filter({ has: page.getByRole("heading", { name: "자동화 구현 계획", exact: true }) });
  // ① 구현 전 확인 섹션에서 진행 보류 배지와 차단 사유가 바로 보인다.
  const precheck = plans.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(precheck).toContainText("진행 보류");
  await expect(precheck.getByText("필수 시스템 접근 불가", { exact: true })).toBeVisible();
  await expect(plans.locator(".ax-prompt")).toHaveCount(0);
  await expect(plans.locator(".ax-plan-tool-hint")).toHaveCount(0);
  await expect(plans.getByRole("button", { name: /용 올인원 지시문 복사$/ })).toHaveCount(0);
  await expect(plans.getByRole("button", { name: "설치·시작 가이드", exact: false })).toHaveCount(0);
  await ready.getByRole("button").click();
  await expect(page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await tasks.getByRole("button", { name: "차단 업무", exact: false }).click();
  await expect(page.locator('.ax-gate-badge[data-gate="blocked"]')).toBeVisible();
  await expect(page.locator('.ax-gate-badge[data-gate="blocked"]')).toHaveText("진행 보류");
});
test("AX repeated follow-up diagnoses preserve the original stored description", async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/ai", async route => {
    calls.push(route.request().postDataJSON());
    const question = ["최종 승인자는 누구인가요?", "사용 시스템은 무엇인가요?"][calls.length - 1];
    const diagnosis = question ? { ...outputFixture(), informationSufficiency: "needs-check", followUpQuestions: [question] } : outputFixture();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis } }) });
  });
  const description = "매월 입력 표를 취합하고 담당자가 최종 승인합니다.";
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await page.getByLabel("최종 승인자는 누구인가요?", { exact: true }).fill("업무 담당 팀장");
  await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
  await expect(page.getByLabel("사용 시스템은 무엇인가요?", { exact: true })).toBeVisible();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ description, status: "needs-info", diagnosis: { followUpQuestions: ["사용 시스템은 무엇인가요?"] } }] });
  expect(calls).toHaveLength(2);
  expect(calls[1].description).toContain("업무 담당 팀장");
  await page.getByLabel("사용 시스템은 무엇인가요?", { exact: true }).fill("사내 ERP");
  await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ description, status: "diagnosed", diagnosis: { informationSufficiency: "sufficient", followUpQuestions: [] } }] });
  expect((await record(page))?.tasks[0].description).not.toContain("추가 확인");
  expect(calls).toHaveLength(3);
  expect(calls[2].description).toContain("사내 ERP");
});
test("AX factor corrections and re-diagnosis invalidate existing implementation plans", async ({ page }) => {
  await mock(page);
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  const codex = page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true });
  const claude = page.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true });
  await expect(codex).toBeVisible();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  await expect(claude).toBeVisible();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ diagnosis: { planCodex: planFixture, planClaude: planFixture } }] });
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  await page.getByRole("button", { name: "반복성 4점", exact: true }).click();
  await expect(page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true })).toHaveCount(0);
  await expect(page.locator(".ax-factor-corrected")).toHaveCount(0);
  await expect.poll(async () => {
    const task = (await record(page))?.tasks[0];
    return { status: task?.status, repetition: task?.diagnosis?.factors.find(f => f.key === "repetition")?.finalValue, planCodex: task?.diagnosis?.planCodex, planClaude: task?.diagnosis?.planClaude };
  }).toEqual({ status: "diagnosed", repetition: undefined, planCodex: planFixture, planClaude: planFixture });
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await expect.poll(async () => {
    const diagnosis = (await record(page))?.tasks[0].diagnosis;
    return { repetition: diagnosis?.factors.find(f => f.key === "repetition")?.finalValue, planCodex: diagnosis?.planCodex, planClaude: diagnosis?.planClaude };
  }).toEqual({ repetition: 1, planCodex: undefined, planClaude: undefined });
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(codex).toHaveCount(0); await expect(claude).toHaveCount(0);
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(codex).toBeVisible();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ diagnosis: { planCodex: planFixture } }] });
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "업무 다시 진단", exact: true }).click();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ status: "diagnosed", diagnosis: { informationSufficiency: "sufficient" } }] });
  expect((await record(page))?.tasks[0].diagnosis?.planCodex).toBeUndefined();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(codex).toHaveCount(0); await expect(claude).toHaveCount(0);
});
test("AX registration edits preserve hidden legacy fields and invalidate the diagnosis", async ({ page }) => {
  const task = { ...taskFixture("legacy", diagnosisFixture), people: 3, painPoints: "수작업 오류", goal: "월말 마감 단축" };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await ax(page);
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "등록 정보 수정", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 등록", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "등록 정보 수정", exact: true })).toBeVisible();
  await expect(page.locator("form.ax-register textarea")).toHaveValue(task.description);
  await expect(page.getByRole("button", { name: "수정 저장", exact: true })).toHaveCount(0);
  await page.getByLabel("업무명", { exact: true }).fill("수정된 업무");
  await page.getByRole("button", { name: "수정 등록", exact: true }).click();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{
    id: "legacy", name: "수정된 업무", description: task.description,
    people: 3, painPoints: "수작업 오류", goal: "월말 마감 단축", status: "registered",
  }] });
  expect((await record(page))?.tasks[0].diagnosis).toBeUndefined();
});
test("AX Step 1 edit icon reuses the registration edit flow, keeps one selected row and deletes quietly", async ({ page }) => {
  const first = { ...taskFixture("first"), name: "월간 운임 정산 취합" }, second = { ...taskFixture("second"), name: "주간 고객사 뉴스 동향 보고", description: "매주 고객사 뉴스를 모아 동향 보고서를 작성합니다." };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [first, second], selectedTaskId: first.id, step: 1 });
  await ax(page);
  const list = page.getByLabel("등록 업무 목록");
  const row = (name: string) => list.locator("li", { hasText: name });
  await expect(row(first.name)).toHaveClass(/is-selected/);
  const surface = await row(first.name).evaluate(element => ({ row: getComputedStyle(element).backgroundColor, actions: [...element.querySelectorAll(".ax-task-action")].map(button => getComputedStyle(button).backgroundColor) }));
  expect(surface.row).not.toBe("rgba(0, 0, 0, 0)");
  expect(surface.actions).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  await row(second.name).getByRole("button", { name: "업무 삭제", exact: true }).hover();
  const hovered = await row(second.name).evaluate(element => {
    const bounds = element.getBoundingClientRect(), actions = element.querySelector(".ax-task-actions")!.getBoundingClientRect(), style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderRightColor, coversIcons: bounds.right >= actions.right,
      childBackgrounds: [...element.querySelectorAll("button")].map(button => getComputedStyle(button).backgroundColor) };
  });
  expect(hovered.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(hovered.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(hovered.coversIcons).toBe(true);
  expect(hovered.childBackgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  await row(second.name).getByRole("button", { name: second.name }).click();
  await expect(row(second.name)).toHaveClass(/is-selected/); await expect(row(first.name)).not.toHaveClass(/is-selected/);
  await expect(page.getByRole("heading", { name: "업무 등록", exact: true })).toBeVisible();
  await row(first.name).getByRole("button", { name: "업무 수정", exact: true }).click();
  await expect(row(first.name)).toHaveClass(/is-selected/); await expect(row(second.name)).not.toHaveClass(/is-selected/);
  await expect(page.getByRole("heading", { name: "등록 정보 수정", exact: true })).toBeVisible();
  await expect(page.getByLabel("업무명", { exact: true })).toHaveValue(first.name);
  await expect(page.locator("form.ax-register textarea")).toHaveValue(first.description);
  await page.getByLabel("업무명", { exact: true }).fill("월간 운임 정산 취합 v2");
  await page.getByRole("button", { name: "수정 등록", exact: true }).click();
  await expect.poll(async () => (await record(page))?.tasks.map(t => [t.id, t.name])).toEqual([["first", "월간 운임 정산 취합 v2"], ["second", second.name]]);
  expect((await record(page))?.selectedTaskId).toBe("first");
  await expect(page.getByRole("heading", { name: "업무 등록", exact: true })).toBeVisible();
  // KPI 카드 제거로 1단계 문서가 짧아져, 삭제 후에는 브라우저 스크롤 클램프가 위치를 바꿀 수 있다.
  // 비교 기준을 스크롤 최상단으로 통일해 삭제 자체로 인한 상단 레이아웃 이동만 검증한다.
  const tablistTop = () => page.evaluate(() => document.querySelector('[role="tablist"][aria-label="진단 단계"]')!.getBoundingClientRect().y);
  // scroll-behavior: smooth 환경에서는 scrollTo 직후 측정이 중간 위치를 잡을 수 있어, 스크롤이 0에 안착한 뒤 측정한다.
  const tablistTopAtScrollTop = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
    return tablistTop();
  };
  const tabTopBefore = await tablistTopAtScrollTop();
  await row(second.name).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(row(second.name)).toHaveCount(0);
  await expect(page.getByText("업무를 삭제했습니다.", { exact: false })).toHaveCount(0);
  expect(await tablistTopAtScrollTop()).toBe(tabTopBefore);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await row("월간 운임 정산 취합 v2").getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(list).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다음 단계", exact: true })).toBeDisabled();
});
test("AX saves warn another tab and refresh loads the registered task", async ({ page, context }) => {
  await page.goto("/"); await ax(page);
  const other = await context.newPage();
  await other.goto("/"); await ax(other);
  await expect(other.getByLabel("업무 설명", { exact: true })).toBeVisible();
  await expect(other.getByLabel("등록 업무 목록")).toHaveCount(0);
  await register(page, "A 탭에서 등록한 업무");
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ name: "A 탭에서 등록한 업무" }] });
  const notice = other.getByRole("status").filter({ has: other.getByRole("button", { name: "새로고침", exact: true }) });
  await expect(notice).toBeVisible();
  await expect(other.getByLabel("등록 업무 목록")).toHaveCount(0);
  await notice.getByRole("button", { name: "새로고침", exact: true }).click();
  await ax(other);
  await expect(other.getByLabel("등록 업무 목록")).toContainText("A 탭에서 등록한 업무");
  await expect(notice).toHaveCount(0);
  await other.close();
});
test("AX attachment preflight rejects empty files and unsupported formats", async ({ page }) => {
  await page.goto("/"); await ax(page);
  const input = page.getByLabel("파일 추가", { exact: true });
  await input.setInputFiles({ name: "empty.csv", mimeType: "text/csv", buffer: Buffer.alloc(0) });
  await expect(page.getByText("빈 파일은 첨부할 수 없습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("첨부 요약을 준비했습니다", { exact: false })).toHaveCount(0);
  await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("업무 메모") });
  await expect(page.getByText("지원하지 않는 파일 형식입니다.", { exact: false })).toBeVisible();
  await expect(page.getByText("첨부 요약을 준비했습니다", { exact: false })).toHaveCount(0);
});


test("AX execution package remains readable on mobile with the setup guide collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const task = taskFixture("mobile-package", { ...diagnosisFixture, planCodex: planFixture, planClaude: planFixture, operation: { ...diagnosisFixture.operation, notes: [] } });
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(section.getByRole("button", { name: "설치·시작 가이드", exact: true })).toHaveAttribute("aria-expanded", "false");
  for (const name of ["구현 후 확인 · GitHub 반영", "배포 방법", "상세 구현 계획 보기"]) await expect(section.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "운영 시 참고사항", exact: true })).toHaveCount(0);
  await expect(section.getByRole("region", { name: "구현 범위·완료 기준", exact: true })).toContainText("사용자 수행");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/ax/roadmap-mobile-${test.info().project.name}.png`, fullPage: true });
  const mobileView = section.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
  await expect(mobileView.getByRole("heading", { name: "구현 범위·완료 기준", exact: true })).toBeVisible();
  expect(await mobileView.evaluate(root => [...root.querySelectorAll("li")].every(el => el.getBoundingClientRect().right <= innerWidth + 0.5))).toBe(true);
  await mobileView.screenshot({ path: `artifacts/ax/plan-view-mobile-${test.info().project.name}.png` });
  for (const [tool, copy] of [["Codex", "Codex용 올인원 지시문 복사"], ["Claude Code", "Claude Code용 올인원 지시문 복사"]]) {
    await section.getByRole("tab", { name: tool, exact: true }).click();
    const button = section.getByRole("button", { name: copy, exact: true });
    await expect(button).toBeVisible();
    await expect(button.locator("svg")).toHaveCount(1);
    const prompt = section.locator(".ax-prompt");
    await expect(prompt).toBeHidden();
  }
  await expect(section.locator(".ax-prompt")).toContainText("배포 방식 확인 필요");
  const guide = section.getByRole("button", { name: "설치·시작 가이드", exact: true });
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "true");
  await expectGuideTutorial(page, section.locator(".ax-guide-panel"), "Claude Code");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/ax/setup-toolbar-mobile-${test.info().project.name}.png` });
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/ax/execution-package-mobile-${test.info().project.name}.png` });
});

const implementationActions = [
  "입력 파일 인코딩을 확인하고 원본을 보존한다", "헤더와 업무 항목의 매핑을 검토한다",
  "빈 레코드를 검토 대상으로 분리한다", "중복 후보를 삭제하지 않고 표시한다",
  "승인된 규칙으로 취합한다", "불일치 행을 별도 검토표로 만든다",
  "담당자 검토 결과를 기록한다", "승인 전에는 외부 시스템에 전송하지 않는다",
  "결과 파일의 변경 내역을 남긴다", "실패 시 원본과 수동 절차를 복구한다",
];
const verificationCases = [
  "정상 월말 입력과 수동 취합 결과를 대조한다", "빈 입력에서 결과를 생성하지 않는다",
  "누락 날짜가 있는 행은 검토 대상으로 남긴다", "음수 금액의 원래 부호를 보존한다",
  "같은 고객의 서로 다른 청구 건을 합치지 않는다", "재실행해도 승인 기록을 중복하지 않는다",
  "권한 만료 시 전송 성공으로 표시하지 않는다", "잘못된 인코딩을 사용자에게 알린다",
  "승인하지 않은 결과가 전송되지 않는다", "장애 후 원본 데이터가 그대로 남는다",
];
function longPlan(tool: "Codex" | "Claude Code"): AxPlan {
  return {
    ...planFixture,
    goal: [`${tool}: 월말 청구 내역의 정확한 취합`, `${tool}: 담당자 검토 근거를 결과에 보존`],
    asIs: [`${tool}: 원본 파일을 수동 대조`, `${tool}: 승인 내역을 별도 기록`],
    toBe: [`${tool}: 검토 대상과 정상 건을 분리`, `${tool}: 승인 후 결과 내보내기`],
    inScope: [`${tool}: 원본 읽기`, `${tool}: 날짜 정규화`, `${tool}: 금액 대조`, `${tool}: 검토표 생성`, `${tool}: 승인 이력 보존`],
    outOfScope: [`${tool}: 자동 승인`, `${tool}: 자동 지급`, `${tool}: 원본 삭제`, `${tool}: 미확인 규칙 추측`, `${tool}: 신규 연동 도입`],
    prerequisites: [`${tool}: 실제 샘플 구조 확인`, `${tool}: 승인 권한 확인`],
    humanInLoop: [`${tool}: 청구 금액 승인`, `${tool}: 미매칭 고객 확인`, `${tool}: 예외 지급 판단`],
    poc: [`${tool}: 승인된 월말 샘플 대조`, `${tool}: 예외 레코드 검토`],
    implementation: implementationActions.map((action, index) => `${tool}: ${action}${index === 0 ? " — 실제 월말 샘플의 날짜·금액·고객 식별자와 승인 이력을 기존 수동 취합 결과에 대조하고, 확인되지 않은 항목은 담당자가 원본을 확인할 수 있도록 검토표에 근거와 함께 남긴다.".repeat(3) : ""}`),
    dataFlow: [`${tool}: 입력 → 분리 → 검토`, `${tool}: 승인 → 내보내기`],
    integrations: [`${tool}: 확인된 읽기 권한 사용`, `${tool}: 승인된 결과만 전달`, `${tool}: 응답 실패를 분리`],
    exceptions: [`${tool}: 누락 날짜는 검토 대기`, `${tool}: 다른 통화는 별도 검토`, `${tool}: 불명확한 고객은 보류`],
    fallback: [`${tool}: 원본으로 수동 취합`, `${tool}: 전송 중단 후 담당자에게 알림`, `${tool}: 승인 기록 복구`],
    security: [`${tool}: 최소 읽기 권한`, `${tool}: 고객 식별자 로그 마스킹`, `${tool}: 인증 값은 기존 보관 방식 사용`],
    operation: [`${tool}: 규칙 변경 시 재검토`, `${tool}: 담당자가 장애 기록 확인`, `${tool}: 월말 결과 보관`],
    tests: verificationCases.map(item => `${tool}: ${item}`),
    acceptance: [`${tool}: 승인된 결과만 전달됨`, `${tool}: 모든 예외의 처리 근거가 남음`],
  };
}

for (const width of [1440, 390]) {
  test(`AX independent setup guide keeps prompt state, tool copy and navigation intact at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const tasks = ["guide-task-a", "guide-task-b"].map(id => taskFixture(id, {
      ...diagnosisFixture, planCodex: longPlan("Codex"), planClaude: longPlan("Claude Code"),
    }));
    await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step: 4 }); await ax(page);
    const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    const guideSection = section.locator(".ax-plan-guide");
    const guide = guideSection.getByRole("button", { name: "설치·시작 가이드", exact: true });
    await expect(guide).toBeVisible();
    const instructions = section.getByRole("region", { name: "04 올인원 지시문", exact: true });
    const heading = instructions.getByRole("heading", { name: "04 올인원 지시문", exact: true });
    const prompt = instructions.locator(".ax-prompt");
    await expect(guide).toHaveAttribute("aria-expanded", "false");
    await expect(prompt).toBeHidden();
    await expect(instructions.getByRole("button", { name: "설치·시작 가이드", exact: true })).toHaveCount(0);
    for (const tool of ["Codex", "Claude Code"] as const) {
      const guideState = await guide.getAttribute("aria-expanded");
      await instructions.getByRole("tab", { name: tool, exact: true }).click();
      await expect(guide).toHaveAttribute("aria-expanded", guideState!);
      await expect(prompt).toBeHidden();
      const original = (await prompt.textContent())!;
      expect(original).toContain(longPlan(tool).goal[0]);
      expect(original).not.toContain(longPlan(tool === "Codex" ? "Claude Code" : "Codex").goal[0]);
      const copy = instructions.getByRole("button", { name: `${tool}용 올인원 지시문 복사`, exact: true });
      for (const [guideOpen, promptOpen] of [[false, false], [true, false], [false, true], [true, true]]) {
        if ((await guide.getAttribute("aria-expanded") === "true") !== guideOpen) {
          await guide.scrollIntoViewIfNeeded(); await guide.focus();
          // The guide now sits at the bottom of the page: toggling its tall panel can clamp
          // the viewport scroll, so compare document-relative positions, not viewport ones.
          const docY = async () => (await guide.boundingBox())!.y + await page.evaluate(() => window.scrollY);
          const y = await docY();
          await page.keyboard.press("Enter");
          await expect(guide).toHaveAttribute("aria-expanded", String(guideOpen));
          await expect(guide).toBeFocused();
          await expect.poll(async () => Math.abs(await docY() - y)).toBeLessThanOrEqual(2);
        }
        const toggle = instructions.getByRole("button", { name: /^전체 (보기|접기)$/ });
        if ((await toggle.getAttribute("aria-expanded") === "true") !== promptOpen) await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", String(promptOpen));
        await expect(prompt).toHaveText(original);
        if (promptOpen) await expect(prompt).toBeVisible(); else await expect(prompt).toBeHidden();
        // One frame: separate boundingBox calls can straddle a scroll and report a false overlap.
        const order = await section.evaluate(root => {
          const top = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
          const completion = top('[aria-label="구현 범위·완료 기준"]'), guide = top(".ax-plan-guide"), instructions = top(".ax-plan-instructions");
          return { instructionsAfterCompletion: instructions.top >= completion.bottom - 1, guideAfterInstructions: guide.top >= instructions.bottom - 1 };
        });
        expect(order).toEqual({ instructionsAfterCompletion: true, guideAfterInstructions: true });
        if (guideOpen) {
          await expect.poll(() => guideSection.locator('[data-setup-step="8"]').evaluate(element => {
            const instructions = element.closest(".ax-surface")!.querySelector(".ax-plan-instructions")!;
            return element.getBoundingClientRect().top >= instructions.getBoundingClientRect().bottom - 1;
          })).toBe(true);
          if (browserName === "chromium") await page.evaluate(() => navigator.clipboard.writeText("navigation sentinel"));
          await expect(guideSection.locator(".ax-tutorial-toc > button")).toHaveCount(8);
          await expect(guideSection.getByRole("button", { name: "올인원 지시문으로 이동", exact: true })).toHaveCount(0);
          await guideSection.getByRole("button", { name: "04 올인원 지시문으로 이동", exact: true }).click();
          await expect(heading).toBeFocused();
          await expect.poll(() => heading.evaluate(element => {
            const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return r.top >= 0 && r.bottom <= innerHeight && !!hit && (hit === element || element.contains(hit));
          })).toBe(true);
          await expect(toggle).toHaveAttribute("aria-expanded", String(promptOpen));
          if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("navigation sentinel");
        }
        await copy.click(); await expect(copy).toHaveAttribute("data-copied", "true");
        if (browserName === "chromium") expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(original.replace(/\r\n/g, "\n"));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    // Task changes keep the existing keyed reset policy and must not reuse the other task's prompt.
    await page.getByRole("button", { name: new RegExp(tasks[1].name) }).first().click();
    await expect(guide).toHaveAttribute("aria-expanded", "false");
    await expect(prompt).toBeHidden();
    await expect(prompt).not.toContainText(tasks[0].name);
    await expectCopyUX(page, instructions, "Codex");
    const ids = await section.locator("[id]").evaluateAll(elements => elements.map(element => element.id));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(section.locator("button button, button a")).toHaveCount(0);
  });
}

for (const width of [1440, 390]) {
  test(`AX setup guide uses one disclosure title, quoted paths and no package managers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    const tasks = ["guide-v2-task"].map(id => taskFixture(id, {
      ...diagnosisFixture, planCodex: longPlan("Codex"), planClaude: longPlan("Claude Code"),
    }));
    await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step: 4 }); await ax(page);
    const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    const guideSection = section.locator(".ax-plan-guide");
    const guide = guideSection.getByRole("button", { name: "설치·시작 가이드", exact: true });
    await guide.scrollIntoViewIfNeeded();
    await guide.click();
    await expect(guide).toHaveAttribute("aria-expanded", "true");
    const panel = guideSection.locator(".ax-guide-panel");
    await expect(panel).not.toContainText(/winget|scoop install|choco install/i);
    await expect(panel.getByText("자세히 보기")).toHaveCount(0);
    // An optional section is one clickable title with a centred arrow; opening it never repeats the title.
    // (Previously Cloudflare의 Wrangler; that STEP 05 section was removed by the deploy-guide dedup,
    // so the disclosure behavior is now covered by the STEP 04 collapsed section instead.)
    const storage = panel.locator('[data-setup-step="4"]');
    const trigger = storage.getByRole("button", { name: "실패 시", exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(storage.getByText("실패 시", { exact: true })).toHaveCount(1);
    expect(await trigger.evaluate(element => {
      const title = element.querySelector(".ax-guide-section-title")!.getBoundingClientRect();
      const arrow = element.querySelector('[data-slot="accordion-indicator"]')!.getBoundingClientRect();
      return Math.abs(title.top + title.height / 2 - (arrow.top + arrow.height / 2));
    })).toBeLessThanOrEqual(1.5);
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(storage.getByText("실패 시", { exact: true })).toHaveCount(1);
    // Every path or URL argument in the project commands is double-quoted, as copied.
    const lines = (await panel.locator('[data-setup-step="2"] code').allTextContents()).flatMap(text => text.split("\n"));
    const pathCommands = lines.filter(line => /^(mkdir|cd|git clone|git remote add)\b/.test(line));
    expect(pathCommands.length).toBeGreaterThanOrEqual(6);
    for (const line of pathCommands) expect(line).toMatch(/"[^"]+"\s*$/);
    await expect(panel.locator('[data-setup-step="5"] .ax-guide-table thead th')).toHaveText(["비교", "Vercel", "Cloudflare"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

async function expectActualMarkerGaps(surface: Locator) {
  const rows = await surface.locator(".ax-guide-list li").evaluateAll(elements => elements.flatMap(li => {
    const marker = li.querySelector(".ax-guide-marker");
    const body = li.querySelector(".ax-guide-text");
    if (!marker || !body || !li.getBoundingClientRect().width) return [];
    const range = document.createRange();
    range.selectNodeContents(marker);
    const markerRect = range.getBoundingClientRect();
    range.selectNodeContents(body);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
    // Group rects by visual line: y values within 3px belong to the same line.
    // Inline elements (e.g. <code> with different font-size) can shift baseline by 1-2px.
    const sorted = [...rects].sort((a, b) => a.y - b.y);
    const lineGroups: typeof rects[] = [];
    for (const rect of sorted) {
      const group = lineGroups.find(g => Math.abs(g[0].y - rect.y) <= 3);
      if (group) group.push(rect);
      else lineGroups.push([rect]);
    }
    const lines = lineGroups.map(group => Math.min(...group.map(rect => rect.x)));
    return lines.length ? [{ gap: lines[0] - markerRect.right, lines }] : [];
  }));
  for (const row of rows) {
    expect(row.gap).toBeGreaterThanOrEqual(8);
    expect(row.gap).toBeLessThanOrEqual(12);
    for (const x of row.lines) expect(Math.abs(x - row.lines[0])).toBeLessThanOrEqual(2);
  }
}


async function expectGuideTutorial(page: Page, panel: Locator, tool: "Codex" | "Claude Code") {
  const toc = panel.locator(".ax-tutorial-toc");
  await expect(toc.getByRole("button", { name: /^STEP/ })).toHaveCount(8);
  const terms = panel.locator(".ax-tutorial-glossary");
  const trigger = terms.getByRole("button");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Instant pre-scroll: focusing alone would smooth-scroll (CSS scroll-behavior), and an
  // in-flight smooth scroll is not reliably cancelled by later instant scrolls — it can
  // resume afterwards and drift the viewport (Chromium quirk, verified 2026-10-19).
  await trigger.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "nearest" }));
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(terms.locator(".ax-git-flow")).toBeVisible();
  for (let number = 1; number <= 8; number++) {
    const link = toc.getByRole("button", { name: new RegExp(`STEP\\s*0?${number}\\b`) });
    // Same instant pre-scroll as above: a focus-triggered smooth scroll would race with
    // goToStep's instant scrollIntoView and drift the viewport afterwards.
    await link.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "nearest" }));
    await link.focus();
    await page.keyboard.press("Enter");
    const heading = panel.locator(`[data-setup-step="${number}"] > h4`);
    await expect(heading).toBeFocused();
    await expect.poll(() => heading.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= 0 && box.bottom <= innerHeight && !!hit && (hit === element || element.contains(hit));
    })).toBe(true);
  }
  // Navigation preserves optional disclosures and the selected agent's commands.
  await expect(terms.locator(".ax-git-flow")).toBeVisible();
  await trigger.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "nearest" }));
  await trigger.focus(); await page.keyboard.press("Space");
  await expect(terms.locator(".ax-git-flow")).toBeHidden();
  const first = panel.locator('[data-setup-step="1"]');
  const install = first.locator(".ax-guide-code-wrap").filter({ hasText: TOOL_GUIDES[tool === "Codex" ? "codex" : "claude"].installCommand });
  await expect(install).toHaveCount(1);
  await expect(install.locator("code")).toBeVisible();
  await expect(first.locator(".ax-guide-code").filter({ hasText: TOOL_GUIDES[tool === "Codex" ? "claude" : "codex"].installCommand })).toHaveCount(0);
  if (test.info().project.name.startsWith("chromium")) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const project = panel.locator('[data-setup-step="2"] .ax-guide-code-wrap').first();
    for (const block of [install, project]) {
      const command = (await block.locator("code").textContent())!;
      await block.getByRole("button", { name: /복사$/ }).click();
      expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(command.replace(/\r\n/g, "\n"));
    }
  }
  const second = panel.locator('[data-setup-step="2"]');
  // Per-step 이전/다음 navigation was removed; the TOC is the only step navigation.
  await expect(panel.locator(".ax-guide-step-nav")).toHaveCount(0);
  for (let number = 1; number <= 8; number++) {
    const step = panel.locator(`[data-setup-step="${number}"]`);
    await expect(step.getByRole("button", { name: "이전 단계", exact: true })).toHaveCount(0);
    await expect(step.getByRole("button", { name: "다음 단계", exact: true })).toHaveCount(0);
  }
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectActualMarkerGaps(panel);
  await second.screenshot({ path: `artifacts/ax/guide-project-${tool}-${page.viewportSize()!.width}-${test.info().project.name}.png` });
}

async function expectPromptDisclosure(page: Page, section: Locator, tool: "Codex" | "Claude Code", width: number) {
  const prompt = section.locator(".ax-prompt");
  const toggle = section.getByRole("button", { name: "전체 보기", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(prompt).toBeHidden();
  const original = (await prompt.textContent())!;
  await expect.poll(async () => {
    const saved = await record(page);
    const task = saved?.tasks.find(item => item.id === saved?.selectedTaskId);
    return tool === "Codex" ? task?.diagnosis?.planCodex : task?.diagnosis?.planClaude;
  }).toBeDefined();
  const beforeState = await record(page);
  await expectCopyUX(page, section, tool);
  await toggle.scrollIntoViewIfNeeded();
  const screenshotName = `${width === 1440 ? "Desktop1440" : "Mobile390"}-${tool === "Codex" ? "codex" : "claude"}-${test.info().project.name}`;
  await page.screenshot({ path: `artifacts/ax/prompt-collapsed-${screenshotName}.png` });
  await toggle.focus(); await page.keyboard.press("Enter");
  const collapse = section.getByRole("button", { name: "전체 접기", exact: true });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(collapse).toBeFocused();
  await expect(prompt).toBeVisible();
  expect(await prompt.textContent()).toBe(original);
  expect(await prompt.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await expectCopyUX(page, section, tool);
  expect(await record(page)).toEqual(beforeState);
  await prompt.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `artifacts/ax/prompt-expanded-${screenshotName}.png`, fullPage: true });
  await collapse.focus(); await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(prompt).toBeHidden();
  expect(await prompt.textContent()).toBe(original);
  expect(await record(page)).toEqual(beforeState);
}

for (const width of [1440, 390]) {
  test(`AX three human decisions keep distinct tool facts and exact full prompts at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const codex = longPlan("Codex"), claude = longPlan("Claude Code");
    await page.route("**/api/ai", async route => {
      const request = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        data: { kind: "ax-plan", plan: request.target === "claude" ? claude : codex },
      }) });
    });
    await page.goto("/");
    const task = taskFixture(`long-${width}`, diagnosisFixture);
    await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
    await ax(page);
    const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    const summary = section.locator("section[aria-label='구현 범위·완료 기준']");
    const precheck = section.locator("section[aria-label='구현 전 확인']");
    await expect(section.locator(".ax-plan-head")).toContainText(task.name);
    await expect(summary).toContainText("담당자 승인");
    await expect(summary).toContainText("누락 발생");
    for (const [tool, target, plan, other] of [["Codex", "codex", codex, claude], ["Claude Code", "claude", claude, codex]] as const) {
      if (target === "claude") await section.getByRole("tab", { name: tool, exact: true }).click();
      await section.getByRole("button", { name: `${tool}용 구현 계획 생성`, exact: true }).click();
      // Generated plans may add restrictive human/exclusion facts, never new permitted work.
      await expect(precheck).toContainText(plan.prerequisites[0]);
      await expect(precheck).not.toContainText(other.prerequisites[0]);
      await expect(summary).toContainText("담당자 승인");
      await expect(summary).toContainText("누락 발생");
      for (const item of plan.humanInLoop) {
        await expect(summary).toContainText(item);
        await expect(summary).not.toContainText(other.humanInLoop[plan.humanInLoop.indexOf(item)]);
      }
      for (const item of plan.outOfScope) await expect(summary).toContainText(item);
      const permitted = summary.locator('[data-scope-group="include"]');
      for (const item of [...plan.inScope, ...plan.implementation]) await expect(permitted).not.toContainText(item);
      // 요약 목록에는 동작 버튼이 없다 (①의 '업무 진단에서 확인' 이동 버튼은 별도 영역).
      await expect(summary.getByRole("button")).toHaveCount(0);
      const raw = buildAllInOnePrompt(plan, target, { taskName: task.name, prerequisites: ["시스템 접근 — API와 권한 실제 확인", "권한 확인 후 진행"], diagnosis: diagnosisFixture, context: task.description });
      await expect(section.locator(".ax-prompt")).toHaveText(raw);
      await expectPromptDisclosure(page, section, tool, width);
      if (browserName === "chromium") {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
        await section.getByRole("button", { name: `${tool}용 올인원 지시문 복사`, exact: true }).click();
        expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(raw);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    await section.getByRole("tab", { name: "Codex", exact: true }).click();
    await section.getByRole("button", { name: "전체 보기", exact: true }).click();
    await section.getByRole("tab", { name: "Claude Code", exact: true }).click();
    await expect(section.getByRole("button", { name: "전체 보기", exact: true })).toHaveAttribute("aria-expanded", "false");
    await section.getByRole("tab", { name: "Codex", exact: true }).click();
    await expect(section.getByRole("button", { name: "전체 보기", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(precheck).toContainText(codex.prerequisites[0]);
    await expect(precheck).not.toContainText(claude.prerequisites[0]);
  });
}

for (const level of [0, 1, 2, 3]) {
  for (const gate of ["ready", "conditional", "blocked"] as const) {
    test(`AX renders diagnosed Level ${level}, ${gate} gate and only permitted scope`, async ({ page }) => {
      const diagnosis: AxDiagnosis = {
        ...diagnosisFixture,
        factors: diagnosisFixture.factors.map(factor => ({
          ...factor,
          aiValue: factor.key === "humanJudgment" ? level === 1 ? 4 : 2
            : factor.key === "operationalRisk" ? 2 : level === 0 ? 1 : level === 3 ? 4 : 3,
        })),
        decisionGate: gate === "blocked" ? { verdict: "no-go", reasons: ["보안 정책상 자료 반출 불가"] }
          : gate === "conditional" ? diagnosisFixture.decisionGate : { verdict: "go", reasons: [] },
        technicalChecks: gate === "ready" ? [{ topic: "시스템 접근", status: "확인됨", note: "API 확인" }] : diagnosisFixture.technicalChecks,
      };
      await page.goto("/");
      const task = taskFixture(`level-${level}-${gate}`, diagnosis);
      await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
      await ax(page);
      const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
      const summary = section.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
      const precheck = section.getByRole("region", { name: "구현 전 확인", exact: true });
      await expect(section.locator(".ax-plan-head")).toContainText(`Level ${level}`);
      await expect(section.locator(".ax-plan-head")).toContainText(gate === "ready" ? "진행 가능" : gate === "blocked" ? "진행 보류" : "확인 후 진행");
      await expect(section.locator(".ax-plan-head")).toContainText(task.name);
      await expect(summary).toContainText("담당자 승인");
      await expect(summary).toContainText("누락 발생");
      // 실행 로드맵·Phase 카드·진단 요약 카드는 간소화로 제거됐다. 단계별 처리 범위
      // 판정 자체는 lib 정책 그대로이며, ② 요약 목록이 허용 범위를 표시한다.
      if (gate === "blocked") {
        await expect(precheck).toContainText("보안 정책상 자료 반출 불가");
        await expect(section.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeDisabled();
        await expect(section.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeDisabled();
        await expect(section.locator(".ax-prompt")).toHaveCount(0);
        await expect(section.getByRole("button", { name: /용 올인원 지시문 복사$/ })).toHaveCount(0);
      } else {
        await expect(section.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
        if (gate === "ready") {
          // 확인됨 항목은 ①에서 반복하지 않는다.
          await expect(precheck.getByText("시스템 접근", { exact: true })).toHaveCount(0);
        } else {
          // 조건부: 미완료 필수 항목이 ①에 표시된다. Level 0에서는 '시스템 접근'이
          // 향후 단계 조건(future)이므로 기본 화면에서 반복하지 않는다.
          await expect(precheck.getByText("권한 확인 후 진행", { exact: true })).toBeVisible();
          if (level === 0) await expect(precheck.getByText("시스템 접근", { exact: true })).toHaveCount(0);
        }
      }
      if (level === 0) {
        await expect(summary).toContainText("준비·검증");
        await expect(summary).toContainText("자료 수집 자동 실행");
        await expect(summary).toContainText("형식 검증 AI 보조 구현");
        await expect(summary).toContainText("샘플 데이터 형식·필수 항목 확인");
      }
      if (level <= 1) await expect(summary).toContainText("운영 자동화 적용");
      await expect(section.getByRole("region", { name: "04 올인원 지시문", exact: true })).toBeVisible();
    });
  }
}

test("AX separates confirmed checks from unresolved prerequisites without duplicating check notes", async ({ page }) => {
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    technicalChecks: [
      { topic: "샘플 파일", status: "확인됨", note: "헤더와 실제 행 확인" },
      { topic: "연동 인증", status: "확인 필요", note: "관리자에게 접근 권한 확인" },
    ],
  };
  await page.goto("/");
  const task = taskFixture("mixed-checks", diagnosis);
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  // 간소화 후 ①에는 미완료 항목만 표시되고, 확인됨 항목은 기본 화면에서 반복하지 않는다.
  const precheck = page.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(precheck.getByText("연동 인증", { exact: true })).toBeVisible();
  await expect(precheck.getByText("관리자에게 접근 권한 확인", { exact: true })).toHaveCount(1);
  await expect(precheck).toContainText("권한 확인 후 진행");
  await expect(precheck.getByText("샘플 파일", { exact: true })).toHaveCount(0);
  await expect(precheck.getByText("헤더와 실제 행 확인", { exact: true })).toHaveCount(0);
});

test("AX Level 0 keeps generated implementation suggestions subordinate to diagnosis", async ({ page }) => {
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    factors: diagnosisFixture.factors.map(factor => ({
      ...factor, aiValue: factor.key === "operationalRisk" ? 2 : 1,
    })),
    decisionGate: { verdict: "go", reasons: [] },
    technicalChecks: [{ topic: "샘플 접근", status: "확인됨", note: "검증용 파일 확인" }],
    planCodex: planFixture,
  };
  await page.goto("/");
  const task = taskFixture("level-zero-tool-plan", diagnosis);
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const summary = section.locator("section[aria-label='구현 범위·완료 기준']");
  await expect(section.locator(".ax-plan-head")).toContainText("Level 0");
  const permitted = summary.locator('[data-scope-group="include"]');
  await expect(permitted).toContainText("샘플 데이터 형식·필수 항목 확인");
  await expect(summary).not.toContainText(planFixture.inScope[0]);
  const prompt = await section.locator(".ax-prompt").textContent();
  const review = prompt!.split("### 함께 수행할 확인")[1].split("###")[0];
  expect(review).toContain("- 샘플 데이터 형식·필수 항목 확인");
  expect(prompt).not.toMatch(/^### (이번 구현|확인 후 구현)$/mu);
  expect(prompt!.split("### 향후 확장 (이번 작업에서 구현하지 않음)")[1].split("###")[0]).toContain(`- 생성 계획 제안: ${planFixture.inScope[0]} — Level 0은 검토·검증만 허용`);
  await expect(section.locator(".ax-prompt")).toContainText("업무 정리와 검토·검증 수준으로 진행하세요.");
});

test("AX completion keeps separate evidence, failure and risk meanings", async ({ page }) => {
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    technicalChecks: [{ topic: "월말 연동 접근", status: "확인 필요", note: "청구 원본의 읽기 권한을 관리자에게 확인" }],
    asIs: { ...diagnosisFixture.asIs, exceptions: ["고객 코드 누락", "고객 코드 누락 시 담당자에게 고객 식별 근거 요청"] },
    risks: ["원본 청구 금액과 취합 결과의 불일치"],
    poc: {
      ...diagnosisFixture.poc,
      evaluation: ["지난달 승인 결과와 거래별 금액을 대조"],
      success: ["거래별 차이가 없고 담당자가 검토 완료"],
      failure: ["하나라도 원본 거래가 사라지면 적용 중지"],
    },
  };
  await page.goto("/");
  const task = taskFixture("distinct-step4", diagnosis);
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const precheck = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  const summary = plan.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
  await expect(precheck.getByText("월말 연동 접근", { exact: true })).toBeVisible();
  await expect(precheck.getByText("청구 원본의 읽기 권한을 관리자에게 확인", { exact: true })).toHaveCount(1);
  // 예외·위험 패널은 기본 화면에서 제거됐다. 완료 기준 행에는 근거·실패 의미만 남고,
  // 예외·위험 항목은 ② 완료 기준에 섞이지 않는다 (원본 데이터·04 지시문에는 유지).
  for (const item of [...diagnosis.asIs.exceptions, ...diagnosis.risks]) await expect(summary).not.toContainText(item);
  const row = (label: string) => summary.locator(".ax-scope-summary-criteria > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
  for (const item of diagnosis.poc.evaluation) await expect(row("검증 방법")).toContainText(item);
  for (const item of diagnosis.poc.success) await expect(row("통과 조건")).toContainText(item);
  for (const item of diagnosis.poc.failure) await expect(row("실패 기준")).toContainText(item);
});

for (const width of [1440, 390]) {
  test(`AX guide code copy preserves only code and shows icon feedback at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const task = taskFixture("guide-copy", { ...diagnosisFixture, planCodex: planFixture, planClaude: planFixture });
    await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 }); await ax(page);
    const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    for (const tool of ["Codex", "Claude Code"] as const) {
      await section.getByRole("tab", { name: tool, exact: true }).click();
      const guide = section.getByRole("button", { name: "설치·시작 가이드", exact: true });
      if (tool === "Codex") await guide.click();
      await expect(guide).toHaveAttribute("aria-expanded", "true");
      await expectGuideTutorial(page, section.locator(".ax-guide-panel"), tool);
      for (const label of ["PowerShell 명령"]) {
        const block = section.locator(".ax-guide-code-wrap").filter({ has: page.locator(`pre[aria-label="${label}"]`) }).first();
        const code = await block.locator("code").innerText();
        const button = block.getByRole("button", { name: `${label} 복사`, exact: true });
        await expect(button).toHaveText("");
        await button.click();
        await expect(button.locator("svg.lucide-check")).toBeVisible();
        if (browserName === "chromium") expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(code);
        const before = (await button.boundingBox())!;
        await expect(button.locator("svg.lucide-copy")).toBeVisible();
        const after = (await button.boundingBox())!;
        expect(after.x).toBeCloseTo(before.x, 1); expect(after.y).toBeCloseTo(before.y, 1);
        await block.screenshot({ path: `artifacts/ax/guide-copy-${width}-${tool === "Codex" ? "codex" : "claude"}-ps-${test.info().project.name}.png` });
      }
      await expect(section.locator(".ax-guide-section > p .ax-guide-copy-button")).toHaveCount(0);
      if (tool === "Claude Code") await guide.click();
    }
  });
}


function multiTasks(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const diagnosis: AxDiagnosis = { ...diagnosisFixture,
      factors: diagnosisFixture.factors.map(factor => ({ ...factor, rationale: `${index + 1}번 업무의 ${factor.key} 진단 근거` })),
    };
    return { ...taskFixture(`multi-${index + 1}`, diagnosis), diagnosis,
      name: `업무 ${String(index + 1).padStart(2, "0")}`, minutesPerRun: (count - index) * 60, runsPerMonth: 1 };
  });
}
async function badgeStyle(badge: Locator) {
  return badge.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, padding: style.padding, radius: style.borderRadius,
      font: style.font, border: style.border, height: Math.round(element.getBoundingClientRect().height * 100) / 100 };
  });
}
for (const width of [1440, 390]) for (const count of [1, 3, 5, 10]) {
  test(`AX multi-task comparison and all-task selection for ${count} tasks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    const tasks = multiTasks(count), last = tasks.at(-1)!;
    await seed(page, { ...emptyAxState(), tasks, selectedTaskId: last.id, step: 3 }); await ax(page);
    // Step 3 좌측 업무 목록은 종합 점수 순위 순으로 표시되며 순번은 점수 순위와 일치한다.
    const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
    await expect(matrixList.getByRole("listitem")).toHaveCount(count);
    for (const [index, task] of tasks.slice(0, 3).entries()) {
      await expect(matrixList.locator(".ax-task-name").nth(index)).toHaveText(`${index + 1}. ${task.name}`);
    }
    await page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: new RegExp(last.name) }).click();
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(last.id);
    await expect(page.locator(".ax-matrix-detail").getByRole("heading").first()).toContainText(last.name);
    const matrixBadge = await badgeStyle(page.locator('.ax-matrix-list .ax-gate-badge[data-gate="conditional"]').first());
    expect(await badgeStyle(page.locator('.ax-matrix-detail .ax-diag-badges .ax-gate-badge[data-gate="conditional"]'))).toEqual(matrixBadge);
    await page.locator(".ax-matrix-surface").screenshot({ path: `artifacts/ax/multi-matrix-${count}-${width}-${test.info().project.name}.png` });
    await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
    await expect(page.locator(".ax-report-intro h2")).toHaveText(last.name);
    await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText(`${count}개`);
    await expect(page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) }).locator("strong")).toHaveText(`${count}개`);
    await expect(page.locator(".ax-step4-overview .ax-priority-list").first().locator(".ax-rank")).toHaveText(tasks.map((_, index) => `#${index + 1}`));
    expect(await badgeStyle(page.locator('.ax-step4-overview .ax-gate-badge[data-gate="conditional"]').first())).toEqual(matrixBadge);
    // 통합 목록에는 전체 업무가 바로 표시되고, '전체 업무 보기'는 없다.
    await expect(page.getByRole("button", { name: "전체 업무 보기", exact: true })).toHaveCount(0);
    const list = page.getByRole("list", { name: "업무 목록", exact: true });
    await list.getByRole("button", { name: new RegExp(last.name) }).click();
    await expect(page.locator(".ax-report-intro h2")).toHaveText(last.name);
    await list.getByRole("button", { name: new RegExp(tasks[0].name) }).click();
    await expect(page.locator(".ax-report-intro h2")).toHaveText(tasks[0].name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/ax/multi-results-${count}-${width}-${test.info().project.name}.png` });
  });
}

for (const step of [3, 4]) test(`AX restores a diagnosed selection instead of an undiagnosed task in Step ${step}`, async ({ page }) => {
  await page.goto("/");
  const [diagnosed] = multiTasks(1), undiagnosed = taskFixture("undetected");
  await seed(page, { ...emptyAxState(), tasks: [diagnosed, undiagnosed], selectedTaskId: undiagnosed.id, step }); await ax(page);
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(diagnosed.id);
  if (step === 3) {
    await expect(page.locator(".ax-bubble")).toHaveCount(1);
    await expect(page.locator(".ax-matrix-detail").getByRole("heading").first()).toContainText(diagnosed.name);
  } else {
    await expect(page.locator(".ax-report-intro h2")).toHaveText(diagnosed.name);
  }
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await page.getByLabel("등록 업무 목록").locator("li").filter({ hasText: diagnosed.name }).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("tab", { name: step === 3 ? "자동화 매트릭스" : "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-empty")).toBeVisible();
  await expect(page.locator(".ax-bubble, .ax-selected-report, .ax-prompt")).toHaveCount(0);
});

for (const width of [1440, 390]) test(`AX score evidence and all ranks update together without affecting another plan at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.goto("/");
  const tasks = multiTasks(2);
  tasks[0].diagnosis.factors[0] = { ...tasks[0].diagnosis.factors[0], finalValue: 5 };
  tasks[0].status = "adjusted";
  tasks[0].diagnosis.factors[5] = { ...tasks[0].diagnosis.factors[5], rationale: "" };
  tasks[0].diagnosis.planCodex = planFixture; tasks[1].diagnosis.planClaude = planFixture;
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step: 3 }); await ax(page);
  const evidence = page.getByRole("button", { name: "점수 근거 확인", exact: true });
  await expect(evidence).toHaveAttribute("aria-expanded", "false"); await evidence.focus(); await page.keyboard.press("Enter");
  await expect(evidence).toHaveAttribute("aria-expanded", "true"); await expect(evidence).toBeFocused();
  const panel = page.getByRole("region", { name: "점수 근거", exact: true });
  await expect(panel.locator(".ax-score-result strong")).toHaveText(["4", "4"]);
  // 판단 필요도·운영 위험의 점수만 반복하던 추가 판단 요소 목록은 제거됨 (근거는 아래 평가 근거 상세가 유지)
  await expect(panel.locator(".ax-score-extra")).toHaveCount(0);
  // 중첩 펼침 제거: 점수 근거 확인 한 번으로 6개 Factor 근거가 모두 표시된다.
  await expect(panel.locator(".ax-score-factor")).toHaveCount(6);
  await expect(panel.locator(".ax-score-factor").filter({ hasText: "반복성" })).toContainText("최종 적용 5점");
  await expect(panel).toContainText("AI 제안 4점"); await expect(panel).toContainText("확인 필요");
  await expect(panel).not.toContainText("TO-BE");
  const axisStyles = await page.locator(".ax-x-label, .ax-y-label").evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element); return [style.padding, style.font, style.border, style.borderRadius, style.boxShadow, style.backgroundColor];
  }));
  expect(axisStyles[0]).toEqual(axisStyles[1]);
  await panel.screenshot({ path: `artifacts/ax/score-evidence-${width}-${test.info().project.name}.png` });
  await evidence.focus(); await page.keyboard.press("Enter");
  await expect(evidence).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  for (const label of ["반복성", "규칙성", "데이터 구조화", "시스템 접근성"]) await page.getByRole("button", { name: `${label} 1점`, exact: true }).click();
  await expect.poll(async () => (await record(page))?.tasks[0].diagnosis?.planCodex).toBeUndefined();
  expect((await record(page))?.tasks[1].diagnosis?.planClaude).toEqual(planFixture);
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${tasks[0].name} ·`) }));
  await expect(marker).toHaveAttribute("aria-label", new RegExp(`^${tasks[0].name} ·`));
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  expect(await marker.evaluate(element => ({ x: (element as HTMLElement).style.left, y: (element as HTMLElement).style.bottom }))).toEqual({ x: "0%", y: "0%" });
  await expect(page.getByLabel("매트릭스 업무 목록", { exact: true }).locator(".ax-task-name")).toHaveText([`1. ${tasks[1].name}`, `2. ${tasks[0].name}`]);
  await evidence.click(); await expect(panel.locator(".ax-score-result strong")).toHaveText(["1", "1"]);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-step4-overview .ax-priority-list").first().locator(".ax-task-name")).toHaveText([tasks[1].name, tasks[0].name]);
  await expect(page.locator(".ax-report-intro h2")).toHaveText(tasks[0].name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("AX partial diagnoses preserve selected task plans, tool prompts, copy and multi-task transfer", async ({ page, browserName }) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/ai", async route => {
    const request = route.request().postDataJSON(); calls.push(request);
    const response = request.kind === "ax-plan"
      ? { kind: "ax-plan", plan: { ...planFixture, goal: [`${request.task.name}-${request.target}-독립 구현`] } }
      : { kind: "ax-diagnosis", diagnosis: outputFixture() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: response }) });
  });
  await page.goto("/"); await ax(page);
  for (const name of ["A", "B", "C", "D", "E"]) await register(page, name);
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  for (const name of ["A", "B", "C"]) {
    await page.getByLabel("등록 업무 목록").getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
    if (name === "A") await page.getByRole("button", { name: /진단 항목 상세/ }).click();
    await expect(page.locator(".ax-factor-row")).toHaveCount(6);
  }
  await page.getByLabel("등록 업무 목록").getByRole("button", { name: /^E/ }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: /^1\. A/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: /B/ }).click();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-report-intro h2")).toHaveText("B");
  await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) }).locator("strong")).toHaveText("3개");
  await expect(page.getByRole("button", { name: "전체 업무 보기", exact: true })).toHaveCount(0);
  const top = page.locator(".ax-step4-overview .ax-priority-list").first();
  const plans = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  for (const name of ["A", "B"]) {
    await top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${name}$`) }) }).getByRole("button").click();
    await expect(plans.locator(".ax-plan-head")).toContainText(name);
    const scope = plans.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
    await expect(scope).not.toContainText(`${name === "A" ? "B" : "A"}-codex-독립 구현`);
    for (const tool of ["Codex", "Claude Code"]) {
      if (tool === "Claude Code") await plans.getByRole("tab", { name: tool, exact: true }).click();
      await plans.getByRole("button", { name: `${tool}용 구현 계획 생성`, exact: true }).click();
      await expect(plans.locator(".ax-prompt")).toContainText(`${name}-${tool === "Codex" ? "codex" : "claude"}-독립 구현`);
      await expect(plans.locator(".ax-prompt")).toContainText(`# ${name} 자동화 구현 지시문`);
      await expect(plans.locator(".ax-prompt")).not.toContainText(`${name}-${tool === "Codex" ? "claude" : "codex"}-독립 구현`);
      await expect(scope).not.toContainText("독립 구현");
    }
    await plans.getByRole("button", { name: "전체 보기", exact: true }).click();
  }
  await top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: /^C$/ }) }).getByRole("button").click();
  await expect(plans.locator(".ax-plan-head")).toContainText("C");
  await expect(plans.getByRole("region", { name: "구현 범위·완료 기준", exact: true })).not.toContainText("B-claude-독립 구현");
  await expect(plans.locator(".ax-prompt")).toHaveCount(0);
  await expect(plans.getByRole("button", { name: "전체 보기", exact: true })).toHaveCount(0);
  await plans.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(plans.locator(".ax-prompt")).toContainText("C-codex-독립 구현");
  await expect(plans.locator(".ax-prompt")).not.toContainText("A-codex-독립 구현");
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await plans.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe((await plans.locator(".ax-prompt").textContent())!.replace(/\r\n/g, "\n"));
  }
  for (const name of ["A", "B"]) for (const [tool, target] of [["Codex", "codex"], ["Claude Code", "claude"]]) {
    await top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${name}$`) }) }).getByRole("button").click();
    await plans.getByRole("tab", { name: tool, exact: true }).click();
    await expect(plans.locator(".ax-prompt")).toContainText(`${name}-${target}-독립 구현`);
    await expect(plans.locator(".ax-prompt")).not.toContainText("C-codex-독립 구현");
    await expect(plans.locator(".ax-plan-head")).toContainText(name);
    await expect(plans.getByRole("region", { name: "구현 범위·완료 기준", exact: true })).not.toContainText("독립 구현");
    await expect(plans.getByRole("button", { name: "전체 보기", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(plans.getByRole("button", { name: `${tool}용 올인원 지시문 복사`, exact: true })).not.toHaveAttribute("data-copied", "true");
  }
  expect(calls.filter(call => call.kind === "ax-diagnosis")).toHaveLength(3);
  await expect.poll(async () => { const saved = await record(page); return saved?.tasks.find(task => task.id === saved.selectedTaskId)?.name; }).toBe("B");
  expect(calls.filter(call => call.kind === "ax-plan")).toHaveLength(5);
  // Plans persist asynchronously; compare the transfer against the fully saved state.
  await expect.poll(async () => (await record(page))?.tasks.reduce((count, task) => count + (task.diagnosis?.planCodex ? 1 : 0) + (task.diagnosis?.planClaude ? 1 : 0), 0)).toBe(5);
  const before = (await record(page))!;
  const downloading = page.waitForEvent("download"); await dataAction(page, "데이터 내보내기"); const download = await downloading;
  const exported = await readFile((await download.path())!, "utf8");
  await dataAction(page, "데이터 초기화"); await page.getByRole("alertdialog").getByRole("button", { name: "초기화", exact: true }).click();
  await importData(page, exported);
  await expect.poll(async () => (await record(page))?.tasks).toEqual(before.tasks);
  expect((await record(page))?.selectedTaskId).toBe(before.selectedTaskId);
  await expect(plans.locator(".ax-prompt")).toContainText(`# B 자동화 구현 지시문`);
});

test("AX compares diagnoses regardless of provisional status and preserves other plans on re-diagnosis", async ({ page }) => {
  await mock(page); await page.goto("/");
  const [a, c, d] = multiTasks(3);
  a.name = "완료 A"; c.name = "보정 C"; d.name = "정보 확인 D";
  c.diagnosis.factors[0] = { ...c.diagnosis.factors[0], finalValue: 5 }; c.status = "adjusted";
  d.diagnosis = { ...d.diagnosis, informationSufficiency: "needs-check", followUpQuestions: ["시스템 접근 확인"] }; d.status = "needs-info";
  c.diagnosis.planCodex = planFixture;
  const b = { ...taskFixture("b"), name: "미진단 B" }, e = { ...taskFixture("e"), name: "미진단 E" };
  await seed(page, { ...emptyAxState(), tasks: [a, b, c, d, e], selectedTaskId: e.id, step: 2 }); await ax(page);
  const list = page.getByLabel("등록 업무 목록");
  await expect(list.locator("li").filter({ hasText: d.name })).toContainText("정보 확인 필요");
  await expect(list.locator("li").filter({ hasText: c.name })).toContainText("사용자 보정 완료");
  await list.getByRole("button", { name: new RegExp(a.name) }).click();
  await page.getByRole("button", { name: "업무 다시 진단", exact: true }).click();
  await expect(page.getByRole("button", { name: "업무 다시 진단", exact: true })).toBeEnabled();
  await expect.poll(async () => (await record(page))?.tasks.find(task => task.id === c.id)?.diagnosis?.planCodex).toEqual(planFixture);
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.getByLabel("매트릭스 업무 목록").locator(".ax-task-name")).toHaveText(["1. 완료 A", "2. 보정 C", "3. 정보 확인 D"]);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  const resultKpi = page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) });
  await expect(resultKpi.locator("strong")).toHaveText("3개");
  await expect(resultKpi.locator("small")).toContainText("정보 확인 필요 업무 1개");
});

for (const width of [1440, 390]) {
  test(`AX rule validation preserves its method and approval boundary across report and tools at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const c = equipmentRuleCase;
    const diagnosis = { ...c.diagnosis, planCodex: c.plan, planClaude: c.plan };
    const task = { ...taskFixture("rule-method-consistency", diagnosis), name: c.name, description: c.description };
    await page.goto("/");
    await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
    await ax(page);
    const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    // 실행 로드맵 단계 배지는 간소화로 제거됐다. 규칙 문구·승인 경계는 ② 요약 목록과
    // 04 지시문에서 동일하게 검증한다 (단계별 처리 범위 판정 로직은 lib 그대로).
    const summary = plan.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
    await expect(summary.getByRole("listitem").filter({ hasText: "누락·중복 검증" }).first()).toContainText("규칙");
    await expect(summary.getByRole("listitem").filter({ hasText: "누락·중복 검증" }).first()).not.toContainText("후보·초안");
    await expect(summary).toContainText("최종 승인");
    for (const tool of ["Codex", "Claude Code"]) {
      await plan.getByRole("tab", { name: tool, exact: true }).click();
      const prompt = plan.locator(".ax-prompt");
      await expect(prompt).toContainText("누락·중복 검증");
      await expect(prompt).toContainText("승인");
      await expectCopyUX(page, plan, tool as "Codex" | "Claude Code");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

for (const [fromStep, toStep, toTab] of [[4, 3, "자동화 매트릭스"], [3, 2, "업무 진단"], [2, 1, "업무 등록"]] as const) {
  test(`이전 단계 이동 시 ${toTab} 화면 최상단으로 스크롤 (${fromStep}→${toStep})`, async ({ page }) => {
    const tasks = [taskFixture("scroll-a", diagnosisFixture), taskFixture("scroll-b", diagnosisFixture)];
    await page.goto("/");
    await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step: fromStep });
    await ax(page);
    // 화면 최하단까지 스크롤
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    // 이전 단계 클릭 → 해당 단계 최상단 표시
    await page.getByRole("button", { name: "이전 단계", exact: true }).click();
    await expect(page.getByRole("tab", { name: toTab, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
    // 선택 업무·데이터가 초기화되지 않음
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[0].id);
  });
}
test("AX coding tool selection syncs plan review, all-in-one instructions and setup guide", async ({ page }) => {
  const codexPlan = { ...planFixture, implementation: ["Codex 계획 항목"], acceptance: ["Codex 완료 기준"], tests: [] };
  const claudePlan = { ...planFixture, implementation: ["Claude 계획 항목"], acceptance: ["Claude 완료 기준"], tests: [] };
  const diagnosis = { ...diagnosisFixture, planCodex: codexPlan, planClaude: claudePlan };
  const task = taskFixture("tool-sync", diagnosis);
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const planSection = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const review = planSection.getByRole("region", { name: "구현 계획 검토", exact: true });
  // 최초 진입: 양쪽 계획이 있으면 Codex가 기본 선택 (검토·지시문 모두)
  await expect(review.getByText("Codex 계획 항목", { exact: true })).toBeVisible();
  await expect(review.getByText("Claude 계획 항목", { exact: true })).toHaveCount(0);
  await expect(planSection.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  // 04 올인원 지시문에서 Claude Code 선택 → 구현 계획 검토도 동일 도구 선택
  await planSection.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(review.getByText("Claude 계획 항목", { exact: true })).toBeVisible();
  await expect(review.getByText("Codex 계획 항목", { exact: true })).toHaveCount(0);
  await expect(planSection.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true })).toBeVisible();
  // 구현 계획 검토에서 Codex 선택 → 04 올인원 지시문도 동일 도구 선택
  await review.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(review.getByText("Codex 계획 항목", { exact: true })).toBeVisible();
  await expect(review.getByText("Claude 계획 항목", { exact: true })).toHaveCount(0);
  await expect(planSection.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  // 설치·시작 가이드는 현재 선택 도구(Codex)의 명령어를 표시 (레이아웃·클립보드 포함 검증)
  const guideTrigger = planSection.getByRole("button", { name: "설치·시작 가이드", exact: true });
  await guideTrigger.click();
  await expect(guideTrigger).toHaveAttribute("aria-expanded", "true");
  await expectGuideTutorial(page, planSection.locator(".ax-guide-panel"), "Codex");
});
