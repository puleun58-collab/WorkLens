import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2 } from "../../src/lib/ax/types";

// Deliberately interleave categories: grouping by category must never reorder execution.
const implementation = [
  "월별 합계 계산",
  "담당자 승인",
  "입력 자료 수집",
  "결과 보고서 생성",
  "자료 형식 표준화",
  "원본 파일 다운로드",
];
const categories = [
  "데이터 처리 및 계산", "운영 및 관리", "데이터 준비 및 수집",
  "결과 생성 및 보고", "데이터 처리 및 계산", "데이터 준비 및 수집",
];
const outputs = ["취합 결과 표", "대조 결과 목록", "담당자 전달 문서", "작업 이력 파일"];
const integrations = ["입력 폴더 연결", "결과 폴더 연결", "사내 문서함 연결"];

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
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, value);
}

async function openRoadmap(page: Page, id: string) {
  await page.goto("/");
  const task = taskFixture(id, {
    ...diagnosisFixture,
    poc: { ...diagnosisFixture.poc, outputs },
    planCodex: { ...planFixture, implementation, integrations },
  });
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  return task;
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`roadmap preserves execution order and independent scope cards (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openRoadmap(page, `roadmap-order-${name}`);
    const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
    const review = plan.getByRole("region", { name: "구현 계획", exact: true });
    const steps = review.locator(".ax-plan-steps > .ax-plan-step");
    await expect(review.locator(".ax-plan-group")).toHaveCount(0);
    await expect(steps).toHaveCount(implementation.length);
    await expect(steps.locator(".ax-plan-step-no")).toHaveText(implementation.map((_, index) => String(index + 1).padStart(2, "0")));
    await expect(steps.locator(".ax-plan-step-text")).toHaveText(implementation);
    await expect(steps.locator(".ax-plan-step-category")).toHaveText(categories);
    for (const step of await steps.all()) await expect(step).toBeVisible();

    const scope = plan.locator('[data-scope-group="scope"]');
    const criteria = plan.locator('[data-scope-group="criteria"]');
    const sections = scope.locator(".ax-scope-section");
    await expect(sections).toHaveCount(4);
    const labels = ["구현 대상", "담당자 수행", "보류·제외", "적용 방식"];
    await expect(scope.locator(".ax-scope-tiles > div")).toHaveCount(4);
    await expect(scope.locator(".ax-scope-tiles dt")).toHaveText(labels);
    await expect(scope.getByRole("button", { name: /전체 보기|전체 접기/ })).toHaveCount(0);
    await expect(sections.first().locator('[data-slot="accordion-trigger"]')).toHaveAttribute("aria-expanded", "true");
    for (const trigger of await sections.locator('[data-slot="accordion-trigger"]').all().then(items => items.slice(1))) {
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
    await plan.locator(".ax-scope-summary").evaluate(element => {
      (element as HTMLElement).style.scrollMarginTop = "90px";
      element.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.screenshot({ path: `artifacts/roadmap-ref2/roadmap-${name}-default.png` });
    const counts: number[] = [];
    for (const [index, label] of labels.entries()) {
      const section = sections.nth(index);
      const trigger = section.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveAttribute("aria-expanded", index === 0 ? "true" : "false");
      await expect(trigger).toContainText(new RegExp(`${label} \\(\\d+개\\)`));
      counts.push(Number(/\((\d+)개\)/.exec(await trigger.innerText())![1]));
      if (index > 0) await trigger.click();
      await expect(section.locator("tbody tr")).toHaveCount(counts[index]);
      for (const item of await section.locator("tbody tr").all()) await expect(item).toBeVisible();
    }
    expect(counts[3]).toBe(integrations.length + outputs.length);
    await expect(sections.nth(3).locator("tbody tr td:last-child")).toHaveText([
      ...integrations.map(text => `${text} (계획안 · 확정 전)`),
      ...outputs.map(text => `산출물: ${text}`),
    ]);
    const rows = criteria.locator("tr.ax-criteria-item.ax-criteria-row");
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.locator("td.ax-criteria-text")).toHaveCount(await rows.count());
    await expect(rows.locator("span.ax-criteria-no")).toHaveText(
      Array.from({ length: await rows.count() }, (_, index) => String(index + 1)),
    );
    for (const number of await rows.locator(".ax-criteria-no").all()) {
      expect(await number.evaluate(element => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);
    }
    const layout = plan.locator(".ax-scope-summary");
    await expect(layout).toHaveCSS("align-items", "start");
    const scopeBox = (await scope.boundingBox())!;
    const criteriaBox = (await criteria.boundingBox())!;
    if (name === "desktop") {
      expect(Math.abs(scopeBox.y - criteriaBox.y)).toBeLessThanOrEqual(1);
      expect(criteriaBox.x).toBeGreaterThanOrEqual(scopeBox.x + scopeBox.width);
    } else {
      expect(Math.abs(scopeBox.x - criteriaBox.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(scopeBox.width - criteriaBox.width)).toBeLessThanOrEqual(1);
      expect(criteriaBox.y).toBeGreaterThanOrEqual(scopeBox.y + scopeBox.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await layout.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/roadmap-ref2/roadmap-${name}-expanded-full.png`, fullPage: true });
    for (const trigger of await sections.locator('[data-slot="accordion-trigger"]').all()) await trigger.click();
    for (const trigger of await sections.locator('[data-slot="accordion-trigger"]').all()) {
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
    await layout.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    await layout.evaluate(element => {
      (element as HTMLElement).style.scrollMarginTop = "90px";
      element.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.screenshot({ path: `artifacts/roadmap-ref2/roadmap-${name}-collapsed.png` });
  });
}

test("an interleaved implementation review persists on its original step after reload", async ({ page }) => {
  const task = await openRoadmap(page, "roadmap-order-persistence");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  const steps = review.locator(".ax-plan-steps > .ax-plan-step");
  // Original step 3 belongs to the first category in the old grouped presentation.
  const selected = steps.nth(2);
  await expect(selected.locator(".ax-plan-step-text")).toHaveText(implementation[2]);
  await selected.getByRole("button", { name: "검토", exact: true }).click();
  await selected.getByRole("radio", { name: /유지/ }).check();
  await selected.getByRole("textbox", { name: /의견/ }).fill("원본 03 단계만 확인 완료");
  await selected.getByRole("button", { name: "확정", exact: true }).click();
  await expect(selected.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  await expect.poll(() => page.evaluate(async taskId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const state = await new Promise<AxStateV2>((resolve, reject) => {
      const request = db.transaction("state").objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return state.tasks.find(saved => saved.id === taskId)?.reviews?.some(saved =>
      saved.status === "confirmed" && saved.comment === "원본 03 단계만 확인 완료" && saved.target.sourceText === "입력 자료 수집",
    ) ?? false;
  }, task.id)).toBe(true);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(steps.locator(".ax-plan-step-text")).toHaveText(implementation);
  await expect(steps.locator(".ax-plan-step-no")).toHaveText(["01", "02", "03", "04", "05", "06"]);
  for (let index = 0; index < implementation.length; index += 1) {
    const status = steps.nth(index).locator(".ax-hitl-status-dot");
    if (index === 2) await expect(status).toHaveAttribute("data-status", "confirmed");
    else await expect(status).not.toHaveAttribute("data-status", "confirmed");
  }
  await selected.getByRole("button", { name: "보기", exact: true }).click();
  await expect(selected.locator(".ax-plan-review-panel")).toContainText("원본 03 단계만 확인 완료");
  await expect(plan.locator("tr.ax-criteria-item .ax-criteria-no")).toHaveCount(2);
});
