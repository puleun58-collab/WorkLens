import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxState } from "../../src/lib/ax/types";
import { TOOL_GUIDES } from "../../src/lib/ax/guide";
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
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await prompt.textContent());
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
  await expect(page.locator(".ax-data-actions .ax-utility-message")).toHaveText("업무 진단을 완료했습니다. 필요한 경우 점수를 조정하세요.");
  const utility = await page.evaluate(() => { const message = document.querySelector(".ax-utility-message")!.getBoundingClientRect(), menu = document.querySelector('[aria-label="AI•AX 데이터 작업"]')!.getBoundingClientRect(), steps = document.querySelector(".ax-steps")!.getBoundingClientRect(); return { overlap: message.top < menu.bottom && message.bottom > menu.top, above: message.bottom <= steps.top && menu.bottom <= steps.top }; });
  expect(utility).toEqual({ overlap: true, above: true });
  await expect(page.locator(".ax-radar text").filter({ hasText: "필요도" })).toHaveCount(1);
  expect(await page.locator(".ax-radar text").evaluateAll(texts => texts.map(text => [...text.querySelectorAll("tspan")].map(span => span.textContent)))).toEqual([["반복성"], ["규칙성"], ["데이터", "구조화"], ["시스템", "접근성"], ["담당자 판단", "필요도"], ["운영", "위험"]]);
  await page.screenshot({ path: `artifacts/ax/diagnosis-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await expect(page.getByText("사용자 보정 완료", { exact: true }).last()).toBeVisible();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: false }).click();
  await expect(page.getByLabel("매트릭스 업무 목록")).toContainText("가치 3 · 실현 4");
  await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true })).toContainText("검토 후보");
  await expect(page.getByRole("list", { name: "자동화 우선순위 목록", exact: true })).toContainText("자동화 가치 3");
  const matrix = await page.evaluate(() => {
    const header = document.querySelector(".ax-matrix-header")!.getBoundingClientRect(), chart = document.querySelector(".ax-matrix")!.getBoundingClientRect();
    const origin = document.querySelector(".ax-x-tick.is-origin")!.getBoundingClientRect();
    return { gap: chart.top - header.bottom, y: [...document.querySelectorAll(".ax-y-tick")].map(t => t.textContent), x: [...document.querySelectorAll(".ax-x-tick")].map(t => t.textContent), originLeftOfChart: origin.right <= chart.left + 1, originBelowChart: (origin.top + origin.bottom) / 2 >= chart.bottom };
  });
  expect(matrix.y).toEqual(["", "2", "3", "4", "5"]);
  expect(matrix.x).toEqual(["1", "2", "3", "4", "5"]);
  expect(matrix.gap).toBeLessThanOrEqual(32);
  expect(matrix.originLeftOfChart && matrix.originBelowChart).toBe(true);
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
  await expect(packageSection.locator(".ax-gate-badge")).toHaveCount(0);
  await expect(packageSection.getByText("조건부 진행", { exact: true })).toHaveCount(0);
  await expect(packageSection.getByText("먼저 확인할 사항", { exact: false })).toHaveCount(0);
  await expect(packageSection.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
  await expect(packageSection.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeEnabled();
  await expect(packageSection.locator(".ax-plan-tool-hint")).toHaveCount(0);
  await expect(packageSection.getByRole("button", { name: "설치·시작 가이드", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codex용 지시문 복사", exact: true })).toBeVisible();
  const head = packageSection.locator(".ax-plan-head");
  await expect(head.getByRole("heading", { name: "자동화 구현 계획", exact: true })).toBeVisible();
  await expect(head.locator(".ax-plan-tool-hint")).toHaveText("Codex에서 현재 프로젝트를 열고 아래 지시문을 붙여넣으세요.");
  const titleBox = await head.getByRole("heading").boundingBox(), hintBox = await head.locator(".ax-plan-tool-hint").boundingBox();
  if (page.viewportSize()!.width >= 1024) expect(hintBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width);
  for (const text of ["AI가 현재 프로젝트를 확인한 뒤 작업합니다.", "AI가 현재 프로젝트의 구조와 설정을 먼저 확인한 뒤 작업합니다."]) await expect(packageSection.getByText(text, { exact: false })).toHaveCount(0);
  const prompt = packageSection.locator(".ax-prompt");
  for (const heading of ["# 월간 취합 자동화 구현 지시문", "## 2. 현재 진단 기준", "## 3. 작업 전 현재 프로젝트 확인", "## 4. AS-IS", "## 8. 구현 원칙", "## 9. 구현 요구사항", "## 15. Git 반영", "## 16. 배포 및 운영 적용", "## 17. 완료 조건", "## 18. 완료 보고"]) await expect(prompt).toContainText(heading);
  await expectPromptStructure(prompt, "월간 취합");
  const codexPrompt = await prompt.textContent();
  const prerequisites = (await prompt.textContent())!.split("## 7. 구현 전 확인사항")[1].split("## 8.")[0];
  expect(prerequisites).toContain("실제 저장소와 API 확인");
  expect(prerequisites).toContain("시스템 접근 — API와 권한 실제 확인");
  expect(prerequisites).toContain("권한 확인 후 진행");
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
  await expect(guidePanel.locator(".ax-guide-step > h4")).toHaveText(["STEP 0 · 개발 환경 준비", "STEP 1 · 프로젝트 준비", "STEP 2 · 도구 실행"]);
  await expect(guidePanel.locator(".ax-guide-section > h5").filter({ hasText: /^[ABC]\. / })).toHaveText(["A. GitHub에 있는 기존 프로젝트", "B. PC에 이미 있는 프로젝트", "C. 새 프로젝트"]);
  await expect(guidePanel.locator(".ax-guide-code").first()).toContainText("git --version");
  const guideStyle = await guidePanel.evaluate(element => {
    const body = element.querySelector(".ax-guide-section > p")!, step = element.querySelector(".ax-guide-step > h4")!, code = element.querySelector(".ax-guide-code")!;
    return { align: getComputedStyle(element).textAlign, body: parseFloat(getComputedStyle(body).fontSize), step: parseFloat(getComputedStyle(step).fontSize), code: parseFloat(getComputedStyle(code).fontSize), color: getComputedStyle(body).color, muted: getComputedStyle(element.querySelector(".ax-guide-when")!).color };
  });
  expect(guideStyle.align).toBe("left");
  expect(guideStyle.step).toBeGreaterThan(guideStyle.body);
  expect(guideStyle.code).toBeGreaterThanOrEqual(13);
  expect(guideStyle.color).not.toBe(guideStyle.muted);
  await expect(packageSection.locator(".ax-guide-panel")).toContainText(TOOL_GUIDES.codex.installCommand);
  await expect(packageSection.locator(".ax-guide-panel")).toContainText(TOOL_GUIDES.codex.doctorCommand);
  await expect(packageSection.locator(".ax-guide-panel")).not.toContainText(TOOL_GUIDES.claude.installCommand);
  await expectGuideToolbar(packageSection, page.viewportSize()!.width >= 1024);
  const expandedGuideBox = await guide.boundingBox();
  expect(expandedGuideBox!.width).toBeCloseTo(collapsedGuideBox!.width, 1);
  const toolbarBox = await packageSection.locator(".ax-plan-toolbar").boundingBox();
  const panelBox = await packageSection.locator('[data-slot="accordion-panel"]').boundingBox();
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
  await expect(packageSection.locator(".ax-guide-panel")).toContainText(TOOL_GUIDES.claude.installCommand);
  await expect(packageSection.locator(".ax-guide-panel")).toContainText(TOOL_GUIDES.claude.doctorCommand);
  await expect(packageSection.locator(".ax-guide-panel")).not.toContainText(TOOL_GUIDES.codex.installCommand);
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
  await expect(page.getByRole("tabpanel")).toContainText("재분석 시 다시 첨부");
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
  await expect(page.getByText("핵심 확인사항 먼저 확인", { exact: true })).toBeVisible();
  await expect(page.locator(".ax-summary")).toContainText("잠정");
  await page.getByLabel("최종 승인자는 누구인가요?", { exact: true }).fill("업무 담당 팀장");
  const rediagnose = page.getByRole("button", { name: "답변 반영 후 재진단", exact: true });
  await expect(rediagnose).toHaveAttribute("data-slot", "button"); await expect(rediagnose).toHaveClass(/bg-primary/);
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
  await expect(page.locator(".ax-gate-line")).toContainText("보류 사유:");
  await tasks.getByRole("button", { name: "가능 업무", exact: false }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.locator('.ax-gate-badge[data-gate="ready"]')).toHaveText("진행 가능");
  await expect(page.locator(".ax-gate-line")).not.toContainText("먼저 확인");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  const top = page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true });
  await expect(top.locator("li .ax-task-name")).toHaveText(["가능 업무", "차단 업무"]);
  const blocked = top.getByRole("listitem").filter({ hasText: "차단 업무" });
  const ready = top.getByRole("listitem").filter({ hasText: "가능 업무" });
  await expect(blocked).toContainText("점수 12.5");
  await expect(ready).toContainText("점수 9");
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
  await expect(plans.getByText("두 번째 보류 사유", { exact: true })).toHaveCount(0);
  await expect(plans.getByRole("list")).toHaveCount(0);
  await expect(plans.locator(".ax-gate-badge")).toHaveCount(0);
  await expect(plans.locator(".ax-prompt")).toHaveCount(0);
  await expect(plans.locator(".ax-plan-tool-hint")).toHaveCount(0);
  await expect(plans.getByRole("button", { name: /용 지시문 복사$/ })).toHaveCount(0);
  await expect(plans.getByRole("button", { name: "설치·시작 가이드", exact: false })).toHaveCount(0);
  await expect(plans.getByRole("heading", { name: "먼저 확인할 사항", exact: true })).toHaveCount(0);
  await ready.getByRole("button").click();
  await expect(plans.locator(".ax-gate-badge")).toHaveCount(0);
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
  await expect(section.locator(".ax-gate-badge")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "운영 시 참고사항", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "자동화 적용 범위", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "담당자 수행", exact: true })).toBeVisible();
  for (const [tool, copy] of [["Codex", "Codex용 지시문 복사"], ["Claude Code", "Claude Code용 지시문 복사"]]) {
    await section.getByRole("tab", { name: tool, exact: true }).click();
    const hint = section.locator(".ax-plan-head .ax-plan-tool-hint");
    await expect(hint).toHaveText(`${tool}에서 현재 프로젝트를 열고 아래 지시문을 붙여넣으세요.`);
    const headingBox = await section.locator(".ax-plan-head h3").boundingBox(), hintBox = await hint.boundingBox();
    expect(hintBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height);
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
  await expect(section.locator(".ax-guide-panel")).toContainText(TOOL_GUIDES.claude.doctorCommand);
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
