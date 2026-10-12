import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture } from "../fixtures/ax";
import type { AxState } from "../../src/lib/ax/types";

async function stored(page: Page): Promise<AxState> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const value = await new Promise<AxState>((resolve, reject) => {
      const req = db.transaction("state").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    }); db.close(); return value;
  });
}

test("AX in-flight diagnosis locks task mutation and cannot apply a late response after workspace exit", async ({ page }) => {
  await page.goto("/"); await navigateWorkspace(page, "업무 자동화 진단");
  for (const name of ["비동기 A", "비동기 B"]) {
    await page.getByLabel("업무명", { exact: true }).fill(name);
    await page.getByLabel("업무 설명", { exact: true }).fill(`${name}의 자료를 수집하고 담당자가 검토합니다.`);
    await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  }
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.locator(".ax-task-row-btn").filter({ hasText: "비동기 A" }).click();
  await expect.poll(async () => (await stored(page))?.tasks.length).toBe(2);
  await expect.poll(async () => { const value = await stored(page); return { step: value.step, selectedName: value.tasks.find(task => task.id === value.selectedTaskId)?.name }; }).toEqual({ step: 2, selectedName: "비동기 A" });
  const before = await stored(page);
  const { promise: delayed, resolve: release } = Promise.withResolvers<void>();
  const { promise: received, resolve: started } = Promise.withResolvers<void>();
  const { promise: replied, resolve: finished } = Promise.withResolvers<void>();
  const calls: { name: string }[] = [];
  await page.route("**/api/ai", async route => {
    calls.push(route.request().postDataJSON()); started(); await delayed;
    try { await route.fulfill({ json: { data: { kind: "ax-diagnosis", diagnosis: outputFixture() } } }); }
    catch { /* A cancelled fetch may already have detached; neither outcome may store the result. */ }
    finally { finished(); }
  });
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click(); await received;
  await expect(page.getByRole("button", { name: "진단 중…", exact: true })).toBeDisabled();
  await expect(page.locator(".ax-task-row-btn").filter({ hasText: "비동기 B" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "등록 정보 수정", exact: true })).toBeDisabled();
  await expect(page.getByRole("tab", { name: "결과·로드맵", exact: true })).toBeDisabled();
  await navigateWorkspace(page, "분석"); release(); await replied;
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
  expect(await stored(page)).toEqual(before); expect(calls.map(call => call.name)).toEqual(["비동기 A"]);
  await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.locator(".ax-task-row-btn").filter({ hasText: "비동기 A" })).toHaveAttribute("aria-pressed", "true");
  expect((await stored(page)).tasks.every(task => task.diagnosis === undefined)).toBe(true);
});
