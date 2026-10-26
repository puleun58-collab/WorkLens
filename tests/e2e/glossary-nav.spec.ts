import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";

async function seedAx(page: Page, value: unknown) {
  await page.evaluate(async (record) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(record, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, value);
}

test("review menu is a single item and the header glossary button shows only on review screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true });
  const reviewButton = nav.getByRole("button", { name: "검수", exact: true });
  const headerGlossary = page.getByRole("button", { name: "용어 사전", exact: true });

  // 좌측 메뉴: 검수는 단일 메뉴이고, 접기·펼치기 화살표와 하위 메뉴가 없다.
  await expect(reviewButton).toBeVisible();
  await expect(nav.locator(".workspace-nav-toggle")).toHaveCount(0);
  await expect(nav.locator(".workspace-nav-children")).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "문서 검수", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "용어 사전", exact: true })).toHaveCount(0);
  // HELP 하단에는 사용 가이드·설정만 있고, 용어 사전은 HELP로 돌아가지 않는다.
  // (HELP 항목의 접근 이름은 ariaLabel인 Guide/Settings이다.)
  await expect(nav.getByRole("button", { name: "Guide", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  // 검수 메뉴는 다른 단일 메뉴와 같은 크기이다.
  const reviewBox = await reviewButton.boundingBox();
  const analyzeBox = await nav.getByRole("button", { name: "분석", exact: true }).boundingBox();
  expect(reviewBox!.height).toBe(analyzeBox!.height);

  // 다른 카테고리에서는 상단 용어 사전 버튼이 표시되지 않는다.
  await expect(headerGlossary).toHaveCount(0);

  // 검수 클릭 시 기존 검수 화면으로 이동하고, 헤더에 용어 사전 버튼이 나타난다.
  await reviewButton.click();
  await expect(reviewButton).toHaveAttribute("aria-current", "page");
  await expect(headerGlossary).toBeVisible();
  await expect(headerGlossary).not.toHaveAttribute("aria-current", "page");
  // 버튼은 검색창 바로 왼쪽에 있고, 콘텐츠 영역에 중복 버튼이 없다.
  const searchInput = page.getByRole("combobox", { name: "메뉴·기능 검색" });
  await expect(searchInput).toBeVisible();
  const [glossaryBox, searchBox] = await Promise.all([headerGlossary.boundingBox(), searchInput.boundingBox()]);
  expect(glossaryBox!.x + glossaryBox!.width).toBeLessThanOrEqual(searchBox!.x);
  expect(searchBox!.x - (glossaryBox!.x + glossaryBox!.width)).toBeLessThanOrEqual(40);
  await expect(page.getByRole("button", { name: "용어 사전", exact: true })).toHaveCount(1);

  // 헤더 버튼 클릭 시 기존 용어 사전 화면으로 이동하고, 검수 메뉴가 활성 표시된다.
  await headerGlossary.click();
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first()).toBeVisible();
  await expect(reviewButton).toHaveAttribute("aria-current", "page");
  await expect(headerGlossary).toHaveAttribute("aria-current", "page");
  expect(await headerGlossary.evaluate((element) => element.classList.contains("active"))).toBe(true);

  // 용어 사전 화면에서 동일 버튼을 다시 클릭해도 화면이 바뀌거나 초기화되지 않는다.
  await headerGlossary.click();
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first()).toBeVisible();
  await expect(headerGlossary).toHaveAttribute("aria-current", "page");

  // 좌측 검수 메뉴 클릭 시 문서 검수 화면으로 돌아간다.
  await reviewButton.click();
  await expect(headerGlossary).toBeVisible();
  await expect(headerGlossary).not.toHaveAttribute("aria-current", "page");

  // 다른 카테고리로 이동하면 버튼이 사라지고, 검수로 돌아오면 다시 나타난다.
  await navigateWorkspace(page, "분석");
  await expect(headerGlossary).toHaveCount(0);
  await expect(searchInput).toBeVisible();
  await navigateWorkspace(page, "검수");
  await expect(headerGlossary).toBeVisible();

  // 메뉴 검색에서 용어 사전은 검수 소속으로 표시되고, 선택 시 용어 사전 화면으로 이동한다.
  await page.keyboard.press("Control+K");
  await searchInput.fill("용어 사전");
  const option = page.getByRole("option", { name: "용어 사전", exact: true });
  await expect(option).toBeVisible();
  await expect(page.locator(".workspace-search-results")).toContainText("검수");
  await option.click();
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first()).toBeVisible();
  await expect(reviewButton).toHaveAttribute("aria-current", "page");
  await expect(headerGlossary).toBeVisible();
  await expect(headerGlossary).toHaveAttribute("aria-current", "page");
});

test("header glossary button works on mobile without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const headerGlossary = page.getByRole("button", { name: "용어 사전", exact: true });
  const searchTrigger = page.getByRole("button", { name: "메뉴·기능 검색", exact: true });

  await navigateWorkspace(page, "검수");
  await expect(headerGlossary).toBeVisible();
  // 버튼과 검색 트리거가 겹치지 않고, 가로 스크롤이 없다.
  const [glossaryBox, triggerBox] = await Promise.all([headerGlossary.boundingBox(), searchTrigger.boundingBox()]);
  expect(glossaryBox!.x + glossaryBox!.width).toBeLessThanOrEqual(triggerBox!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await headerGlossary.click();
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first()).toBeVisible();
  await expect(headerGlossary).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // 모바일에서 펼친 검색창과 버튼이 함께 있어도 가로 스크롤이 없다.
  await searchTrigger.click();
  const searchInput = page.getByRole("combobox", { name: "메뉴·기능 검색" });
  await expect(searchInput).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");

  await navigateWorkspace(page, "분석");
  await expect(headerGlossary).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await navigateWorkspace(page, "검수");
  await expect(headerGlossary).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("ax hitl accordion chevrons align with the review button right edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const task = taskFixture("chevron-align", diagnosisFixture);
  await seedAx(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
  for (const label of ["단계별 자동화 판단", "위험·확인사항 검토"]) {
    const sectionEl = page.locator(`section[aria-label="${label}"]`);
    await expect(sectionEl).toBeVisible();
    const trigger = sectionEl.locator('[data-slot="accordion-trigger"]').first();
    const chevron = trigger.locator('[data-slot="accordion-indicator"]').first();
    const reviewButton = sectionEl.locator(".col-action button").first();
    await expect(reviewButton).toBeVisible();
    const [chevronBox, buttonBox] = await Promise.all([chevron.boundingBox(), reviewButton.boundingBox()]);
    expect(chevronBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    // 셰브론의 시각적 오른쪽 끝과 검토 버튼의 오른쪽 테두리선이 일치한다.
    expect(Math.abs(chevronBox!.x + chevronBox!.width - (buttonBox!.x + buttonBox!.width))).toBeLessThanOrEqual(1.5);
    // 건수 표시와 셰브론이 겹치지 않는다.
    const countsBox = await sectionEl.locator(".ax-hitl-table-counts").first().boundingBox();
    expect(countsBox!.x + countsBox!.width).toBeLessThanOrEqual(chevronBox!.x);
    // 펼침·접힘이 반복 동작하고, 검토 버튼 위치·크기는 그대로 유지된다.
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(reviewButton).toBeHidden();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(reviewButton).toBeVisible();
    const buttonBoxAfter = await reviewButton.boundingBox();
    expect(buttonBoxAfter!.x).toBeCloseTo(buttonBox!.x, 0);
    expect(buttonBoxAfter!.width).toBeCloseTo(buttonBox!.width, 0);
  }
});

test("ax hitl accordion chevrons keep a safe right margin on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const task = taskFixture("chevron-align-mobile", diagnosisFixture);
  await seedAx(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
  for (const label of ["단계별 자동화 판단", "위험·확인사항 검토"]) {
    const sectionEl = page.locator(`section[aria-label="${label}"]`);
    await expect(sectionEl).toBeVisible();
    const trigger = sectionEl.locator('[data-slot="accordion-trigger"]').first();
    const chevron = trigger.locator('[data-slot="accordion-indicator"]').first();
    const cardBox = await sectionEl.locator(".ax-hitl-table-card").first().boundingBox();
    const chevronBox = await chevron.boundingBox();
    expect(chevronBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(chevronBox!.x + chevronBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width - 8);
    const countsBox = await sectionEl.locator(".ax-hitl-table-counts").first().boundingBox();
    expect(countsBox!.x + countsBox!.width).toBeLessThanOrEqual(chevronBox!.x);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
