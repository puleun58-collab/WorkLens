import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { excelComparisonFixture, facilitySafetyFixture, scheduleNotificationFixture } from "../fixtures/ax-rule-derivation";
import { taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";

async function seed(page: Page, record: unknown) {
  await page.evaluate(async value => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(value, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, record);
}

for (const fixture of [excelComparisonFixture, facilitySafetyFixture, scheduleNotificationFixture]) {
  for (const width of [1440, 390]) {
    test(`업무별 규칙 제안 ${fixture.id} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      const task = { ...taskFixture(`rules-${fixture.id}`, fixture.diagnosis), name: fixture.label };
      await page.goto("/");
      await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
      await navigateWorkspace(page, "업무 자동화 진단");
      const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
      await expect(section).toBeVisible();
      for (const id of fixture.expectedDecisionIds) await expect(section.locator(`#ax-decision-${id}`)).toHaveCount(1);
      for (const id of fixture.excludedDecisionIds) await expect(section.locator(`#ax-decision-${id}`)).toHaveCount(0);
      const cards = section.locator(".ax-decision-row");
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
      await expect(section.getByText(`0/${count} 완료`, { exact: true })).toBeVisible();
      await expect(section.getByText("제안", { exact: true })).toHaveCount(count);
      await expect(section.getByText("신규", { exact: true })).toHaveCount(0);
      await expect(section).not.toContainText("이메일 API 제공 여부 확인");
      const bounds = await section.evaluate(element => ({ width: element.getBoundingClientRect().width, viewport: window.innerWidth, scroll: document.documentElement.scrollWidth }));
      expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport);
      await section.screenshot({
        path: `artifacts/rules/${fixture.id}-${width}.png`,
        animations: "disabled",
        style: ".utility-bar, .skip-link, .wl-assistant-root { visibility: hidden !important; }",
      });
      await section.getByRole("button", { name: "저장", exact: true }).click();
      await expect(section.getByText("업무 규칙을 저장했습니다", { exact: true })).toBeVisible();
      const persisted = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("worklens-ax", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const result = await new Promise<{ tasks: { diagnosis?: { decisionPoints?: unknown[] }; genericRules?: unknown[] }[] }>((resolve, reject) => {
          const request = db.transaction("state").objectStore("state").get("current");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return result.tasks[0];
      });
      expect(persisted.diagnosis?.decisionPoints ?? []).toEqual([]);
      expect(persisted.genericRules ?? []).toEqual([]);
      await expect(section.getByText(`0/${count} 완료`, { exact: true })).toBeVisible();
    });
  }
}
