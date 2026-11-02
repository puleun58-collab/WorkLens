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


test("an interleaved implementation review persists on its original step after reload", async ({ page }) => {
  const task = await openRoadmap(page, "roadmap-order-persistence");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const review = plan.getByRole("region", { name: "구현 계획", exact: true });
  const steps = review.locator(".ax-plan-steps > .ax-plan-step");
  // Original step 3 belongs to the first category in the old grouped presentation.
  const selected = steps.nth(2);
  await expect(selected.locator(".ax-plan-step-text")).toHaveText(implementation[2]);
  await selected.getByRole("button", { name: "보기", exact: true }).click();
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
});
