import { expect, test, type Locator, type Page } from "@playwright/test";
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

/** Visible vertical gap between two elements, in whole CSS pixels.
 * Read both boxes in a single evaluate call so one layout read keeps the
 * pair consistent (see ax-guide-spacing.spec.ts for why two round-trips
 * can report a phantom gap). */
async function gap(upper: Locator, lower: Locator) {
  const lowerHandle = await lower.elementHandle();
  expect(lowerHandle).not.toBeNull();
  return upper.evaluate((upperEl, lowerEl) => {
    const upperRect = upperEl.getBoundingClientRect();
    const lowerRect = lowerEl.getBoundingClientRect();
    return Math.round(lowerRect.y - (upperRect.y + upperRect.height));
  }, lowerHandle);
}

async function expectGap(upper: Locator, lower: Locator, expected: number) {
  await expect.poll(() => gap(upper, lower)).toBe(expected);
}

test("result roadmap: 4-step nav box to summary KPI cards gap is 32px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture };
  const task: AxTask = { ...taskFixture("result-spacing-a", diagnosis), name: "결과 간격 확인 업무" };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const view = page.locator(".ax-view");
  const nav = view.locator(".ax-steps");
  await expect(nav).toBeVisible();
  const kpi = view.locator(".ax-kpi-cards");
  await expect(kpi).toBeVisible();
  // The 4 summary cards keep their labels, values and internal padding;
  // only the vertical distance from the nav box shrinks.
  await expect(kpi.locator(".ax-kpi").first()).toContainText("등록 업무");
  await expectGap(nav, kpi, 32);
});
