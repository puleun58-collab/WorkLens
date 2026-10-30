import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTask } from "../../src/lib/ax/types";

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

async function openPlan(page: Page) {
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture };
  const task: AxTask = { ...taskFixture("fix-a", diagnosis), name: "수정 지시문 확인 업무" };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(plan).toBeVisible();
  return plan;
}

test("fix prompt section previews from verification input and saves the round", async ({ page }) => {
  const plan = await openPlan(page);
  const section = plan.getByRole("region", { name: "검증 결과와 수정·보완 지시문", exact: true });
  await expect(section).toBeVisible();
  await section.getByLabel("실패 기능").fill("자료 수집");
  await section.getByLabel("기대 결과").fill("합계 1,000");
  await section.getByLabel("실제 결과").fill("합계 950");
  await section.getByRole("button", { name: "전체 보기" }).click();
  const prompt = section.locator(".ax-prompt");
  await expect(prompt).toContainText("자료 수집");
  await expect(prompt).toContainText("합계 1,000");
  await expect(prompt).toContainText("합계 950");
  await expect(prompt).toContainText("유지할 정상 기능");
  await section.getByRole("button", { name: "검증 결과 저장", exact: true }).click();
  await expect(section.getByText("검증 결과를 저장했습니다.")).toBeVisible();
  await expect(section.locator(".ax-fix-rounds")).toContainText("자료 수집");
  // 저장은 300ms 디바운스 후 IndexedDB에 기록되므로, 실제 기록을 확인한 뒤 새로고침한다.
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const request = tx.objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const tasks = (record as { tasks?: Array<{ verificationResults?: unknown[] }> } | undefined)?.tasks ?? [];
    return tasks.flatMap(task => task.verificationResults ?? []).length;
  })).toBe(1);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  const planAfterReload = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(planAfterReload.getByRole("region", { name: "검증 결과와 수정·보완 지시문", exact: true }).locator(".ax-fix-rounds")).toContainText("자료 수집");
});
