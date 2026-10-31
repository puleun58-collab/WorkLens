import { expect, test, type Locator, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2 } from "../../src/lib/ax/types";

async function seed(page: Page, value: AxStateV2) {
  await page.evaluate(async state => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(state, "current");
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, value);
}

/** 검토 영역 헤더 규격: 헤더 전체가 트리거이고, COSS 셰브론 지시자 1개가 트리거 오른쪽 끝에 있다. */
async function headerOf(section: Locator) {
  const trigger = section.locator('[data-slot="accordion-trigger"]');
  await expect(trigger).toHaveCount(1);
  const indicator = trigger.locator('[data-slot="accordion-indicator"]');
  await expect(indicator).toHaveCount(1);
  const [triggerBox, indicatorBox, countsBox] = await Promise.all([trigger.boundingBox(), indicator.boundingBox(), section.locator(".ax-hitl-table-counts").boundingBox()]);
  expect(countsBox!.x + countsBox!.width).toBeLessThanOrEqual(indicatorBox!.x);
  return { trigger, height: triggerBox!.height, chevronInset: triggerBox!.x + triggerBox!.width - (indicatorBox!.x + indicatorBox!.width) };
}

for (const [name, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
  test(`review accordions share one header spec (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    const task = taskFixture("review-accordion", { ...diagnosisFixture, planCodex: planFixture, planClaude: planFixture });
    await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
    await navigateWorkspace(page, "업무 자동화 진단");
    const headers = [];
    for (const label of ["단계별 자동화 판단", "위험·확인사항 검토"]) {
      const section = page.getByRole("region", { name: label, exact: true });
      const header = await headerOf(section);
      // 검토 필요가 있으면 기본 펼침.
      await expect(header.trigger).toHaveAttribute("aria-expanded", "true");
      await expect(section.locator(".ax-hitl-table-counts")).toHaveText(/전체 \d+·검토 완료 0·검토 필요 \d+/);
      headers.push(header);
    }
    await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
    const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    const planReview = plan.getByRole("region", { name: "구현 계획 검토", exact: true });
    const planHeader = await headerOf(planReview);
    await expect(planHeader.trigger).toHaveAttribute("aria-expanded", "true");
    headers.push(planHeader);
    const precheck = plan.getByRole("region", { name: "구현 전 확인", exact: true });
    const precheckHeader = await headerOf(precheck);
    // 구현 전 확인은 기본 접힘이고, 접혀 있어도 미해결 건수를 표시한다.
    await expect(precheckHeader.trigger).toHaveAttribute("aria-expanded", "false");
    await expect(precheck.locator(".ax-hitl-table-counts")).toHaveText(/미해결 \d+건/);
    headers.push(precheckHeader);
    // 4개 영역의 헤더 높이·셰브론 오른쪽 여백이 같다 (특정 영역만 별도 버튼 형태가 아니다).
    for (const header of headers) {
      expect(Math.abs(header.height - headers[0].height)).toBeLessThanOrEqual(1);
      expect(Math.abs(header.chevronInset - headers[0].chevronInset)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("review accordions toggle by keyboard and keep the panel open while a review is being edited", async ({ page }) => {
  await page.goto("/");
  const task = taskFixture("review-accordion-keys", { ...diagnosisFixture, planCodex: planFixture });
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const precheck = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  const trigger = precheck.getByRole("button", { name: /구현 전 확인/ });
  const count = Number(/미해결 (\d+)건/.exec(await precheck.locator(".ax-hitl-table-counts").innerText())?.[1]);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // 펼치면 헤더 건수와 같은 수의 실제 미해결 항목이 보인다 (펼침만으로 완료 처리하지 않음).
  await expect(precheck.locator(".ax-precheck-row")).toHaveCount(count);
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(precheck.locator(".ax-hitl-table-counts")).toHaveText(`미해결 ${count}건`);

  // 구현 계획 검토: 항목 검토 패널이 열려 있는 동안 접기를 막아 입력값을 보호한다.
  const review = plan.getByRole("region", { name: "구현 계획 검토", exact: true });
  const reviewTrigger = review.locator('[data-slot="accordion-trigger"]');
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  await review.locator(".col-action button").first().click();
  await expect(review.locator(".col-action button").first()).toHaveText("닫기");
  await expect(reviewTrigger).toBeDisabled();
  await review.locator(".col-action button").first().click();
  await expect(reviewTrigger).toBeEnabled();
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(review.locator(".ax-hitl-table")).toHaveCount(0);
});
