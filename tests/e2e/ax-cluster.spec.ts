import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxState, type AxDiagnosis, type AxTask } from "../../src/lib/ax/types";
import { exportAxState } from "../../src/lib/ax/transfer";

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
async function seed(page: Page, value: AxState) {
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
async function record(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<AxState | undefined>((resolve, reject) => {
      const request = db.transaction("state", "readonly").objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  });
}
async function importData(page: Page, state: AxState) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
  await page.getByRole("menuitem", { name: "데이터 가져오기", exact: true }).click();
  await (await chooser).setFiles({ name: "clusters.json", mimeType: "application/json", buffer: Buffer.from(exportAxState(state)) });
  await page.getByRole("alertdialog").getByRole("button", { name: "덮어쓰기", exact: true }).click();
}
function clusterTask(id: string, adjustments: Partial<Record<AxDiagnosis["factors"][number]["key"], number>> = {}): AxTask {
  const diagnosis = structuredClone(diagnosisFixture);
  diagnosis.factors = diagnosis.factors.map(factor => ({ ...factor, aiValue: adjustments[factor.key] ?? factor.aiValue }));
  return { ...taskFixture(id, diagnosis), name: `Cluster ${id}` };
}
async function openCase(page: Page, tasks: AxTask[], selectedId = tasks[0].id) {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: selectedId, step: 3 });
  await ax(page);
}
const clusterButton = (page: Page, count: number) => page.getByRole("button", { name: `동일 위치의 업무 ${count}개`, exact: true });
const clusterMenu = (page: Page, count: number) => page.getByRole("menu", { name: `동일 위치의 업무 ${count}개`, exact: true });
const taskList = (page: Page) => page.getByLabel("매트릭스 업무 목록", { exact: true });
const summaryHeading = (page: Page) => page.locator(".ax-step3-main > section").last().getByRole("heading").first();

test("One diagnosed task renders an unnumbered circle with accessible priority and restores its selection", async ({ page }) => {
  const task = clusterTask("only");
  await openCase(page, [task]);
  const marker = page.locator(".ax-bubble");
  await expect(marker).toHaveCount(1);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(marker).toHaveText("");
  await expect(marker.locator(".ax-bubble-dot")).toBeVisible();
  await expect(marker).toHaveAttribute("aria-label", `${task.name} · 빠른 실행 후보 · 우선순위 1`);
  await expect(marker).toHaveAttribute("title", `${task.name} · 빠른 실행 후보 · 우선순위 1`);
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await ax(page);
  await expect(marker).toHaveText("");
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await expect(summaryHeading(page)).toContainText(task.name);
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
});

test("Five distinct coordinates remain five unnumbered, independently selectable circles", async ({ page }) => {
  const tasks = [
    clusterTask("five-a"),
    clusterTask("five-b", { systemAccess: 1 }),
    clusterTask("five-c", { repetition: 1 }),
    clusterTask("five-d", { regularity: 1 }),
    clusterTask("five-e", { regularity: 1, dataStructure: 1 }),
  ];
  await openCase(page, tasks);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(5);
  const coordinates = await page.locator(".ax-bubble").evaluateAll(markers =>
    markers.map(marker => `${(marker as HTMLElement).style.left},${(marker as HTMLElement).style.bottom}`));
  expect(new Set(coordinates).size).toBe(5);
  for (const task of tasks) {
    const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${task.name} · .* · 우선순위 \\d+$`) }));
    await expect(marker).toHaveText("");
    await expect(marker).toHaveAttribute("title", new RegExp(`^${task.name} · .* · 우선순위 \\d+$`));
    await marker.click();
    await expect(marker).toHaveAttribute("aria-pressed", "true");
    await expect(summaryHeading(page)).toContainText(task.name);
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
  }
});

test("Case A: three distinct final coordinates remain independently selectable singles", async ({ page }) => {
  const tasks = [clusterTask("single-a"), clusterTask("single-b", { systemAccess: 1 }), clusterTask("single-c", { repetition: 1 })];
  await openCase(page, tasks);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(3);
  await expect(page.locator(".ax-bubble")).toHaveText(["", "", ""]);
  for (const task of tasks) {
    const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${task.name} ·`) }));
    await marker.click();
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
    await expect(marker).toHaveAttribute("aria-pressed", "true");
    await expect(summaryHeading(page)).toContainText(task.name);
  }
});

test("Case B: two equal renderer coordinates form one cluster beside one single", async ({ page }) => {
  const first = clusterTask("pair-a"), second = clusterTask("pair-b", { repetition: 5, operationalRisk: 4 });
  const single = clusterTask("separate", { systemAccess: 1 });
  await openCase(page, [first, second, single]);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveText("");
  const trigger = clusterButton(page, 2);
  await expect(trigger.locator(".ax-matrix-cluster-number")).toHaveText("2");
  await trigger.click();
  const menu = clusterMenu(page, 2);
  await expect(menu.locator(".ax-matrix-cluster-count")).toHaveText("동일 위치의 업무 · 2개");
  // Raw factors, region and execution gate differ; final x/y still match.
  await expect(menu.getByRole("menuitem")).toHaveText([`#1${first.name}`, `#3${second.name}`]);
  await menu.getByRole("menuitem", { name: `#3 ${second.name}`, exact: true }).click();
  await expect(menu).not.toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(second.id);
  await expect(trigger).toHaveAttribute("data-selected", "true");
  await expect(summaryHeading(page)).toContainText(second.name);
  await trigger.click();
  await taskList(page).getByRole("button", { name: new RegExp(single.name) }).click();
  await expect(menu).not.toBeVisible();
  await expect(trigger).toHaveAttribute("data-selected", "false");
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(single.id);
  await expect(summaryHeading(page)).toContainText(single.name);
});

test("Case C: five tasks form three-member and two-member clusters without collapsing priority rows", async ({ page }) => {
  const tasks = [
    ...["triple-a", "triple-b", "triple-c"].map(id => clusterTask(id, { systemAccess: 1 })),
    ...["double-a", "double-b"].map(id => clusterTask(id, { repetition: 2, regularity: 2, dataStructure: 2, systemAccess: 2 })),
  ];
  await openCase(page, tasks);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(2);
  await expect(clusterButton(page, 3).locator(".ax-matrix-cluster-number")).toHaveText("3");
  await expect(clusterButton(page, 2).locator(".ax-matrix-cluster-number")).toHaveText("2");
  await expect(page.locator(".ax-bubble")).toHaveCount(0);
  await expect(taskList(page).getByRole("button")).toHaveCount(5);
  const priorities = page.getByRole("list", { name: "자동화 우선순위 목록", exact: true });
  await expect(priorities.getByRole("listitem")).toHaveCount(5);
  await expect(priorities.locator(".ax-rank")).toHaveText(["#1", "#2", "#3", "#4", "#5"]);
  await clusterButton(page, 3).click();
  await expect(clusterMenu(page, 3).getByRole("menuitem")).toHaveText(tasks.slice(0, 3).map((task, index) => `#${index + 1}${task.name}`));
  await clusterMenu(page, 3).getByRole("menuitem").last().click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[2].id);
  await expect(summaryHeading(page)).toContainText(tasks[2].name);
  await clusterButton(page, 2).click();
  await expect(clusterMenu(page, 2).getByRole("menuitem")).toHaveText(tasks.slice(3).map((task, index) => `#${index + 4}${task.name}`));
  await clusterMenu(page, 2).getByRole("menuitem").last().click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[4].id);
  await expect(summaryHeading(page)).toContainText(tasks[4].name);
  await expect(clusterButton(page, 3)).toHaveAttribute("data-selected", "false");
  await expect(clusterButton(page, 2)).toHaveAttribute("data-selected", "true");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-kpi").filter({ hasText: "진단 완료" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-roadmap-task")).toHaveText(tasks[4].name);
});

test("Case D: factor correction splits a cluster and AI reset restores it without stale popup", async ({ page }) => {
  const first = clusterTask("factor-a"), second = clusterTask("factor-b");
  await openCase(page, [first, second]);
  await clusterButton(page, 2).click();
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(clusterMenu(page, 2)).not.toBeVisible();
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(2);
  await expect(page.locator(".ax-bubble")).toHaveText(["", ""]);
  await expect(summaryHeading(page)).toContainText(first.name);
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true }).first().click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(clusterButton(page, 2)).toBeVisible();
  await expect(clusterButton(page, 2).locator(".ax-matrix-cluster-number")).toHaveText("2");
  await expect(clusterMenu(page, 2)).not.toBeVisible();
  await expect.poll(async () => (await record(page))?.tasks.find(task => task.id === first.id)?.diagnosis?.factors[0].finalValue).toBeUndefined();
});

test("Case E: rediagnosis, deletion and import replace grouping and membership", async ({ page }) => {
  const first = clusterTask("fresh-a"), second = clusterTask("fresh-b");
  await openCase(page, [first, second]);
  await page.route("**/api/ai", async route => {
    const output = outputFixture();
    output.factors = output.factors.map(factor => ({ ...factor, aiValue: factor.key === "systemAccess" ? 1 : factor.aiValue }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: output } }) });
  });
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "업무 다시 진단", exact: true }).click();
  await expect(page.getByRole("button", { name: "업무 다시 진단", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(2);
  await importData(page, { ...emptyAxState(), tasks: [first, second], selectedTaskId: first.id, step: 3 });
  await expect(clusterButton(page, 2)).toBeVisible();
  await clusterButton(page, 2).click();
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await page.getByLabel("등록 업무 목록", { exact: true }).locator("li").filter({ hasText: second.name }).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveText("");
  await expect(page.locator(".ax-bubble")).toHaveAttribute("aria-label", new RegExp(`^${first.name} ·`));
  await expect(page.locator(".ax-bubble")).toHaveAttribute("title", new RegExp(`^${first.name} · .* · 우선순위 1$`));
  await importData(page, { ...emptyAxState(), tasks: [second], selectedTaskId: second.id, step: 3 });
  await expect(taskList(page).getByRole("button")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveAttribute("aria-label", new RegExp(`^${second.name} ·`));
  await expect(page.locator(".ax-bubble")).toHaveText("");
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(second.id);
});

for (const width of [1440, 390]) test(`Case F: keyboard, Escape focus, outside/step close and maximum popup at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const tasks = Array.from({ length: 100 }, (_, index) => clusterTask(`max-${index + 1}`));
  await openCase(page, tasks);
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => { const range = document.createRange(); range.selectNodeContents(document.querySelector(selector)!); return range.getBoundingClientRect(); };
    const yTick = rect('.ax-y-tick[style*="50%"]'), xTick = rect('.ax-x-tick[style*="50%"]');
    const yTitle = rect(".ax-y-label"), xTitle = rect(".ax-x-label");
    return { yGap: yTick.x - yTitle.right, xGap: xTitle.y - xTick.bottom,
      yCenter: yTitle.y + yTitle.height / 2 - yTick.y - yTick.height / 2,
      xCenter: xTitle.x + xTitle.width / 2 - xTick.x - xTick.width / 2 };
  });
  for (const gap of [geometry.yGap, geometry.xGap]) { expect(gap).toBeGreaterThanOrEqual(12); expect(gap).toBeLessThanOrEqual(16); }
  expect(Math.abs(geometry.yCenter)).toBeLessThanOrEqual(2); expect(Math.abs(geometry.xCenter)).toBeLessThanOrEqual(2);
  const trigger = clusterButton(page, 100), menu = clusterMenu(page, 100);
  await expect(trigger.locator(".ax-matrix-cluster-circle")).toHaveCount(3);
  await expect(trigger.locator(".ax-matrix-cluster-number")).toHaveText("100");
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".ax-matrix-cluster-count")).toHaveText("동일 위치의 업무 · 100개");
  await expect(menu.getByRole("menuitem")).toHaveCount(100);
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible(); await expect(trigger).toBeFocused();
  await page.keyboard.press("Space"); await expect(menu).toBeVisible();
  const popupBox = (await menu.boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/ax/cluster-100-${width}-${test.info().project.name}.png` });
  await page.getByRole("heading", { name: "자동화 매트릭스", exact: true }).click();
  await expect(menu).not.toBeVisible();
  await trigger.click();
  await menu.getByRole("menuitem").last().click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[99].id);
  await expect(menu).not.toBeVisible(); await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(menu).not.toBeVisible();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(menu).not.toBeVisible();
  await expect(summaryHeading(page)).toContainText(tasks[99].name);
});

for (const [registered, diagnosed] of [[0, 0], [1, 0], [5, 3], [5, 5]]) test(`Matrix status counts ${registered}/${diagnosed}`, async ({ page }) => {
  const tasks = Array.from({ length: registered }, (_, index) => index < diagnosed ? clusterTask(`status-${index}`) : taskFixture(`pending-${index}`));
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0]?.id ?? null, step: 3 });
  await ax(page);
  const status = page.locator(".ax-matrix-header p");
  await expect(status).toContainText(`등록 ${registered}개 · 진단 완료 ${diagnosed}개`);
  if (registered > diagnosed) await expect(status).toContainText(`미진단 ${registered - diagnosed}개 제외`);
  else await expect(status).not.toContainText("미진단");
  if (!diagnosed) await expect(page.locator(".ax-empty")).toBeVisible();
});
