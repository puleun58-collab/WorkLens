import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxState, type AxDiagnosis, type AxPlan } from "../../src/lib/ax/types";
import { buildAllInOnePrompt, TOOL_GUIDES } from "../../src/lib/ax/guide";
import { exportAxState } from "../../src/lib/ax/transfer";
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
async function expectPromptStructure(prompt: Locator, taskName: string) {
  await expect(prompt).toContainText(`# ${taskName} 자동화 구현 지시문`);
  const text = (await prompt.textContent())!;
  expect(text).not.toContain("자동화 자동화");
  expect(text).not.toMatch(/\d+번/);
  expect(text).not.toContain("에서 실행하는 것을 전제로 합니다");
  const numbers = [...text.matchAll(/^## (\d+)\./gm)].map(match => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers).toEqual(numbers.map((_, index) => index + 1));
}
async function expectGuideToolbar(section: Locator, sameRow: boolean) {
  const tabs = section.getByRole("tablist", { name: "AI 코딩 도구 선택", exact: true });
  const guide = section.getByRole("button", { name: "설치·시작 가이드", exact: true });
  const tabsBox = await tabs.boundingBox(), guideBox = await guide.boundingBox();
  const packageBox = await section.locator(".ax-package").boundingBox();
  expect(tabsBox).not.toBeNull(); expect(guideBox).not.toBeNull(); expect(packageBox).not.toBeNull();
  expect(guideBox!.width).toBeLessThan(packageBox!.width * 0.8);
  expect(Math.abs(guideBox!.x + guideBox!.width - packageBox!.x - packageBox!.width)).toBeLessThanOrEqual(2);
  if (sameRow) {
    expect(Math.min(tabsBox!.y + tabsBox!.height, guideBox!.y + guideBox!.height)
      - Math.max(tabsBox!.y, guideBox!.y)).toBeGreaterThan(0);
    expect(guideBox!.x).toBeGreaterThan(tabsBox!.x + tabsBox!.width);
  }
}
async function expectCopyUX(page: Page, section: Locator, tool: "Codex" | "Claude Code") {
  const button = section.getByRole("button", { name: `${tool}용 지시문 복사`, exact: true });
  const prompt = section.locator(".ax-prompt");
  await expect(button).toHaveText("복사");
  await expect(button.locator('svg.lucide-copy[aria-hidden="true"]')).toHaveCount(1);
  await expect(button).not.toHaveAttribute("data-copied", "true");
  const expectRightAlignment = async () => {
    const buttonBox = await button.boundingBox();
    const promptBox = await prompt.boundingBox();
    expect(buttonBox).not.toBeNull(); expect(promptBox).not.toBeNull();
    expect(Math.abs(buttonBox!.x + buttonBox!.width - promptBox!.x - promptBox!.width)).toBeLessThanOrEqual(10);
  };
  await expectRightAlignment();
  if (test.info().project.name.startsWith("chromium")) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const before = await button.boundingBox();
    await button.click();
    await expect(button).toHaveText("복사");
    await expect(button).toHaveAttribute("data-copied", "true");
    await expect(section.locator(".ax-copy-error")).toHaveCount(0);
    await expect(button.locator('svg.lucide-check[aria-hidden="true"]')).toHaveCount(1);
    await expect(button.locator("svg.lucide-copy")).toHaveCount(0);
    const feedback = section.locator('.sr-only[aria-live="polite"]');
    await expect(feedback).toHaveText("복사했습니다.");
    // sr-only remains available to assistive technology but is visually clipped.
    expect(await feedback.evaluate(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.position === "absolute" && style.overflow === "hidden"
        && (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") && box.width <= 1 && box.height <= 1;
    })).toBe(true);
    await expect(section.locator(".ax-copy-feedback")).toHaveCount(0);
    const after = await button.boundingBox();
    expect(after!.width).toBeCloseTo(before!.width, 1);
    expect(after!.x).toBeCloseTo(before!.x, 1);
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"))
      .toBe((await prompt.textContent())!.replace(/\r\n/g, "\n"));
    await expectRightAlignment();
    await expect(button).not.toHaveAttribute("data-copied", "true", { timeout: 3_000 });
    await expect(button.locator('svg.lucide-copy[aria-hidden="true"]')).toHaveCount(1);
    await expect(button.locator("svg.lucide-check")).toHaveCount(0);
    await expect(feedback).toBeEmpty();
    await expect(button).toHaveText("복사");
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
  await expect(page.getByLabel("업무명", { exact: true })).toHaveAccessibleDescription("비워두면 업무 설명을 기준으로 자동 생성됩니다.");
  await expect(page.getByLabel("업무 설명", { exact: true })).toHaveAttribute("required", "");
  await expect(page.getByLabel("업무 설명", { exact: true })).toHaveAttribute("placeholder", "어떤 업무를 반복하고 있으며, 어떤 자료를 받아 어떤 결과를 만드는지 설명해주세요.");
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
  for (const [tab, text, removed] of [
    ["업무 진단", "먼저 업무를 등록해주세요.", "진단할 업무가 없습니다"],
    ["자동화 매트릭스", "진단이 완료된 업무가 없습니다.", "비교할 진단 결과가 없습니다"],
    ["결과·로드맵", "완료된 진단 결과가 없습니다.", "아직 결과가 없습니다"],
  ]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tabpanel").getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByRole("tabpanel").getByRole("heading")).toHaveCount(0);
    await expect(page.getByText(removed, { exact: false })).toHaveCount(0);
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
  await expect(page.locator(".ax-axis-bars").getByText("담당자 판단 필요도", { exact: true })).toBeVisible();
  for (const old of ["사람 판단 의존도", "담당자 판단 의존도", "선행 확인 필요", "실행 가능성"]) await expect(page.getByText(old, { exact: false })).toHaveCount(0);
  await expect(page.locator(".ax-gate-line")).toContainText("실행 상태");
  await expect(page.locator(".ax-gate-checks")).toHaveText(/^확인 필요시스템 접근$/);
  await expect(page.getByText("먼저 확인", { exact: false })).toHaveCount(0);
  await expect(page.locator(".ax-data-actions .ax-utility-message")).toHaveText("업무 진단을 완료했습니다. 필요한 경우 점수를 조정하세요.");
  const utility = await page.evaluate(() => { const message = document.querySelector(".ax-utility-message")!.getBoundingClientRect(), menu = document.querySelector('[aria-label="AI•AX 데이터 작업"]')!.getBoundingClientRect(), steps = document.querySelector(".ax-steps")!.getBoundingClientRect(); return { overlap: message.top < menu.bottom && message.bottom > menu.top, above: message.bottom <= steps.top && menu.bottom <= steps.top }; });
  expect(utility).toEqual({ overlap: true, above: true });
  await expect(page.locator(".ax-radar text").filter({ hasText: "필요도" })).toHaveCount(1);
  expect(await page.locator(".ax-radar text").evaluateAll(texts => texts.map(text => [...text.querySelectorAll("tspan")].map(span => span.textContent)))).toEqual([["반복성"], ["규칙성"], ["데이터", "구조화"], ["시스템", "접근성"], ["담당자 판단", "필요도"], ["운영", "위험"]]);
  await page.screenshot({ path: `artifacts/ax/diagnosis-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await expect(page.getByText("사용자 보정 완료", { exact: true }).last()).toBeVisible();
  const reset = page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true });
  await expect(page.getByRole("button", { name: "AI 값으로", exact: true })).toHaveCount(0);
  await expect(reset).toHaveCount(1); await expect(reset).toBeEnabled();
  await expect(reset.locator("svg.lucide-rotate-ccw")).toHaveCount(1);
  await reset.hover(); await expect(page.getByRole("tooltip").or(page.locator('[data-slot="tooltip-popup"]')).first()).toContainText("AI 제안값으로 되돌리기");
  await page.locator(".ax-factor-row").first().screenshot({ path: `artifacts/ax/factor-reset-${test.info().project.name}.png` });
  await reset.click(); await expect(reset).toHaveCount(0);
  // A correction equal to the AI suggestion leaves nothing to restore.
  await page.getByRole("button", { name: "반복성 4점", exact: true }).click(); await expect(reset).toHaveCount(0);
  await expect(page.locator(".ax-factor-corrected")).toHaveCount(0);
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click(); await expect(reset).toBeEnabled();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: false }).click();
  await expect(page.getByLabel("매트릭스 업무 목록")).toContainText("가치 3 · 실현 4");
  await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true })).toContainText("검토 후보");
  await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true })).toContainText("자동화 가치 3");
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
  const top = page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true });
  await expect(top).toContainText("부분 자동화 · Level 2");
  await expect(top).toContainText("점수 7");
  await expect(page.locator('.ax-summary [data-slot="badge"]')).toHaveText("부분 자동화 · Level 2");
  expect(await page.evaluate(() => [...document.querySelectorAll(".ax-roadmap-panel *, .ax-detail-stack .ax-panel *")]
    .filter(element => element.getBoundingClientRect().width && getComputedStyle(element).textAlign === "center").map(element => element.textContent))).toEqual([]);
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
  await expect(page.getByRole("button", { name: "Codex용 지시문 복사", exact: true })).toBeVisible();
  const head = packageSection.locator(".ax-plan-head");
  await expect(head.getByRole("heading", { name: "자동화 구현 계획", exact: true })).toBeVisible();
  await expect(head).toContainText("월간 취합");
  await expect(head).toContainText("확인 후 진행");
  const scope = packageSection.getByRole("region", { name: "01 구현 범위", exact: true });
  const before = packageSection.getByRole("region", { name: "02 시작 전 확인", exact: true });
  const completion = packageSection.getByRole("region", { name: "03 완료 기준", exact: true });
  await expect(scope).toContainText("담당자 승인");
  await expect(scope).toContainText("담당자 수행 유지");
  await expect(before).toContainText("시스템 접근 — API와 권한 실제 확인");
  await expect(completion).toContainText("성공: 대조 통과");
  const detailTrigger = before.getByRole("button", { name: /기타 구현 참고/ });
  await detailTrigger.click();
  await expect(before.getByText("수동 취합", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await scope.screenshot({ path: `artifacts/ax/plan-view-${test.info().project.name}.png` });
  const prompt = packageSection.locator(".ax-prompt");
  for (const heading of ["# 월간 취합 자동화 구현 지시문", "## 2. 현재 진단 기준", "## 3. 작업 전 현재 프로젝트 확인", "## 4. AS-IS", "## 8. 구현 원칙", "## 9. 구현 요구사항", "## 15. Git 반영", "## 16. 배포 및 운영 적용", "## 17. 완료 조건", "## 18. 완료 보고"]) await expect(prompt).toContainText(heading);
  await expectPromptStructure(prompt, "월간 취합");
  const codexPrompt = await prompt.textContent();
  const prerequisiteSection = (await prompt.textContent())!.split("## 7. 구현 전 확인사항")[1].split("## 8.")[0];
  expect(prerequisiteSection).toContain("실제 저장소와 API 확인");
  expect(prerequisiteSection).toContain("시스템 접근 — API와 권한 실제 확인");
  expect(prerequisiteSection).toContain("권한 확인 후 진행");
  for (const name of ["구현 후 확인 · GitHub 반영", "배포 방법", "상세 구현 계획 보기"]) await expect(packageSection.getByRole("button", { name, exact: true })).toHaveCount(0);
  for (const name of ["운영·복구 계획", "실행 판단 · 조건부 진행"]) await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
  await expect(packageSection.getByRole("button", { name: "설치·시작 가이드", exact: true })).toHaveAttribute("aria-expanded", "false");
  const guide = packageSection.getByRole("button", { name: "설치·시작 가이드", exact: true });
  await expectGuideToolbar(packageSection, page.viewportSize()!.width >= 1024);
  const collapsedGuideBox = await guide.boundingBox();
  await expect(guide.locator("svg.lucide-terminal")).toHaveCount(1);
  await expect(guide.locator('[data-slot="accordion-indicator"]')).toHaveCount(1);
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "true");
  const guidePanel = packageSection.locator(".ax-guide-panel");
  await expectGuideTutorial(page, guidePanel, "Codex");
  await expectGuideToolbar(packageSection, page.viewportSize()!.width >= 1024);
  const expandedGuideBox = await guide.boundingBox();
  expect(expandedGuideBox!.width).toBeCloseTo(collapsedGuideBox!.width, 1);
  const toolbarBox = await packageSection.locator(".ax-plan-toolbar").boundingBox();
  const panelBox = await packageSection.locator('.ax-plan-toolbar [data-slot="accordion-panel"]').boundingBox();
  expect(panelBox!.width).toBeCloseTo(toolbarBox!.width, 1);
  expect(panelBox!.y).toBeGreaterThanOrEqual(expandedGuideBox!.y + expandedGuideBox!.height);
  await page.screenshot({ path: `artifacts/ax/setup-toolbar-${test.info().project.name}.png` });
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "false");
  await expect(guidePanel.locator(".ax-guide-code").first()).toBeHidden();
  await expectCopyUX(page, packageSection, "Codex");

  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(head.locator(".ax-plan-tool-hint")).toHaveText("Claude Code에서 현재 프로젝트를 열고 아래 지시문을 붙여넣으세요.");
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Claude Code용 지시문 복사", exact: true })).toBeVisible();
  await expectCopyUX(page, packageSection, "Claude Code");
  await expectPromptStructure(prompt, "월간 취합");
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
  await expect(page.getByRole("button", { name: "Codex용 지시문 복사", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Claude Code용 지시문 복사", exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Codex용 지시문 복사", exact: true })).toBeVisible();
  await expect.poll(() => record(page)).toEqual(saved);
  await page.reload(); await ax(page); await page.getByRole("tab", { name: "Claude Code", exact: true }).click(); await expect(page.getByRole("button", { name: "Claude Code용 지시문 복사", exact: true })).toBeVisible();
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
    const button = section.getByRole("button", { name: "Codex용 지시문 복사", exact: true });
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
test("AX safely resets unsupported/corrupt IndexedDB records", async ({ page }) => {
  await page.goto("/"); await seed(page, { schemaVersion: 99, tasks: "broken" }); await ax(page);
  await expect(page.getByText("안전하게 초기화했습니다", { exact: false })).toBeVisible();
  await expect(page.getByLabel("등록 업무 목록")).toHaveCount(0);
  await expect.poll(async () => (await record(page))?.schemaVersion).toBe(1);
  expect((await record(page))?.tasks).toEqual([]);
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
    await expect(page.locator(".ax-file-row").filter({ hasText: /selected\.csv\s*준비됨/ })).toBeVisible();
  };
  await selectFile();
  await page.getByRole("button", { name: "첨부 취소", exact: true }).click();
  await expect(page.getByText("selected.csv", { exact: false })).toHaveCount(0);
  await selectFile(); // The same file can be selected again after removal.
  await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await expect(page.getByRole("region", { name: "업무 자동화 진단", exact: true }).getByLabel("파일 추가", { exact: true })).toHaveCount(0);
  await expect(page.locator(".ax-attachment input[type=file]")).toHaveCount(0);
  await expect(page.locator(".ax-attachment")).toContainText("selected.csv · 세션 요약 준비됨");
  await page.getByRole("button", { name: "첨부 해제", exact: true }).click();
  await expect(page.locator(".ax-attachment")).toHaveCount(0);
  await page.getByRole("button", { name: "등록 정보 수정", exact: true }).click();
  await expect(input).toBeHidden();
  await selectFile();
  await page.getByRole("button", { name: "수정 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await expect(page.locator(".ax-attachment")).toContainText("selected.csv · 세션 요약 준비됨");
  await page.getByRole("button", { name: "첨부 해제", exact: true }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0]).not.toHaveProperty("attachmentSummary");
  await expect.poll(() => record(page)).toMatchObject({ step: 2, tasks: [{ status: "diagnosed", diagnosis: { informationSufficiency: "sufficient" } }] });
  expect((await record(page))?.tasks[0].attachmentMeta).toBeUndefined();
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
  await expect(page.getByText("핵심 확인사항 확인 필요", { exact: true })).toBeVisible();
  await expect(page.locator(".ax-summary")).toContainText("잠정");
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
  const tasks = page.getByLabel("등록 업무 목록");
  await tasks.getByRole("button", { name: "차단 업무", exact: false }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.locator('.ax-gate-badge[data-gate="blocked"]')).toHaveText("진행 보류");
  await expect(page.locator(".ax-gate-checks")).toHaveText("보류 사유필수 시스템 접근 불가");
  await tasks.getByRole("button", { name: "가능 업무", exact: false }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.locator('.ax-gate-badge[data-gate="ready"]')).toHaveText("진행 가능");
  await expect(page.locator(".ax-gate-checks")).toHaveCount(0);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  const top = page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true });
  await expect(top.locator("li .ax-task-name")).toHaveText(["가능 업무", "차단 업무"]);
  const blocked = top.getByRole("listitem").filter({ hasText: "차단 업무" });
  const ready = top.getByRole("listitem").filter({ hasText: "가능 업무" });
  await expect(blocked).toContainText("점수 12.5");
  await expect(ready).toContainText("점수 9");
  await expect(blocked.locator(".ax-region-chip")).toHaveText("빠른 실행 후보");
  await expect(blocked.locator(".ax-gate-cond")).toHaveText("진행 보류");
  await expect(ready.locator(".ax-rank")).toHaveText("#2");
  await expect(blocked.locator(".ax-rank")).toHaveText("#1");
  await expect(blocked.getByText("진행 보류", { exact: true })).toBeVisible();
  await blocked.getByRole("button").click();
  await expect(page.locator(".ax-detail-stack .ax-summary")).toBeVisible();
  await expect(page.locator(".ax-detail-stack .ax-gate-line")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeDisabled();
  const plans = page.locator("section.ax-surface").filter({ has: page.getByRole("heading", { name: "자동화 구현 계획", exact: true }) });
  await expect(plans.getByRole("status")).toHaveText("현재 진단에서는 구현 계획을 생성할 수 없습니다.");
  await expect(plans.getByRole("heading", { name: "구현 전 필수 조건", exact: true })).toHaveCount(0);
  await expect(plans.getByText("필수 시스템 접근 불가", { exact: true })).toBeVisible();
  await expect(plans.locator(".ax-prompt")).toHaveCount(0);
  await expect(plans.locator(".ax-plan-tool-hint")).toHaveCount(0);
  await expect(plans.getByRole("button", { name: /용 지시문 복사$/ })).toHaveCount(0);
  await expect(plans.getByRole("button", { name: "설치·시작 가이드", exact: false })).toHaveCount(0);
  await expect(plans.getByRole("heading", { name: "먼저 확인할 사항", exact: true })).toHaveCount(0);
  await ready.getByRole("button").click();
  await expect(plans.getByRole("heading", { name: "먼저 확인할 사항", exact: true })).toHaveCount(0);
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
  const codex = page.getByRole("button", { name: "Codex용 지시문 복사", exact: true });
  const claude = page.getByRole("button", { name: "Claude Code용 지시문 복사", exact: true });
  await expect(codex).toBeVisible();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  await expect(claude).toBeVisible();
  await expect.poll(() => record(page)).toMatchObject({ tasks: [{ diagnosis: { planCodex: planFixture, planClaude: planFixture } }] });
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
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
  const stepsTop = (await page.getByRole("tablist", { name: "진단 단계" }).boundingBox())!.y;
  await row(second.name).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(row(second.name)).toHaveCount(0);
  await expect(page.getByText("업무를 삭제했습니다.", { exact: false })).toHaveCount(0);
  expect((await page.getByRole("tablist", { name: "진단 단계" }).boundingBox())!.y).toBe(stepsTop);
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
  const notice = other.getByRole("status").filter({ hasText: "다른 탭에서 AI•AX 데이터가 변경되었습니다" });
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
  await expect(page.locator(".ax-panel tbody tr").filter({ hasText: "담당자 승인" })).toContainText("담당자 수행");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/ax/roadmap-mobile-${test.info().project.name}.png`, fullPage: true });
  const mobileView = section.locator(".ax-plan-view");
  await expect(mobileView.getByRole("heading", { name: "01 구현 범위", exact: true })).toBeVisible();
  expect(await mobileView.evaluate(root => [...root.querySelectorAll("li")].every(el => el.getBoundingClientRect().right <= innerWidth + 0.5))).toBe(true);
  await mobileView.screenshot({ path: `artifacts/ax/plan-view-mobile-${test.info().project.name}.png` });
  for (const [tool, copy] of [["Codex", "Codex용 지시문 복사"], ["Claude Code", "Claude Code용 지시문 복사"]]) {
    await section.getByRole("tab", { name: tool, exact: true }).click();
    const hint = section.locator(".ax-plan-tool-hint");
    await expect(hint).toHaveText(`${tool}에서 현재 프로젝트를 열고 아래 지시문을 붙여넣으세요.`);
    const button = section.getByRole("button", { name: copy, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveText("복사");
    await expect(button.locator("svg")).toHaveCount(1);
    const prompt = section.locator(".ax-prompt");
    await expectPromptStructure(prompt, task.name);
    await expectGuideToolbar(section, false);
    await expect(prompt).toContainText("## 2. 현재 진단 기준");
    await expect(prompt).toContainText(/## \d+\. 구현 원칙/);
    await expect(prompt).toContainText(/## \d+\. 완료 조건/);
    expect((await prompt.textContent())!.trimEnd()).toMatch(/## \d+\. 완료 보고[\s\S]*실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요\.$/);
    const buttonBox = await button.boundingBox(), promptBox = await prompt.boundingBox();
    expect(buttonBox).not.toBeNull(); expect(promptBox).not.toBeNull();
    expect(Math.abs(buttonBox!.x + buttonBox!.width - promptBox!.x - promptBox!.width)).toBeLessThanOrEqual(10);
    expect(await prompt.evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth && element.clientHeight <= 420;
    })).toBe(true);
  }
  await expect(section.locator(".ax-prompt")).toContainText("배포 방식 확인 필요");
  const guide = section.getByRole("button", { name: "설치·시작 가이드", exact: true });
  const collapsedGuideBox = await guide.boundingBox();
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "true");
  await expectGuideTutorial(page, section.locator(".ax-guide-panel"), "Claude Code");
  await expectGuideToolbar(section, false);
  const expandedGuideBox = await guide.boundingBox();
  expect(expandedGuideBox!.width).toBeCloseTo(collapsedGuideBox!.width, 1);
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
    const lines = [...new Set(rects.map(rect => rect.y))].map(y => Math.min(...rects.filter(rect => rect.y === y).map(rect => rect.x)));
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
  const size = page.viewportSize()!;
  const screenshotName = `${tool === "Codex" ? "codex" : "claude"}-${size.width}x${size.height}-${test.info().project.name}`;
  const intro = panel.locator(".ax-setup-tutorial");
  await expect(intro.locator(":scope > .ax-tutorial-course")).toHaveCount(3);
  await expect(toc.getByRole("button")).toHaveCount(9);
  expect(await intro.locator(":scope > *").evaluateAll(elements => elements.map(element => element.className))).toEqual([
    "ax-tutorial-intro", "ax-tutorial-toc", "ax-tutorial-context",
    "ax-tutorial-course", "ax-tutorial-course", "ax-tutorial-course",
  ]);
  const context = intro.locator(".ax-tutorial-context");
  await expect(context.locator(":scope > section").first().getByRole("heading", { name: "시작 전 알아두세요" })).toBeVisible();
  await expect(context.getByRole("heading", { name: "처음 시작할 때" })).toBeVisible();
  await expect(context.getByRole("heading", { name: "이후 작업할 때" })).toBeVisible();
  await expect(context).toContainText("STEP 01");
  await expect(context).toContainText("STEP 02");
  await expect(context).toContainText("두 개 다 설치할 필요는 없습니다");
  await expect(context).toContainText("이미 설치되어 있으면 해당 설치는 건너뜁니다");
  await expect(context).not.toContainText("한눈에 보기");
  await expect(context.getByRole("button", { name: /한눈에 보기 자세히 보기/ })).toHaveCount(0);
  const terms = context.locator(".ax-tutorial-glossary");
  const trigger = terms.getByRole("button", { name: "용어 알아보기", exact: true });
  const basics = panel.getByRole("button", { name: /기본 명령/ });
  for (const detail of [trigger, basics]) await expect(detail).toHaveAttribute("aria-expanded", "false");
  await expect(trigger.locator(".lucide-book-open")).toHaveCount(1);
  await expect(trigger.locator(".ax-tutorial-terms-action > span:first-child")).toBeVisible();
  await expect(trigger.locator(".ax-tutorial-terms-action > span:last-child")).toBeHidden();
  await expect(terms.locator("dl")).toBeHidden();

  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger.locator(".ax-tutorial-terms-action > span:last-child")).toBeVisible();
  await expect(terms.locator("dl > div")).toHaveCount(10);
  await expect(terms.locator("dl")).toBeVisible();
  const weights = await terms.locator("dl > div").first().evaluate(row => [
    getComputedStyle(row.querySelector("dt")!).fontWeight, getComputedStyle(row.querySelector("dd")!).fontWeight,
  ]);
  expect(weights).toEqual(["700", "400"]);
  await panel.screenshot({ path: `artifacts/ax/setup-tutorial-terms-expanded-${screenshotName}.png` });
  await expect(basics).toHaveAttribute("aria-expanded", "false");
  await basics.click();
  await expect(basics).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await basics.click();
  await trigger.focus(); await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(terms.locator("dl")).toBeHidden();

  // A selected tool must change the instructions the user can actually execute.
  const install = panel.locator(".ax-guide-code").filter({ hasText: TOOL_GUIDES[tool === "Codex" ? "codex" : "claude"].installCommand });
  await expect(install).toBeVisible();
  await expect(panel.locator(".ax-guide-code").filter({ hasText: TOOL_GUIDES[tool === "Codex" ? "claude" : "codex"].installCommand })).toHaveCount(0);
  const secretStep = panel.locator('.ax-guide-step[data-setup-step="6"]');
  await expect(secretStep.getByText(/실제 Secret 값을 Git뿐 아니라/)).toBeVisible();
  await expect(secretStep.getByText(/이미 노출된 Secret은/)).toBeVisible();

  await expect(secretStep.getByRole("heading", { name: ".gitignore란" })).toHaveCount(0);
  await expect(secretStep.getByRole("button", { name: /^\.gitignore란/ })).toHaveCount(0);
  for (const number of [5, 6, 7]) {
    await toc.getByRole("button", { name: new RegExp(`STEP\\s*0?${number}\\b`) }).click();
    await expect(panel.locator(`.ax-guide-step[data-setup-step="${number}"] > h4`)).toBeFocused();
  }

  for (const number of [9, 3]) {
    await toc.getByRole("button", { name: new RegExp(`STEP\\s*0?${number}\\b`) }).click();
    const heading = panel.locator(`.ax-guide-step[data-setup-step="${number}"] > h4`);
    await expect(heading).toBeFocused();
    // Check the real viewport hit target rather than pinning a scroll offset or CSS value.
    await expect.poll(() => heading.evaluate(element => {
      const box = element.getBoundingClientRect();
      if (box.top < 0 || box.bottom > innerHeight) return false;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && (hit === element || element.contains(hit));
    })).toBe(true);
  }

  await expectActualMarkerGaps(panel);
  const notes = await panel.locator(".ax-guide-code-notes").evaluateAll(elements => elements.flatMap(element => {
    const pre = element.previousElementSibling?.querySelector("pre");
    if (!pre || !element.getBoundingClientRect().width) return [];
    return [...element.querySelectorAll("li")].map(li => {
      const marker = li.querySelector(".ax-guide-marker")!;
      const body = li.querySelector(".ax-guide-text")!;
      const range = document.createRange(); range.selectNodeContents(marker);
      const markerRect = range.getBoundingClientRect();
      range.selectNodeContents(body);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      const lines = [...new Set(rects.map(rect => rect.y))].map(y => Math.min(...rects.filter(rect => rect.y === y).map(rect => rect.x)));
      return { preX: pre.getBoundingClientRect().x, markerX: markerRect.x, gap: lines[0] - markerRect.right, lines };
    });
  }));
  await expect(panel.locator(".ax-guide-code-notes .ax-guide-marker").first()).toBeVisible();
  for (const note of notes) {
    expect(Math.abs(note.markerX - note.preX)).toBeLessThanOrEqual(2);
    expect(note.gap).toBeGreaterThanOrEqual(8); expect(note.gap).toBeLessThanOrEqual(12);
    for (const x of note.lines) expect(Math.abs(x - note.lines[0])).toBeLessThanOrEqual(2);
  }
  if (page.viewportSize()!.width === 390) {
    expect(notes.some(note => note.lines.length > 1)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await panel.screenshot({ path: `artifacts/ax/setup-tutorial-${screenshotName}.png` });
}

async function expectPromptDisclosure(page: Page, section: Locator, tool: "Codex" | "Claude Code", width: number) {
  const prompt = section.locator(".ax-prompt");
  const toggle = section.getByRole("button", { name: "전체 보기", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(prompt).toHaveAttribute("data-expanded", "false");
  const controls = await toggle.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  await expect(prompt).toHaveAttribute("id", controls!);
  expect(await page.locator("[id]").evaluateAll((elements, id) => elements.filter(element => element.id === id).length, controls)).toBe(1);
  const original = (await prompt.textContent())!;
  await expect.poll(async () => {
    const saved = await record(page);
    const task = saved?.tasks.find(item => item.id === saved?.selectedTaskId);
    return tool === "Codex" ? task?.diagnosis?.planCodex : task?.diagnosis?.planClaude;
  }).toBeDefined();
  const beforeState = await record(page);
  await toggle.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
  const copy = section.getByRole("button", { name: `${tool}용 지시문 복사`, exact: true });
  const toggleBox = (await toggle.boundingBox())!, copyBox = (await copy.boundingBox())!;
  const promptBox = (await prompt.boundingBox())!;
  expect(Math.abs(toggleBox.x - promptBox.x)).toBeLessThanOrEqual(1);
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(copyBox.x);
  expect(toggleBox.height).toBeGreaterThanOrEqual(32);
  const outline = await toggle.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopColor, borderWidth: parseFloat(style.borderTopWidth),
      borderStyle: style.borderTopStyle, color: style.color, shadow: style.boxShadow,
      surface: getComputedStyle(element.closest(".ax-surface")!).backgroundColor };
  });
  const primary = await copy.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
  expect(outline.background).toBe(outline.surface);
  expect(outline.background).not.toBe(primary.background);
  expect(outline.color).not.toBe(primary.color);
  expect(outline.borderWidth).toBeGreaterThanOrEqual(1);
  expect(outline.borderStyle).toBe("solid");
  expect(outline.border).not.toBe(outline.background);
  expect(outline.shadow).not.toBe("none");
  const geometry = () => prompt.evaluate(element => ({
    height: element.getBoundingClientRect().height, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY, documentHeight: document.documentElement.scrollHeight,
  }));
  const collapsed = await geometry();
  expect(collapsed.scrollHeight).toBeGreaterThan(collapsed.clientHeight);
  expect(collapsed.overflowY).toBe("hidden");
  await expectCopyUX(page, section, tool);
  await prompt.scrollIntoViewIfNeeded();
  const screenshotName = `${width === 1440 ? "Desktop1440" : "Mobile390"}-${tool === "Codex" ? "codex" : "claude"}-${test.info().project.name}`;
  await page.screenshot({ path: `artifacts/ax/prompt-collapsed-${screenshotName}.png` });
  await toggle.focus(); await page.keyboard.press("Enter");
  const collapse = section.getByRole("button", { name: "전체 접기", exact: true });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(collapse).toHaveAttribute("aria-controls", controls!);
  await expect(collapse).toBeFocused();
  await expect(prompt).toHaveAttribute("data-expanded", "true");
  expect(await prompt.textContent()).toBe(original);
  const expanded = await geometry();
  expect(expanded.height).toBeGreaterThan(collapsed.height + 100);
  expect(expanded.documentHeight - collapsed.documentHeight).toBeGreaterThanOrEqual(expanded.height - collapsed.height - 2);
  expect(expanded.scrollHeight - expanded.clientHeight).toBeLessThanOrEqual(1);
  expect(expanded.overflowY).toBe("visible");
  const finalLine = await prompt.evaluate(element => {
    const text = element.firstChild!;
    const range = document.createRange();
    const lastLine = text.textContent!.lastIndexOf("\n") + 1;
    range.setStart(text, lastLine); range.setEnd(text, text.textContent!.length);
    const rect = range.getBoundingClientRect(), parent = element.getBoundingClientRect();
    return { top: rect.top - parent.top, bottom: rect.bottom - parent.top, height: parent.height };
  });
  expect(finalLine.top).toBeGreaterThan(collapsed.height);
  expect(finalLine.bottom).toBeLessThanOrEqual(finalLine.height);
  await expectCopyUX(page, section, tool);
  expect(await record(page)).toEqual(beforeState);
  await prompt.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `artifacts/ax/prompt-expanded-${screenshotName}.png`, fullPage: true });
  await collapse.focus(); await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(prompt).toHaveAttribute("data-expanded", "false");
  expect(await prompt.textContent()).toBe(original);
  expect((await geometry()).height).toBeCloseTo(collapsed.height, 1);
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
    const scope = section.getByRole("region", { name: "01 구현 범위", exact: true });
    const before = section.getByRole("region", { name: "02 시작 전 확인", exact: true });
    const done = section.getByRole("region", { name: "03 완료 기준", exact: true });
    await expect(section.locator(".ax-plan-head")).toContainText(task.name);
    await expect(scope).toContainText("담당자 승인");
    await expect(before).toContainText("샘플 표");
    await expect(done).toContainText("실패: 누락 발생");
    for (const [tool, target, plan, other] of [["Codex", "codex", codex, claude], ["Claude Code", "claude", claude, codex]] as const) {
      if (target === "claude") await section.getByRole("tab", { name: tool, exact: true }).click();
      await section.getByRole("button", { name: `${tool}용 구현 계획 생성`, exact: true }).click();
      await expect(scope).toContainText(plan.goal[0]);
      await expect(scope).not.toContainText(other.goal[0]);
      await expect(before).toContainText(plan.toBe[0]);
      await expect(done).toContainText(plan.tests[9]);
      const raw = buildAllInOnePrompt(plan, target, { taskName: task.name, prerequisites: ["시스템 접근 — API와 권한 실제 확인", "권한 확인 후 진행"], diagnosis: diagnosisFixture, context: task.description });
      await expect(section.locator(".ax-prompt")).toHaveText(raw);
      await expectPromptDisclosure(page, section, tool, width);
      if (browserName === "chromium") {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
        await section.getByRole("button", { name: `${tool}용 지시문 복사`, exact: true }).click();
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
    await expect(scope).toContainText(codex.goal[0]);
    await expect(scope).not.toContainText(claude.goal[0]);
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
      const scope = section.getByRole("region", { name: "01 구현 범위", exact: true });
      const before = section.getByRole("region", { name: "02 시작 전 확인", exact: true });
      const done = section.getByRole("region", { name: "03 완료 기준", exact: true });
      await expect(section.locator(".ax-plan-head")).toContainText(`Level ${level}`);
      await expect(section.locator(".ax-plan-head")).toContainText(gate === "ready" ? "진행 가능" : gate === "blocked" ? "진행 보류" : "확인 후 진행");
      await expect(section.locator(".ax-plan-head")).toContainText(task.name);
      await expect(scope).toContainText("담당자 승인");
      await expect(done).toContainText("실패: 누락 발생");
      if (gate === "blocked") {
        await expect(before).toContainText("보안 정책상 자료 반출 불가");
        await expect(section.getByRole("status")).toContainText("구현 계획을 생성할 수 없습니다.");
        await expect(section.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeDisabled();
      } else {
        await expect(section.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
        if (gate === "ready") await expect(before).toContainText("시스템 접근 — API 확인");
        if (gate === "conditional") await expect(before).toContainText("시스템 접근 — API와 권한 실제 확인");
      }
      if (level === 0) {
        await expect(scope).toContainText("허용된 준비·검증");
        await expect(scope).toContainText("자동화 판정 단계 · 현 상태에서 자동 실행 제외");
        await expect(scope).toContainText("AI 보조 판정 단계 · 현 상태에서 구현 제외");
        await expect(scope).toContainText("샘플 데이터 형식·필수 항목 확인");
      }
      if (level <= 1) await expect(scope).toContainText("운영 자동화 적용");
      await expect(section.getByRole("region", { name: "04 코딩 에이전트 지시문", exact: true })).toBeVisible();
    });
  }
}

test("AX separates confirmed technical checks from unresolved conditional prerequisites", async ({ page }) => {
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
  const before = page.getByRole("region", { name: "02 시작 전 확인", exact: true });
  await expect(before.getByRole("heading", { name: "확인된 기술 항목", exact: true })).toBeVisible();
  await expect(before).toContainText("샘플 파일 — 헤더와 실제 행 확인");
  await expect(before).toContainText("연동 인증 — 관리자에게 접근 권한 확인");
  await expect(before).toContainText("권한 확인 후 진행");
  await expect(before.locator(".ax-plan-group").filter({ has: page.getByRole("heading", { name: "확인된 기술 항목", exact: true }) })).not.toContainText("연동 인증");
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
  const scope = section.getByRole("region", { name: "01 구현 범위", exact: true });
  await expect(section.locator(".ax-plan-head")).toContainText("Level 0");
  const permitted = scope.locator(".ax-plan-group").filter({ has: page.getByRole("heading", { name: "허용된 준비·검증", exact: true }) });
  await expect(permitted).toContainText("샘플 데이터 형식·필수 항목 확인");
  await expect(permitted).not.toContainText("취합");
  await expect(scope).toContainText("생성 계획의 포함 제안 · 현재 구현 범위 아님");
  await expect(section.locator(".ax-prompt")).toContainText("업무 정리와 보조 도구 수준으로 구현하세요.");
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
  const before = plan.getByRole("region", { name: "02 시작 전 확인", exact: true });
  const done = plan.getByRole("region", { name: "03 완료 기준", exact: true });
  await expect(before).toContainText("월말 연동 접근 — 청구 원본의 읽기 권한을 관리자에게 확인");
  for (const item of [...diagnosis.asIs.exceptions, ...diagnosis.risks, ...diagnosis.poc.evaluation]) await expect(done).toContainText(item);
  await expect(done).toContainText("성공: 거래별 차이가 없고 담당자가 검토 완료");
  await expect(done).toContainText("실패: 하나라도 원본 거래가 사라지면 적용 중지");
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
      for (const label of ["PowerShell 명령", ".gitignore 예시"]) {
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
        await block.screenshot({ path: `artifacts/ax/guide-copy-${width}-${tool === "Codex" ? "codex" : "claude"}-${label === "PowerShell 명령" ? "ps" : "ignore"}-${test.info().project.name}.png` });
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
    for (const [index, task] of tasks.entries()) {
      await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true }).getByRole("listitem").filter({ hasText: task.name }).locator(".ax-rank")).toHaveText(`#${index + 1}`);
    }
    await page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: new RegExp(last.name) }).click();
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(last.id);
    await expect(page.locator(".ax-step3-main > section").last().getByRole("heading").first()).toContainText(last.name);
    const matrixBadge = await badgeStyle(page.locator('.ax-gate-cond[data-gate="conditional"]').first());
    expect(await badgeStyle(page.locator('.ax-gate-badge[data-gate="conditional"]'))).toEqual(matrixBadge);
    await page.locator(".ax-matrix-surface").screenshot({ path: `artifacts/ax/multi-matrix-${count}-${width}-${test.info().project.name}.png` });
    await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
    await expect(page.locator(".ax-roadmap-task")).toHaveText(last.name);
    await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText(`${count}개`);
    await expect(page.locator(".ax-kpi").filter({ hasText: "진단 완료" }).locator("strong")).toHaveText(`${count}개`);
    await expect(page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true }).locator(".ax-rank")).toHaveText(tasks.slice(0, 3).map((_, index) => `#${index + 1}`));
    expect(await badgeStyle(page.locator('.ax-gate-cond[data-gate="conditional"]').first())).toEqual(matrixBadge);
    const all = page.getByRole("button", { name: "전체 업무 보기", exact: true });
    if (count > 3) {
      await expect(all).toHaveAttribute("aria-expanded", "false");
      await all.click(); await expect(all).toHaveAttribute("aria-expanded", "true");
      const full = page.getByRole("list", { name: "전체 진단 업무 목록", exact: true });
      await expect(full.locator(".ax-rank")).toHaveText(tasks.map((_, index) => `#${index + 1}`));
      await full.getByRole("button", { name: new RegExp(last.name) }).click();
      await expect(page.locator(".ax-detail-stack > section > h2")).toHaveText(last.name);
      await expect(page.locator(".ax-roadmap-task")).toHaveText(last.name);
      await full.getByRole("button", { name: new RegExp(tasks[0].name) }).click();
      await expect(page.locator(".ax-roadmap-task")).toHaveText(tasks[0].name);
      await expect(page.locator(".ax-all-task-list")).toBeVisible();
    } else await expect(all).toHaveCount(0);
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
    await expect(page.locator(".ax-step3-main > section").last().getByRole("heading").first()).toContainText(diagnosed.name);
  } else {
    await expect(page.locator(".ax-roadmap-task")).toHaveText(diagnosed.name);
    await expect(page.locator(".ax-detail-stack > section > h2")).toHaveText(diagnosed.name);
  }
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await page.getByLabel("등록 업무 목록").locator("li").filter({ hasText: diagnosed.name }).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("tab", { name: step === 3 ? "자동화 매트릭스" : "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-empty")).toBeVisible();
  await expect(page.locator(".ax-bubble, .ax-detail-stack, .ax-prompt")).toHaveCount(0);
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
  await expect(panel.locator(".ax-score-extra-list strong")).toHaveText(["2점", "2점"]);
  const details = panel.locator(".ax-score-details");
  const factorToggle = details.getByRole("button", { name: "평가 근거 자세히 보기", exact: true });
  await expect(factorToggle).toHaveAttribute("aria-expanded", "false");
  await factorToggle.focus(); await factorToggle.press("Enter");
  const factorCollapse = details.getByRole("button", { name: "평가 근거 접기", exact: true });
  await expect(factorCollapse).toHaveAttribute("aria-expanded", "true");
  const factorPanelId = await factorCollapse.getAttribute("aria-controls");
  await expect(details.locator(`[id="${factorPanelId}"]`)).toBeVisible();
  await factorCollapse.press("Space");
  await expect(factorToggle).toHaveAttribute("aria-expanded", "false");
  await factorToggle.locator("svg").click();
  await expect(factorCollapse).toHaveAttribute("aria-expanded", "true");
  await expect(details.locator(".ax-score-factor")).toHaveCount(6);
  await expect(details.locator(".ax-score-factor").filter({ hasText: "반복성" })).toContainText("최종 적용 5점");
  await expect(details).toContainText("AI 제안 4점"); await expect(details).toContainText("확인 필요");
  await expect(panel).not.toContainText("TO-BE");
  const axisStyles = await page.locator(".ax-x-label, .ax-y-label").evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element); return [style.padding, style.font, style.border, style.borderRadius, style.boxShadow, style.backgroundColor];
  }));
  expect(axisStyles[0]).toEqual(axisStyles[1]);
  await panel.screenshot({ path: `artifacts/ax/score-evidence-${width}-${test.info().project.name}.png` });
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  for (const label of ["반복성", "규칙성", "데이터 구조화", "시스템 접근성"]) await page.getByRole("button", { name: `${label} 1점`, exact: true }).click();
  await expect.poll(async () => (await record(page))?.tasks[0].diagnosis?.planCodex).toBeUndefined();
  expect((await record(page))?.tasks[1].diagnosis?.planClaude).toEqual(planFixture);
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${tasks[0].name} ·`) }));
  await expect(marker).toHaveAttribute("aria-label", new RegExp(`^${tasks[0].name} ·`));
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  expect(await marker.evaluate(element => ({ x: (element as HTMLElement).style.left, y: (element as HTMLElement).style.bottom }))).toEqual({ x: "0%", y: "0%" });
  await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true }).locator(".ax-rank")).toHaveText(["#1", "#2"]);
  await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true }).locator(".ax-task-name")).toHaveText([tasks[1].name, tasks[0].name]);
  await evidence.click(); await expect(panel.locator(".ax-score-result strong")).toHaveText(["1", "1"]);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true }).locator(".ax-task-name")).toHaveText([tasks[1].name, tasks[0].name]);
  await expect(page.locator(".ax-roadmap-task")).toHaveText(tasks[0].name);
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
    await expect(page.locator(".ax-factor-row")).toHaveCount(6);
  }
  await page.getByLabel("등록 업무 목록").getByRole("button", { name: /^E/ }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: /^1\. A/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: /B/ }).click();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-roadmap-task")).toHaveText("B");
  await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-kpi").filter({ hasText: "진단 완료" }).locator("strong")).toHaveText("3개");
  await expect(page.getByRole("button", { name: "전체 업무 보기", exact: true })).toHaveCount(0);
  const top = page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true });
  const plans = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  for (const name of ["A", "B"]) {
    await top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${name}$`) }) }).getByRole("button").click();
    await expect(plans.locator(".ax-plan-head")).toContainText(name);
    const scope = plans.getByRole("region", { name: "01 구현 범위", exact: true });
    await expect(scope).not.toContainText(`${name === "A" ? "B" : "A"}-codex-독립 구현`);
    for (const tool of ["Codex", "Claude Code"]) {
      if (tool === "Claude Code") await plans.getByRole("tab", { name: tool, exact: true }).click();
      await plans.getByRole("button", { name: `${tool}용 구현 계획 생성`, exact: true }).click();
      await expect(plans.locator(".ax-prompt")).toContainText(`${name}-${tool === "Codex" ? "codex" : "claude"}-독립 구현`);
      await expect(plans.locator(".ax-prompt")).toContainText(`# ${name} 자동화 구현 지시문`);
      await expect(scope).toContainText(`${name}-${tool === "Codex" ? "codex" : "claude"}-독립 구현`);
      await expect(scope).not.toContainText(`${name}-${tool === "Codex" ? "claude" : "codex"}-독립 구현`);
    }
    await plans.getByRole("button", { name: "전체 보기", exact: true }).click();
  }
  await top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: /^C$/ }) }).getByRole("button").click();
  await expect(plans.locator(".ax-plan-head")).toContainText("C");
  await expect(plans.locator(".ax-plan-view")).not.toContainText("B-claude-독립 구현");
  await expect(plans.locator(".ax-prompt")).toHaveCount(0);
  await expect(plans.getByRole("button", { name: "전체 보기", exact: true })).toHaveCount(0);
  await plans.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(plans.locator(".ax-prompt")).toContainText("C-codex-독립 구현");
  await expect(plans.locator(".ax-prompt")).not.toContainText("A-codex-독립 구현");
  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await plans.getByRole("button", { name: "Codex용 지시문 복사", exact: true }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe((await plans.locator(".ax-prompt").textContent())!.replace(/\r\n/g, "\n"));
  }
  for (const name of ["A", "B"]) for (const [tool, target] of [["Codex", "codex"], ["Claude Code", "claude"]]) {
    await top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${name}$`) }) }).getByRole("button").click();
    await plans.getByRole("tab", { name: tool, exact: true }).click();
    await expect(plans.locator(".ax-prompt")).toContainText(`${name}-${target}-독립 구현`);
    await expect(plans.locator(".ax-prompt")).not.toContainText("C-codex-독립 구현");
    await expect(plans.locator(".ax-plan-head")).toContainText(name);
    await expect(plans.getByRole("region", { name: "01 구현 범위", exact: true })).toContainText(`${name}-${target}-독립 구현`);
    await expect(plans.getByRole("button", { name: "전체 보기", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(plans.getByRole("button", { name: `${tool}용 지시문 복사`, exact: true })).not.toHaveAttribute("data-copied", "true");
  }
  expect(calls.filter(call => call.kind === "ax-diagnosis")).toHaveLength(3);
  await expect.poll(async () => { const saved = await record(page); return saved?.tasks.find(task => task.id === saved.selectedTaskId)?.name; }).toBe("B");
  expect(calls.filter(call => call.kind === "ax-plan")).toHaveLength(5);
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
  await expect(page.locator(".ax-kpi").filter({ hasText: "진단 완료" }).locator("strong")).toHaveText("3개");
});
