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

test("review accordion moves dictionary under review and keeps parent navigation separate", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true });
  const toggle = nav.locator(".workspace-nav-toggle");
  const dictionary = nav.getByRole("button", { name: "Dictionary", exact: true });
  const documentReview = nav.getByRole("button", { name: "문서 검수", exact: true });

  // HELP 하단에는 용어 사전 최상위 행이 없고, 검수는 접힌 상태로 시작한다.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(dictionary).toHaveCount(0);
  await expect(documentReview).toHaveCount(0);

  // 셰브론 클릭은 화면 이동 없이 하위 메뉴만 펼친다.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute("aria-label", "검수 하위 메뉴 접기");
  await expect(dictionary).toBeVisible();
  await expect(documentReview).toBeVisible();
  await expect(page.locator(".context-bar h1")).not.toHaveText("검수");

  // 하위 메뉴는 부모보다 한 단계 들여쓰기한다.
  const parentBox = await nav.getByRole("button", { name: "검수", exact: true }).boundingBox();
  const childBox = await dictionary.boundingBox();
  expect(childBox!.x).toBeGreaterThan(parentBox!.x);

  // 검수 본문 클릭은 기존 검수 화면으로 이동하고, 하위 메뉴는 펼쳐진 채 유지된다.
  await nav.getByRole("button", { name: "검수", exact: true }).click();
  await expect(nav.getByRole("button", { name: "검수", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // 사용자가 직접 접으면 같은 화면에 머무르는 동안 접힌 상태가 유지된다.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(dictionary).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "검수", exact: true })).toHaveAttribute("aria-current", "page");

  // 다른 카테고리로 나갔다가 검수 화면으로 돌아오면 하위 메뉴가 자동으로 펼쳐진다.
  await navigateWorkspace(page, "분석");
  await navigateWorkspace(page, "검수");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dictionary).toBeVisible();

  // 용어 사전 하위 메뉴 클릭은 기존 용어 사전 화면으로 이동한다.
  await dictionary.click();
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first()).toBeVisible();
  await expect(dictionary).toHaveAttribute("aria-current", "page");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // 다른 카테고리로 이동해도 펼침 상태는 유지된다. 검색 전 직접 접어 둔다.
  await navigateWorkspace(page, "분석");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // 메뉴 검색에서 용어 사전은 검수 소속으로 표시되고, 선택 시 아코디언이 펼쳐진다.
  await page.keyboard.press("Control+K");
  const search = page.getByRole("combobox", { name: "메뉴·기능 검색" });
  await search.fill("용어 사전");
  const option = page.getByRole("option", { name: "용어 사전", exact: true });
  await expect(option).toBeVisible();
  await expect(page.locator(".workspace-search-results")).toContainText("검수");
  await option.click();
  await expect(page.locator('.settings-surface[aria-label="Dictionary"] .dictionary-section').first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dictionary).toHaveAttribute("aria-current", "page");
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
