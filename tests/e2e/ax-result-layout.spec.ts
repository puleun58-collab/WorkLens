import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2 } from "../../src/lib/ax/types";
import { diagnosisCounts } from "../../src/lib/ax/policy";
import { axStateV2Schema } from "../../src/lib/ax/schema";

for (const width of [1440, 390]) {
  test(`result layout measurements and selection preserve records ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const diagnosis = { ...structuredClone(diagnosisFixture), planCodex: planFixture, planClaude: planFixture };
    const tasks = [
      { ...taskFixture("long", diagnosis), name: "매월 여러 부서의 입력 자료와 승인 내역을 취합하여 누락과 중복을 검증하고 최종 검토 결과 보고서를 작성하는 업무" },
      { ...taskFixture("second", { ...diagnosis, informationSufficiency: "needs-check" as const, followUpQuestions: ["입력 자료를 확인해주세요"] }), status: "needs-info" as const },
      taskFixture("third", { ...diagnosis, decisionGate: { verdict: "no-go" as const, reasons: ["접근 불가"] } }),
      taskFixture("registered"),
    ];
    // Raw IndexedDB writes bypass saveAxState validation. Reject invalid fixtures
    // here instead of mistaking the storage-protection screen for a layout failure.
    const seeded = axStateV2Schema.parse({ ...emptyAxState(), tasks, selectedTaskId: "long", step: 4 });
    await page.goto("/");
    await page.evaluate(async value => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("worklens-ax", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("state");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(value, "current");
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      }); db.close();
    }, seeded);
    await navigateWorkspace(page, "업무 자동화 진단");
    await expect(page.locator(".ax-report-intro h2")).toHaveText(tasks[0].name);
    const ranks = await page.locator(".ax-result-task-panel .ax-rank").allTextContents();
    const counts = diagnosisCounts(tasks);
    await expect(page.locator(".ax-kpi > strong")).toHaveText(["4개", `${counts.results}개`]);
    const initialSections = await page.locator(".ax-selected-report section[aria-label]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
    expect(initialSections).toEqual(expect.arrayContaining(["구현 계획", "완료 기준"]));
    await expect(page.getByRole("heading", { name: "올인원 지시문", exact: true })).toBeVisible();
    const measurements = await page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      };
      const panel = rect(".ax-result-task-panel"), cards = rect(".ax-step4-content .ax-kpi-cards"), detail = rect(".ax-selected-report");
      const rows = [...document.querySelectorAll(".ax-result-task-panel li")].map(node => {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        const button = node.querySelector("button")!, badge = node.querySelector(".ax-rank")!, name = node.querySelector(".ax-task-name")!;
        const b = button.getBoundingClientRect(), n = name.getBoundingClientRect(), r = badge.getBoundingClientRect();
        return { height: box.height, borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth,
          separatorInset: box.x - panel.x, separatorRightInset: panel.right - box.right,
          gap: n.x - r.right, contained: n.right <= b.right && n.x >= r.right,
          name: name.textContent, nameWidth: n.width, nameHeight: n.height,
          nameLineHeight: parseFloat(getComputedStyle(name).lineHeight),
          alignment: getComputedStyle(button).justifyContent, background: getComputedStyle(button).backgroundColor,
          selected: button.getAttribute("aria-pressed") === "true", highlightInsetTop: b.y - box.y };
      });
      return { viewport: { width: innerWidth, height: innerHeight }, panel, cards, detail,
        columns: [...document.querySelectorAll(".ax-kpi")].map(node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, width: b.width, height: b.height, padding: getComputedStyle(node).padding, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; }),
        topDifference: Math.abs(panel.y - cards.y), leftRatio: panel.width / (panel.width + cards.width),
        gap: cards.x - panel.right, scrollWidth: document.documentElement.scrollWidth, rows };
    });
    await writeFile(testInfo.outputPath("measurements.json"), JSON.stringify(measurements, null, 2));
    expect(measurements.scrollWidth).toBe(width);
    expect(measurements.columns[0].y).toBe(measurements.columns[1].y);
    expect(measurements.columns[0].width).toBeCloseTo(measurements.columns[1].width, 1);
    expect(measurements.columns[0].height).toBe(measurements.columns[1].height);
    expect(measurements.columns[0].padding).toBe(measurements.columns[1].padding);
    expect(measurements.columns[0].right).toBeLessThan(measurements.columns[1].x);
    for (const column of measurements.columns) expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth);
    const longName = measurements.rows.find(row => row.name === tasks[0].name)!;
    expect(longName.nameHeight / longName.nameLineHeight).toBeGreaterThanOrEqual(2);
    expect(measurements.cards.x).toBe(measurements.detail.x);
    if (width === 1440) {
      expect(measurements.topDifference).toBeLessThanOrEqual(1);
      expect(measurements.leftRatio).toBeGreaterThanOrEqual(0.30);
      expect(measurements.leftRatio).toBeLessThanOrEqual(0.35);
      expect(measurements.gap).toBe(24);
    } else {
      expect(measurements.panel.bottom).toBeLessThanOrEqual(measurements.cards.y);
      expect(measurements.cards.bottom).toBeLessThan(measurements.detail.y);
      expect(measurements.panel.x).toBe(measurements.cards.x);
    }
    for (const [index, row] of measurements.rows.entries()) {
      expect(row.borderTop).toBe(index === 0 ? "0px" : "1px");
      expect(row.borderBottom).toBe("0px");
      expect(row.separatorInset).toBeGreaterThan(16); expect(row.separatorRightInset).toBeGreaterThan(16);
      expect(row.gap).toBeGreaterThanOrEqual(12); expect(row.contained).toBe(true);
      expect(row.alignment).toBe("flex-start"); expect(row.highlightInsetTop).toBeGreaterThanOrEqual(4);
      expect(Math.abs(row.height - measurements.rows[0].height)).toBeLessThanOrEqual(1);
    }
    expect(measurements.rows.find(row => row.selected)!.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: testInfo.outputPath("layout.png"), fullPage: true });
    for (const task of tasks.filter(task => task.diagnosis)) {
      await page.locator(".ax-result-task-panel button").filter({ hasText: task.name }).click();
      await expect(page.locator(".ax-report-intro h2")).toHaveText(task.name);
      await expect(page.locator(".ax-result-task-panel .ax-rank")).toHaveText(ranks);
    }
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    const persisted = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("worklens-ax", 1); r.onsuccess = () => resolve(r.result); });
      const result = await new Promise<AxStateV2>(resolve => { const r = db.transaction("state").objectStore("state").get("current"); r.onsuccess = () => resolve(r.result); }); db.close(); return result;
    });
    expect(persisted.tasks).toEqual(tasks);
    expect(errors).toEqual([]);
  });
}
