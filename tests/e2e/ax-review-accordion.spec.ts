import { expect, test, type Page } from "@playwright/test";
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


test("review accordions toggle by keyboard and retain review input across header collapse", async ({ page }) => {
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

  // 헤더로 전체 패널을 접고 다시 열어도 저장 전 입력과 원본 순서를 유지한다.
  const review = plan.locator("#ax-plan-review");
  const reviewTrigger = review.locator('[data-slot="accordion-trigger"]');
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  await reviewTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(review.locator(".ax-plan-step").first()).not.toBeVisible();
  await expect(review.getByRole("tab", { name: "Codex", exact: true })).not.toBeVisible();
  await page.keyboard.press("Space");
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  const step = review.locator(".ax-plan-steps > .ax-plan-step").first();
  await step.getByRole("button", { name: "보기" }).click();
  await step.getByRole("radio", { name: /유지/ }).check();
  const comment = step.getByRole("textbox", { name: /의견/ });
  await comment.fill("접기 전 작성한 검토 의견");
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(comment).not.toBeVisible();
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(comment).toHaveValue("접기 전 작성한 검토 의견");
  await step.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(comment).not.toBeVisible();
  await step.getByRole("button", { name: "보기", exact: true }).click();
  await expect(comment).toHaveValue("접기 전 작성한 검토 의견");
  await expect(step.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "pending");
  await expect(step.getByRole("radio", { name: /유지/ })).toBeChecked();
  await expect(review.locator(".ax-plan-step-text")).toHaveText(planFixture.implementation);
  await step.getByRole("button", { name: "취소", exact: true }).click();
  await step.getByRole("button", { name: "보기", exact: true }).click();
  await expect(step.getByRole("radio", { name: /유지/ })).not.toBeChecked();
  await step.getByRole("radio", { name: /유지/ }).check();
  await expect(comment).toHaveValue("");
});

test("implementation steps and completion criteria save independently and persist after reload", async ({ page }) => {
  await page.goto("/");
  const task = taskFixture("plan-review-save", { ...diagnosisFixture, planCodex: planFixture });
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  const step = review.locator(".ax-plan-step").first();
  await step.getByRole("button", { name: "보기" }).click();
  await step.locator(".ax-hitl-panel-v2").getByRole("radio", { name: /유지/ }).check();
  await step.locator(".ax-hitl-panel-v2").getByRole("button", { name: "확정" }).click();
  await expect(step.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  const completion = plan.getByRole("region", { name: "완료 기준", exact: true });
  await completion.locator('[data-slot="accordion-trigger"]').click();
  const criterion = completion.locator(".ax-plan-step").first();
  await criterion.getByRole("button", { name: "보기" }).click();
  const detail = criterion.locator(".ax-plan-review-panel");
  await expect(detail.locator(".ax-hitl-panel-v2")).toBeVisible();
  await expect(detail.getByText("AI 판단", { exact: true })).toBeVisible();
  await detail.getByRole("radio", { name: /유지/ }).check();
  await detail.getByRole("button", { name: "확정" }).click();
  await expect(criterion.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  await criterion.getByRole("button", { name: "닫기" }).click();
  await criterion.getByRole("button", { name: "보기" }).click();
  await expect(detail.getByText("내 검토", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "수정" }).click();
  await detail.getByRole("textbox", { name: /의견/ }).fill("기준 확인 완료");
  await detail.getByRole("button", { name: "확정" }).click();
  await expect(detail).toContainText("기준 확인 완료");
  // IndexedDB 영구 저장은 UI 반영 뒤 비동기(디바운스)로 완료되므로, 수정한 의견까지 저장된 것을 확인한 뒤 재조회한다.
  await expect.poll(() => page.evaluate(async taskId => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open("worklens-ax", 1); request.onsuccess = () => resolve(request.result); });
    const state = await new Promise<AxStateV2>(resolve => { const request = db.transaction("state").objectStore("state").get("current"); request.onsuccess = () => resolve(request.result); });
    db.close();
    const confirmed = state.tasks.find(saved => saved.id === taskId)?.reviews?.filter(review => review.status === "confirmed") ?? [];
    return `${confirmed.length}:${confirmed.some(review => review.comment === "기준 확인 완료")}`;
  }, task.id)).toBe("2:true");
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(review.locator(".ax-plan-step").first().locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  await completion.locator('[data-slot="accordion-trigger"]').click();
  await expect(criterion.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  await criterion.getByRole("button", { name: "보기" }).click();
  await expect(detail).toContainText("기준 확인 완료");
});
