import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxDiagnosis, type AxTask } from "../../src/lib/ax/types";
import { exportAxState } from "../../src/lib/ax/transfer";

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
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
async function record(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<AxStateV2 | undefined>((resolve, reject) => {
      const request = db.transaction("state", "readonly").objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  });
}
async function importData(page: Page, state: AxStateV2) {
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
const clusterButton = (page: Page, count: number) => page.getByRole("button", { name: `해당 위치의 업무 ${count}건`, exact: true });
const clusterMenu = (page: Page, count: number) => page.getByRole("menu", { name: `해당 위치의 업무 ${count}건`, exact: true });
const taskList = (page: Page) => page.getByLabel("매트릭스 업무 목록", { exact: true });
const summaryHeading = (page: Page) => page.locator(".ax-matrix-detail").getByRole("heading").first();

test("One diagnosed task renders a numbered circle with accessible priority and restores its selection", async ({ page }) => {
  const task = clusterTask("only");
  await openCase(page, [task]);
  const marker = page.locator(".ax-bubble");
  await expect(marker).toHaveCount(1);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(marker).toHaveText("1");
  await expect(marker.locator(".ax-bubble-dot")).toBeVisible();
  await expect(marker).toHaveAttribute("aria-label", new RegExp(`^${task.name} · 빠른 실행 후보 · 우선순위 1 · `));
  await expect(marker).toHaveAttribute("title", new RegExp(`^${task.name} · 빠른 실행 후보 · 우선순위 1 · `));
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await ax(page);
  await expect(marker).toHaveText("1");
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await expect(summaryHeading(page)).toContainText(task.name);
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
});

test("Five distinct coordinates remain five numbered, independently selectable circles", async ({ page }) => {
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
    const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${task.name} · .* · 우선순위 \\d+ · `) }));
    const label = await marker.getAttribute("aria-label");
    await expect(marker).toHaveText(label!.match(/우선순위 (\d+)/)![1]);
    await expect(marker).toHaveAttribute("title", new RegExp(`^${task.name} · .* · 우선순위 \\d+ · `));
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
  await expect(page.locator(".ax-bubble")).toHaveText(["1", "2", "3"]);
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
  const singleLabel = await page.locator(".ax-bubble").getAttribute("aria-label");
  await expect(page.locator(".ax-bubble")).toHaveText(singleLabel!.match(/우선순위 (\d+)/)![1]);
  const trigger = clusterButton(page, 2);
  await expect(trigger.locator(".ax-matrix-cluster-number")).toHaveText("2건");
  await trigger.click();
  const menu = clusterMenu(page, 2);
  await expect(menu.locator(".ax-matrix-cluster-count")).toHaveText("해당 위치의 업무 2건");
  // Raw factors, region and execution gate differ; final x/y still match.
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(menu.getByRole("menuitem").first()).toContainText(`#1`);
  await expect(menu.getByRole("menuitem").first()).toContainText(first.name);
  await expect(menu.getByRole("menuitem").nth(1)).toContainText(`#3`);
  await expect(menu.getByRole("menuitem").nth(1)).toContainText(second.name);
  await menu.getByRole("menuitem").nth(1).click();
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
  await expect(clusterButton(page, 3).locator(".ax-matrix-cluster-number")).toHaveText("3건");
  await expect(clusterButton(page, 2).locator(".ax-matrix-cluster-number")).toHaveText("2건");
  await expect(page.locator(".ax-bubble")).toHaveCount(0);
  await expect(taskList(page).getByRole("button")).toHaveCount(5);
  // 매트릭스 하단 TOP 3는 제거됨 — 좌측 목록이 전체 업무를 점수 순위 순으로 표시한다.
  const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
  await expect(matrixList.getByRole("listitem")).toHaveCount(5);
  await expect(matrixList.locator(".ax-task-name").nth(0)).toHaveText(/^1\. /);
  await expect(matrixList.locator(".ax-task-name").nth(1)).toHaveText(/^2\. /);
  await expect(matrixList.locator(".ax-task-name").nth(2)).toHaveText(/^3\. /);
  await clusterButton(page, 3).click();
  await expect(clusterMenu(page, 3).getByRole("menuitem")).toHaveCount(3);
  await clusterMenu(page, 3).getByRole("menuitem").last().click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[2].id);
  await expect(summaryHeading(page)).toContainText(tasks[2].name);
  await clusterButton(page, 2).click();
  await expect(clusterMenu(page, 2).getByRole("menuitem")).toHaveCount(2);
  await clusterMenu(page, 2).getByRole("menuitem").last().click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[4].id);
  await expect(summaryHeading(page)).toContainText(tasks[4].name);
  await expect(clusterButton(page, 3)).toHaveAttribute("data-selected", "false");
  await expect(clusterButton(page, 2)).toHaveAttribute("data-selected", "true");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-kpi").filter({ hasText: "진단 완료" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-report-intro h2")).toHaveText(tasks[4].name);
});

test("Case D: factor correction splits a cluster and AI reset restores it without stale popup", async ({ page }) => {
  const first = clusterTask("factor-a"), second = clusterTask("factor-b");
  await openCase(page, [first, second]);
  await clusterButton(page, 2).click();
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(clusterMenu(page, 2)).not.toBeVisible();
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(2);
  await expect(page.locator(".ax-bubble")).toHaveText(["1", "2"]);
  await expect(summaryHeading(page)).toContainText(first.name);
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true }).first().click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(clusterButton(page, 2)).toBeVisible();
  await expect(clusterButton(page, 2).locator(".ax-matrix-cluster-number")).toHaveText("2건");
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
  await expect(page.locator(".ax-bubble")).toHaveText("1");
  await expect(page.locator(".ax-bubble")).toHaveAttribute("aria-label", new RegExp(`^${first.name} ·`));
  await expect(page.locator(".ax-bubble")).toHaveAttribute("title", new RegExp(`^${first.name} · .* · 우선순위 1 · `));
  await importData(page, { ...emptyAxState(), tasks: [second], selectedTaskId: second.id, step: 3 });
  await expect(taskList(page).getByRole("button")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveAttribute("aria-label", new RegExp(`^${second.name} ·`));
  await expect(page.locator(".ax-bubble")).toHaveText("1");
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
  await expect(trigger.locator(".ax-matrix-cluster-number")).toHaveText("100건");
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".ax-matrix-cluster-count")).toHaveText("해당 위치의 업무 100건");
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

test("Cluster popup widens, keeps long names on one line with ellipsis and puts the gate badge on the second row", async ({ page }) => {
  const longName = "시설 보수 요청 검토 및 업체 선정과 사후 점검 결과 보고까지 포함하는 아주 긴 업무 이름";
  const first = { ...clusterTask("long-a"), name: longName };
  const second = clusterTask("long-b");
  await openCase(page, [first, second]);
  await clusterButton(page, 2).click();
  const menu = clusterMenu(page, 2);
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.width).toBeGreaterThan(400);
  expect(menuBox.width).toBeLessThanOrEqual(460);
  const item = menu.getByRole("menuitem").first();
  const name = item.locator(".ax-matrix-cluster-name");
  await expect(name).toHaveText(longName);
  await expect(name).toHaveAttribute("title", longName);
  const nameMetrics = await name.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, rects: element.getClientRects().length }));
  expect(nameMetrics.scrollWidth).toBeGreaterThan(nameMetrics.clientWidth);
  expect(nameMetrics.rects).toBe(1);
  // 상태 배지는 업무명 아래 두 번째 행에 있고, 업무명 시작선(순위 열 뒤)에 맞춰 정렬된다.
  const nameBox = (await name.boundingBox())!;
  const badgeBox = (await item.locator(".ax-gate-badge").boundingBox())!;
  const metaBox = (await item.locator(".ax-matrix-cluster-meta").boundingBox())!;
  expect(badgeBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
  expect(Math.abs(metaBox.x - nameBox.x)).toBeLessThanOrEqual(1);
  // 항목 사이에만 구분선(팝업 테두리와 같은 토큰 색)이 있고 첫 항목 위에는 없다(첫 항목은 선택 강조 틴트).
  const tops = await menu.locator(".ax-matrix-cluster-item").evaluateAll(items => items.map(element => getComputedStyle(element).borderTopColor));
  const tokenBorder = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.borderTop = "1px solid var(--border)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return color;
  });
  expect(tops[1]).toBe(tokenBorder);
  expect(tops[0]).not.toBe(tokenBorder);
  // 점수·상태 영역을 클릭해도 같은 업무가 선택된다.
  await item.locator(".ax-gate-badge").click();
  await expect(menu).not.toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(first.id);
  await expect(summaryHeading(page)).toContainText(longName);
});

for (const [registered, diagnosed] of [[0, 0], [1, 0], [5, 3], [5, 5]]) test(`Matrix status counts ${registered}/${diagnosed}`, async ({ page }) => {
  const tasks = Array.from({ length: registered }, (_, index) => index < diagnosed ? clusterTask(`status-${index}`) : taskFixture(`pending-${index}`));
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0]?.id ?? null, step: 3 });
  await ax(page);
  const status = page.locator(".ax-matrix-header p");
  await expect(status).toContainText(`진단 완료 ${diagnosed}/${registered}`);
  await expect(status).not.toContainText("미진단");
  await expect(status).not.toContainText("등록 ");
  if (!diagnosed) await expect(page.locator(".ax-empty")).toBeVisible();
});
