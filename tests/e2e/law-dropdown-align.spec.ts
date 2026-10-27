import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";

/**
 * 법령 드롭다운 위치 일관성 (law-dropdown-align):
 * alignItemWithTrigger 기본값(true)에서는 선택 항목이 트리거에 맞춰 정렬돼
 * 메뉴 시작 위치가 선택값마다 위아래로 달라진다. 수정 후에는 어떤 항목을
 * 선택해도 메뉴가 선택창 바로 아래, 왼쪽 경계 일치 위치에서 시작해야 한다.
 * 핵심 불변식: (1) 메뉴 top은 트리거 bottom + sideOffset(4px) 부근으로 일정
 * (2) 메뉴 left는 트리거 left와 일치 (3) 메뉴 너비는 트리거 너비 수준.
 */

async function openPopup(page: Page, triggerId: string) {
  await page.locator(`#${triggerId}`).click();
  await expect(page.getByRole("listbox")).toBeVisible();
}

async function measure(page: Page, triggerId: string) {
  const trigger = await page.locator(`#${triggerId}`).boundingBox();
  const popup = await page.locator('[data-slot="select-popup"]:visible').boundingBox();
  expect(trigger).not.toBeNull();
  expect(popup).not.toBeNull();
  return { trigger: trigger!, popup: popup! };
}

function expectAnchored(m: { trigger: { x: number; y: number; width: number; height: number }; popup: { x: number; y: number; width: number; height: number } }) {
  // 메뉴가 선택창 바로 아래에서 시작하고 왼쪽 경계가 일치한다.
  expect(m.popup.y - (m.trigger.y + m.trigger.height)).toBeGreaterThanOrEqual(-1);
  expect(m.popup.y - (m.trigger.y + m.trigger.height)).toBeLessThanOrEqual(12);
  expect(Math.abs(m.popup.x - m.trigger.x)).toBeLessThanOrEqual(2);
  // 메뉴 너비는 선택창 수준(불필요하게 넓어지지 않음).
  expect(m.popup.width).toBeGreaterThanOrEqual(m.trigger.width - 2);
  expect(m.popup.width).toBeLessThanOrEqual(m.trigger.width + 80);
}

async function selectAndMeasure(page: Page, triggerId: string, optionLabel: string) {
  await openPopup(page, triggerId);
  const before = await measure(page, triggerId);
  expectAnchored(before);
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator(`#${triggerId}`)).toContainText(optionLabel);
  await openPopup(page, triggerId);
  const after = await measure(page, triggerId);
  expectAnchored(after);
  // 측정용으로 연 팝업은 닫고 반환한다(열린 채로 다음 트리거를 클릭하면
  // Base UI의 inert 백드롭이 가로막아 클릭이 실패한다).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  return { before, after };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await navigateWorkspace(page, "법령");
});

test("리서치 유형: 첫·중간·마지막 선택에도 메뉴 시작 위치가 일정하다", async ({ page }) => {
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const first = await selectAndMeasure(page, "research-task", "통합 조사");
  await page.keyboard.press("Escape");
  const middle = await selectAndMeasure(page, "research-task", "개정 추적");
  await page.keyboard.press("Escape");
  const last = await selectAndMeasure(page, "research-task", "문서 검토");
  // 선택값과 무관하게 메뉴 top이 동일하다(위치 변동 없음).
  expect(Math.abs(first.after.popup.y - middle.after.popup.y)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(middle.after.popup.y - last.after.popup.y)).toBeLessThanOrEqual(1.5);
});

test("분야·추적 방식: 선택값과 무관하게 메뉴가 선택창 아래에서 시작한다", async ({ page }) => {
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  await selectAndMeasure(page, "research-task", "분쟁·불복 자료");
  await page.keyboard.press("Escape");
  const domainFirst = await selectAndMeasure(page, "research-domain", "자동/일반");
  await page.keyboard.press("Escape");
  const domainLast = await selectAndMeasure(page, "research-domain", "공정거래");
  expect(Math.abs(domainFirst.after.popup.y - domainLast.after.popup.y)).toBeLessThanOrEqual(1.5);

  await selectAndMeasure(page, "research-task", "개정 추적");
  await page.keyboard.press("Escape");
  const scenarioFirst = await selectAndMeasure(page, "research-scenario", "자동");
  await page.keyboard.press("Escape");
  const scenarioLast = await selectAndMeasure(page, "research-scenario", "시점 비교");
  expect(Math.abs(scenarioFirst.after.popup.y - scenarioLast.after.popup.y)).toBeLessThanOrEqual(1.5);
});

test("자료 유형: 13개 항목에서 선택값과 무관하게 메뉴 위치가 일정하고 내부 스크롤이 동작한다", async ({ page }) => {
  await page.getByRole("tab", { name: "판례·결정례", exact: true }).click();
  const first = await selectAndMeasure(page, "decision-domain", "판례");
  await page.keyboard.press("Escape");
  const middle = await selectAndMeasure(page, "decision-domain", "국세청 법령해석");
  await page.keyboard.press("Escape");
  const last = await selectAndMeasure(page, "decision-domain", "권익위 특별행정심판");
  expect(Math.abs(first.after.popup.y - middle.after.popup.y)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(middle.after.popup.y - last.after.popup.y)).toBeLessThanOrEqual(1.5);

  // 작은 뷰포트에서 항목이 많은 메뉴는 내부 스크롤로 동작한다.
  await page.setViewportSize({ width: 1440, height: 500 });
  await openPopup(page, "decision-domain");
  const list = page.locator('[data-slot="select-list"]:visible');
  await expect(list).toBeVisible();
  const scroll = await list.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(scroll.overflowY).toBe("auto");
  expect(scroll.scrollHeight).toBeGreaterThanOrEqual(scroll.clientHeight);
  if (scroll.scrollHeight > scroll.clientHeight) {
    await list.evaluate((element) => { element.scrollTop = 100; });
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("키보드: Enter로 열고 방향키·Enter로 선택하고 Escape로 닫는다", async ({ page }) => {
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const trigger = page.locator("#research-task");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).not.toContainText("통합 조사");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("공간이 부족한 낮은 뷰포트에서도 메뉴가 화면을 벗어나지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 400 });
  await page.getByRole("tab", { name: "판례·결정례", exact: true }).click();
  await openPopup(page, "decision-domain");
  const m = await measure(page, "decision-domain");
  // 아래 공간이 부족하면 위로 열리거나 높이가 제한되어, 어느 쪽이든
  // 메뉴가 뷰포트 아래로 삐져나가지 않는다.
  expect(m.popup.y).toBeGreaterThanOrEqual(-1);
  expect(m.popup.y + m.popup.height).toBeLessThanOrEqual(401);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("모바일 390px: 리서치 유형 메뉴가 선택창 아래에서 시작하고 화면을 벗어나지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "종합 리서치", exact: true }).click();
  const first = await selectAndMeasure(page, "research-task", "통합 조사");
  await page.keyboard.press("Escape");
  const last = await selectAndMeasure(page, "research-task", "문서 검토");
  expect(Math.abs(first.after.popup.y - last.after.popup.y)).toBeLessThanOrEqual(1.5);
  expect(last.after.popup.x).toBeGreaterThanOrEqual(-1);
  expect(last.after.popup.x + last.after.popup.width).toBeLessThanOrEqual(391);
});
