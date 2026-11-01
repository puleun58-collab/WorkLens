import { expect, test, type Locator, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type HitlReview } from "../../src/lib/ax/types";
import { extractPlanReviewableItems } from "../../src/lib/ax/hitl";

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
    const steps = planReview.locator(".ax-plan-steps > .ax-plan-step");
    await expect(planReview.locator(".ax-plan-group")).toHaveCount(0);
    await expect(steps).toHaveCount(planFixture.implementation.length);
    await expect(steps.locator(".ax-plan-step-no")).toHaveText(["01", "02", "03"]);
    await expect(steps.locator(".ax-plan-step-text")).toHaveText(planFixture.implementation);
    const planHeader = await headerOf(planReview);
    await expect(planHeader.trigger).toHaveAttribute("aria-expanded", "true");
    await expect(planReview.getByRole("button", { name: /전체 접기|전체 펼치기/ })).toHaveCount(0);
    await expect(planReview.locator(".ax-hitl-table-counts")).toHaveText("검토 필요 3건");
    headers.push(planHeader);
    await expect(planHeader.trigger).toContainText("구현 계획 (3개)");
    await expect(plan.getByRole("heading", { name: "완료 기준 (2개)" })).toBeVisible();
    const badgeStyles = await page.locator(".ax-report-intro .ax-title-group").evaluate(group => {
      const level = getComputedStyle(group.querySelector(".ax-level-badge")!);
      const status = getComputedStyle(group.querySelector(".ax-status-badge")!);
      return [level, status].map(style => [style.minHeight, style.borderRadius, style.borderTopWidth, style.paddingLeft, style.fontSize, style.fontWeight, style.alignItems]);
    });
    expect(badgeStyles[0]).toEqual(badgeStyles[1]);
    const categories = steps.locator(".ax-plan-step-category");
    await expect(categories).toHaveCount(planFixture.implementation.length);
    if (name === "desktop") {
      const positions = await steps.locator(".ax-plan-step-text").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
    } else {
      expect(await categories.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    }
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
    const criterion = plan.locator(".ax-criteria-item").first();
    const criterionPanel = criterion.locator("xpath=following-sibling::tr[1]").locator(".ax-plan-review-panel");
    await criterion.getByRole("button", { name: "검토" }).click();
    await criterionPanel.getByRole("radio", { name: /유지/ }).check();
    await criterionPanel.getByRole("button", { name: "확정" }).click();
    await criterion.getByRole("button", { name: "닫기" }).click();
    await criterion.getByRole("button", { name: "보기" }).click();
    await page.screenshot({ path: `artifacts/roadmap-ref2/roadmap-review-${name}.png`, fullPage: true });
  });
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
  await step.getByRole("button", { name: "검토" }).click();
  await step.getByRole("radio", { name: /유지/ }).check();
  const comment = step.getByRole("textbox", { name: /의견/ });
  await comment.fill("접기 전 작성한 검토 의견");
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(comment).not.toBeVisible();
  await reviewTrigger.click();
  await expect(reviewTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(comment).toHaveValue("접기 전 작성한 검토 의견");
  await expect(step.getByRole("radio", { name: /유지/ })).toBeChecked();
  await expect(review.locator(".ax-plan-step-text")).toHaveText(planFixture.implementation);
});

test("implementation steps and completion criteria save independently and persist after reload", async ({ page }) => {
  await page.goto("/");
  const task = taskFixture("plan-review-save", { ...diagnosisFixture, planCodex: planFixture });
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  const step = review.locator(".ax-plan-step").first();
  await step.getByRole("button", { name: "검토" }).click();
  await step.locator(".ax-hitl-panel-v2").getByRole("radio", { name: /유지/ }).check();
  await step.locator(".ax-hitl-panel-v2").getByRole("button", { name: "확정" }).click();
  await expect(step.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  const criterion = plan.locator(".ax-criteria-item").first();
  await criterion.getByRole("button", { name: "검토" }).click();
  const detail = criterion.locator("xpath=following-sibling::tr[1]").locator(".ax-plan-review-panel");
  await expect(detail.locator(".ax-hitl-panel-v2")).toBeVisible();
  await expect(detail.getByText("AI 판단", { exact: true })).toBeVisible();
  // 완료 기준 검토 패널은 단계별 자동화 판단 검토와 같은 디자인(패널 테두리·AI 판단 박스 배경)을 쓴다.
  const surfaces = await detail.evaluate(root => [root.querySelector(".ax-hitl-panel-v2"), root.querySelector(".ax-hitl-v2-original")].map(node => {
    const style = getComputedStyle(node!);
    return { border: style.borderTopWidth, background: style.backgroundColor };
  }));
  expect(surfaces[0].border).not.toBe("0px");
  expect(surfaces[1].background).toBe("rgb(240, 244, 248)");
  await detail.getByRole("radio", { name: /유지/ }).check();
  await detail.getByRole("button", { name: "확정" }).click();
  await expect(criterion).toHaveAttribute("data-status", "confirmed");
  await criterion.getByRole("button", { name: "닫기" }).click();
  await criterion.getByRole("button", { name: "보기" }).click();
  await expect(detail.getByText("내 검토", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "수정" }).click();
  await detail.getByRole("textbox", { name: /의견/ }).fill("기준 확인 완료");
  await detail.getByRole("button", { name: "확정" }).click();
  await expect(detail).toContainText("기준 확인 완료");
  await expect(review.locator(".ax-hitl-table-counts")).toHaveText("검토 필요 2건");
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
  await expect(plan.locator(".ax-plan-step").first().locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  await expect(plan.locator(".ax-criteria-item").first()).toHaveAttribute("data-status", "confirmed");
  await plan.locator(".ax-criteria-item").first().getByRole("button", { name: "보기" }).click();
  await expect(plan.locator(".ax-criteria-item").first().locator("xpath=following-sibling::tr[1]").locator(".ax-plan-review-panel")).toContainText("기준 확인 완료");
});

test("roadmap scope keeps every item, distinguishes confirmed deferrals, and omits generic notices", async ({ page }) => {
  await page.goto("/");
  const diagnosis = {
    ...diagnosisFixture,
    poc: { ...diagnosisFixture.poc, outputs: ["결과 A", "결과 B", "결과 C", "결과 D"] },
    planCodex: { ...planFixture, integrations: ["연동 A", "연동 B", "연동 C", "연동 D"] },
  };
  const task = taskFixture("scope-review", diagnosis);
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const scope = plan.locator('[data-scope-group="scope"]');
  await expect(scope.locator(".ax-scope-section")).toHaveCount(4);
  const sections = scope.locator(".ax-scope-section");
  for (const [index, trigger] of (await sections.locator('[data-slot="accordion-trigger"]').all()).entries()) {
    await expect(trigger).toHaveAttribute("aria-expanded", index === 0 ? "true" : "false");
  }
  await expect(scope.getByRole("button", { name: /전체 보기|전체 접기/ })).toHaveCount(0);
  const method = sections.filter({ has: page.getByRole("button", { name: /^적용 방식 \(8개\)/ }) });
  await method.locator('[data-slot="accordion-trigger"]').click();
  await expect(method.locator("tbody tr")).toHaveCount(8);
  await expect(method.locator("tbody tr td:last-child")).toHaveText([
    ...diagnosis.planCodex.integrations.map(text => `${text} (계획안 · 확정 전)`),
    ...diagnosis.poc.outputs.map(text => `산출물: ${text}`),
  ]);
  await expect(scope).not.toContainText("미확정 처리 방식과 필수 기준은 해당 단계에서 확인이 필요합니다");
  await expect(plan.locator('[data-scope-group="criteria"]')).not.toContainText("정확한 합격 판정 기준은 실제 업무 규칙 확인 후 확정합니다");
  await expect(plan.locator('[data-scope-group="criteria"]')).not.toContainText("검증 대상 단계와 적용 범위는 확인이 필요합니다");
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  const step = review.locator(".ax-plan-step").first();
  await step.getByRole("button", { name: "검토" }).click();
  await step.getByRole("radio", { name: /보류/ }).check();
  await step.getByRole("textbox", { name: /보류 사유/ }).fill("외부 승인 대기");
  await step.getByRole("textbox", { name: /재개 조건/ }).fill("승인 수령");
  await step.getByRole("button", { name: "확정" }).click();
  const deferred = scope.locator(".ax-scope-section").filter({ has: page.getByRole("button", { name: /^보류·제외 \(\d+개\)/ }) });
  await deferred.locator('[data-slot="accordion-trigger"]').click();
  await expect(deferred).toContainText("보류 사유: 외부 승인 대기 · 재개 조건: 승인 수령");
  await expect(deferred).toContainText("현재 구현 제외");
});

test("scope guides toggle and criterion filters preserve exact review states", async ({ page }) => {
  await page.goto("/");
  const planData = { ...planFixture, acceptance: ["미검토 기준", "확정 기준", "원본 변경 기준", "보완 기준"], tests: [] };
  const criteria = extractPlanReviewableItems(planData, "codex").filter(item => item.type === "criterion");
  const reviews: HitlReview[] = criteria.slice(1).map((item, index) => ({
    id: `criteria-filter-${index}`,
    target: { key: item.key, type: item.type, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action: "keep",
    status: (["confirmed", "stale", "editing"] as const)[index],
    reviewedAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  }));
  const task = { ...taskFixture("criteria-filters", { ...diagnosisFixture, planCodex: planData }), reviews };
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const scopeGuide = plan.getByRole("button", { name: "범위 안내", exact: true });
  const criteriaGuide = plan.getByRole("button", { name: "기준 안내", exact: true });
  await expect(scopeGuide).toHaveAttribute("aria-expanded", "false");
  await expect(criteriaGuide).toHaveAttribute("aria-expanded", "false");
  await scopeGuide.click();
  await expect(page.locator("#ax-scope-guide")).toBeVisible();
  await criteriaGuide.click();
  await expect(scopeGuide).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#ax-scope-guide")).not.toBeVisible();
  await expect(page.locator("#ax-criteria-guide")).toContainText("검토 완료는 구현이나 테스트의 완료를 뜻하지 않습니다");
  await criteriaGuide.click();
  await expect(page.locator("#ax-criteria-guide")).not.toBeVisible();
  const card = plan.locator('[data-scope-group="criteria"]');
  const filters = card.getByRole("group", { name: "완료 기준 검토 상태", exact: true });
  const rows = card.locator("tr.ax-criteria-item:visible");
  for (const [label, statuses, numbers] of [
    ["검토 전", ["pending"], ["1"]],
    ["검토 중", ["stale", "editing"], ["3", "4"]],
    ["검토 완료", ["confirmed"], ["2"]],
    ["재확인 필요", ["stale"], ["3"]],
    ["보완 중", ["editing"], ["4"]],
    ["전체", ["pending", "confirmed", "stale", "editing"], ["1", "2", "3", "4"]],
  ] as const) {
    const button = filters.getByRole("button", { name: `${label} (${statuses.length})`, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(statuses.length);
    await expect(rows.locator(".ax-criteria-no")).toHaveText([...numbers]);
    for (const [index, status] of statuses.entries()) await expect(rows.nth(index)).toHaveAttribute("data-status", status);
  }
});
