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
    const planReview = plan.getByRole("region", { name: "구현 계획", exact: true });
    const groups = planReview.locator(".ax-plan-group");
    await expect(groups).toHaveCount(2);
    await expect(groups.locator('[data-slot="accordion-trigger"]')).toHaveCount(2);
    for (const trigger of await groups.locator('[data-slot="accordion-trigger"]').all()) await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(planReview.locator(".ax-hitl-table-counts")).toHaveText(/전체 \d+·검토 완료 0·검토 필요 \d+/);
    const precheck = plan.getByRole("region", { name: "구현 전 확인", exact: true });
    const precheckHeader = await headerOf(precheck);
    // 구현 전 확인은 기본 접힘이고, 접혀 있어도 미해결 건수를 표시한다.
    await expect(precheckHeader.trigger).toHaveAttribute("aria-expanded", "false");
    await expect(precheck.locator(".ax-hitl-table-counts")).toHaveText(/미해결 \d+건/);
    headers.push(precheckHeader);
    // 동일한 검토 헤더들만 높이·셰브론 여백을 공유한다 (1px 허용, 브라우저별 서브픽셀 반올림 차이는 제외).
    for (const header of headers) {
      expect(Math.abs(Math.round(header.height) - Math.round(headers[0].height))).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.round(header.chevronInset) - Math.round(headers[0].chevronInset))).toBeLessThanOrEqual(1);
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

  // 구현 계획 그룹은 기본 접힘이고 검토 중 입력을 보호하기 위해 열린 그룹을 유지한다.
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  const group = review.locator(".ax-plan-group").first();
  const reviewTrigger = group.locator('[data-slot="accordion-trigger"]');
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "false");
  await reviewTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  const step = group.locator(".ax-plan-step").first();
  await step.getByRole("button", { name: "검토" }).click();
  await expect(step.getByRole("button", { name: "닫기" })).toBeVisible();
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(step.locator(".ax-hitl-panel-v2")).toBeVisible();
  await step.getByRole("button", { name: "닫기" }).click();
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".ax-plan-step")).toHaveCount(0);
});

test("implementation steps and completion criteria save independently and persist after reload", async ({ page }) => {
  await page.goto("/");
  const task = taskFixture("plan-review-save", { ...diagnosisFixture, planCodex: planFixture });
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  await review.getByRole("button", { name: "전체 펼치기" }).click();
  const step = review.locator(".ax-plan-step").first();
  await step.getByRole("button", { name: "검토" }).click();
  await step.locator(".ax-hitl-panel-v2").getByRole("radio", { name: /유지/ }).check();
  await step.locator(".ax-hitl-panel-v2").getByRole("button", { name: "확정" }).click();
  await expect(step.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  const criterion = plan.locator(".ax-criteria-item").first();
  await criterion.getByRole("button", { name: "검토" }).click();
  await criterion.locator(".ax-hitl-panel-v2").getByRole("radio", { name: /유지/ }).check();
  await criterion.locator(".ax-hitl-panel-v2").getByRole("button", { name: "확정" }).click();
  await expect(criterion).toHaveAttribute("data-status", "confirmed");
  await expect(review.locator(".ax-hitl-table-counts")).toContainText("검토 완료 2");
  // IndexedDB 영구 저장은 UI 반영 뒤 비동기로 완료되므로 저장 결과를 기다린 뒤 재조회한다.
  await expect.poll(() => page.evaluate(async taskId => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open("worklens-ax", 1); request.onsuccess = () => resolve(request.result); });
    const state = await new Promise<AxStateV2>(resolve => { const request = db.transaction("state").objectStore("state").get("current"); request.onsuccess = () => resolve(request.result); });
    db.close();
    return state.tasks.find(saved => saved.id === taskId)?.reviews?.filter(review => review.status === "confirmed").length;
  }, task.id)).toBe(2);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await plan.getByRole("region", { name: "구현 계획", exact: true }).getByRole("button", { name: "전체 펼치기" }).click();
  await expect(plan.locator(".ax-plan-step").first().locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  await expect(plan.locator(".ax-criteria-item").first()).toHaveAttribute("data-status", "confirmed");
});
