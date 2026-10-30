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
const groupPanel = (page: Page, count: number) => page.getByRole("region", { name: `선택 좌표의 업무 ${count}건`, exact: true });
const taskList = (page: Page) => page.getByLabel("매트릭스 업무 목록", { exact: true });
// 매트릭스 상세 카드는 §9로 제거됨 — 선택 확인은 우측 목록 행의 aria-pressed로 한다.
const selectedListRow = (page: Page, name: string) => taskList(page).getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

test("One diagnosed task renders a small gate dot with accessible priority and restores its selection", async ({ page }) => {
  const task = clusterTask("only");
  await openCase(page, [task]);
  const marker = page.locator(".ax-bubble");
  await expect(marker).toHaveCount(1);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  // 단일 마커는 균일한 작은 점이다: 순위 숫자는 목록에만 표시된다.
  await expect(marker).toHaveText("");
  await expect(marker.locator(".ax-bubble-dot")).toBeVisible();
  await expect(marker.locator(".ax-bubble-dot")).toHaveAttribute("data-gate", "conditional");
  await expect(marker).toHaveAttribute("aria-label", new RegExp(`^${task.name} · 빠른 실행 후보 · 우선순위 1 · `));
  await expect(marker).toHaveAttribute("title", new RegExp(`^${task.name} · 빠른 실행 후보 · 우선순위 1 · `));
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ax-matrix-detail")).toHaveCount(0);
  await page.reload();
  await ax(page);
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await expect(selectedListRow(page, task.name)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
});

test("Five distinct coordinates remain five dots, independently selectable", async ({ page }) => {
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
    await expect(marker).toHaveAttribute("title", new RegExp(`^${task.name} · .* · 우선순위 \\d+ · `));
    await marker.click();
    await expect(marker).toHaveAttribute("aria-pressed", "true");
    await expect(selectedListRow(page, task.name)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
  }
});

test("Case A: three distinct final coordinates remain independently selectable singles", async ({ page }) => {
  const tasks = [clusterTask("single-a"), clusterTask("single-b", { systemAccess: 1 }), clusterTask("single-c", { repetition: 1 })];
  await openCase(page, tasks);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(3);
  for (const task of tasks) {
    const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${task.name} ·`) }));
    await marker.click();
    await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(task.id);
    await expect(marker).toHaveAttribute("aria-pressed", "true");
    await expect(selectedListRow(page, task.name)).toHaveAttribute("aria-pressed", "true");
  }
});

test("Case B: two equal renderer coordinates form one cluster beside one single", async ({ page }) => {
  const first = clusterTask("pair-a"), second = clusterTask("pair-b", { repetition: 5, operationalRisk: 4 });
  const single = clusterTask("separate", { systemAccess: 1 });
  await openCase(page, [first, second, single]);
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveCount(1);
  const trigger = clusterButton(page, 2);
  await expect(trigger.locator(".ax-matrix-cluster-number")).toHaveText("2건");
  // 그룹 마커에는 단일 Gate 색상을 쓰지 않는다(혼합 그룹 오인 방지).
  await expect(trigger).not.toHaveAttribute("data-gate", /./);
  await trigger.click();
  const panel = groupPanel(page, 2);
  await expect(panel.getByRole("heading")).toHaveText("선택 좌표의 업무 2건");
  await expect(panel.locator("p")).toContainText("가치 4 · 실현 4");
  // Raw factors, region and execution gate differ; final x/y still match.
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  const firstRow = panel.locator("tbody tr").nth(0), secondRow = panel.locator("tbody tr").nth(1);
  await expect(firstRow.locator("td").nth(0)).toHaveText("1");
  await expect(firstRow.locator("td").nth(1)).toContainText(first.name);
  await expect(firstRow.locator("td").nth(2)).toContainText("고도 자동화 (Level 3)");
  await expect(secondRow.locator("td").nth(0)).toHaveText("3");
  await expect(secondRow.locator("td").nth(1)).toContainText(second.name);
  await expect(secondRow.locator("td").nth(2)).toContainText("부분 자동화 (Level 2)");
  for (const row of [firstRow, secondRow]) {
    await expect(row.locator("td").nth(3)).toContainText("확인 후 진행");
    await expect(row.locator(".ax-gate-dot")).toHaveAttribute("data-gate", "conditional");
  }
  // 표 행 클릭은 업무를 선택하되 표는 유지한다(팝업과 다름).
  await secondRow.getByRole("button", { name: second.name, exact: true }).click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(second.id);
  await expect(trigger).toHaveAttribute("data-selected", "true");
  await expect(selectedListRow(page, second.name)).toHaveAttribute("aria-pressed", "true");
  // 같은 마커 재클릭 시 표가 닫힌다.
  await trigger.click();
  await expect(panel).not.toBeVisible();
  await trigger.click();
  await expect(panel).toBeVisible();
  await taskList(page).getByRole("button", { name: new RegExp(single.name) }).click();
  await expect(panel).not.toBeVisible();
  await expect(trigger).toHaveAttribute("data-selected", "false");
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(single.id);
  await expect(selectedListRow(page, single.name)).toHaveAttribute("aria-pressed", "true");
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
  const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
  await expect(matrixList.getByRole("listitem")).toHaveCount(5);
  await expect(matrixList.locator(".ax-matrix-rank").nth(0)).toHaveText("1");
  await expect(matrixList.locator(".ax-matrix-rank").nth(1)).toHaveText("2");
  await expect(matrixList.locator(".ax-matrix-rank").nth(2)).toHaveText("3");
  await expect(matrixList.locator(".ax-task-name").nth(0)).toHaveText(tasks[0].name);
  await clusterButton(page, 3).click();
  await expect(groupPanel(page, 3).locator("tbody tr")).toHaveCount(3);
  await groupPanel(page, 3).locator("tbody tr").last().getByRole("button", { name: tasks[2].name, exact: true }).click();
  await expect(groupPanel(page, 3)).toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[2].id);
  await clusterButton(page, 2).click();
  await expect(groupPanel(page, 2).locator("tbody tr")).toHaveCount(2);
  await expect(groupPanel(page, 3)).toHaveCount(0);
  await groupPanel(page, 2).locator("tbody tr").last().getByRole("button", { name: tasks[4].name, exact: true }).click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[4].id);
  await expect(clusterButton(page, 3)).toHaveAttribute("data-selected", "false");
  await expect(clusterButton(page, 2)).toHaveAttribute("data-selected", "true");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-kpi").filter({ hasText: "등록 업무" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-kpi").filter({ hasText: "진단 완료" }).locator("strong")).toHaveText("5개");
  await expect(page.locator(".ax-report-intro h2")).toHaveText(tasks[4].name);
});

test("Case D: factor correction splits a cluster and AI reset restores it without stale panel", async ({ page }) => {
  const first = clusterTask("factor-a"), second = clusterTask("factor-b");
  await openCase(page, [first, second]);
  await clusterButton(page, 2).click();
  await expect(groupPanel(page, 2)).toBeVisible();
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(groupPanel(page, 2)).toHaveCount(0);
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(2);
  await expect(selectedListRow(page, first.name)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true }).first().click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(clusterButton(page, 2)).toBeVisible();
  await expect(clusterButton(page, 2).locator(".ax-matrix-cluster-number")).toHaveText("2건");
  await expect(groupPanel(page, 2)).toHaveCount(0);
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
  await expect(groupPanel(page, 2)).toBeVisible();
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await expect(groupPanel(page, 2)).toHaveCount(0);
  await page.getByLabel("등록 업무 목록", { exact: true }).locator("li").filter({ hasText: second.name }).getByRole("button", { name: "업무 삭제", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-cluster")).toHaveCount(0);
  await expect(page.locator(".ax-bubble")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveAttribute("aria-label", new RegExp(`^${first.name} ·`));
  await expect(page.locator(".ax-bubble")).toHaveAttribute("title", new RegExp(`^${first.name} · .* · 우선순위 1 · `));
  await importData(page, { ...emptyAxState(), tasks: [second], selectedTaskId: second.id, step: 3 });
  await expect(taskList(page).getByRole("button")).toHaveCount(1);
  await expect(page.locator(".ax-bubble")).toHaveAttribute("aria-label", new RegExp(`^${second.name} ·`));
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(second.id);
});

for (const width of [1440, 390]) test(`Case F: keyboard, Escape focus, outside/step close and full-width panel at ${width}px`, async ({ page }) => {
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
  const trigger = clusterButton(page, 100), panel = groupPanel(page, 100);
  await expect(trigger.locator(".ax-matrix-cluster-number")).toHaveText("100건");
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText("선택 좌표의 업무 100건");
  await expect(panel.locator("tbody tr")).toHaveCount(100);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible(); await expect(trigger).toBeFocused();
  await page.keyboard.press("Space"); await expect(panel).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/ax/cluster-100-${width}-${test.info().project.name}.png` });
  await page.getByRole("heading", { name: "자동화 매트릭스", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await trigger.click();
  await panel.locator("tbody tr").last().getByRole("button", { name: tasks[99].name, exact: true }).click();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(tasks[99].id);
  // 표 행 클릭은 표를 유지한다.
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(selectedListRow(page, tasks[99].name)).toHaveAttribute("aria-pressed", "true");
  await expect(trigger).toHaveAttribute("data-selected", "true");
});

test("Cluster panel keeps long names on one line with ellipsis and selects on row click", async ({ page }) => {
  const longName = "시설 보수 요청 검토 및 업체 선정과 사후 점검 결과 보고까지 포함하는 아주 긴 업무 이름";
  const first = { ...clusterTask("long-a"), name: longName };
  const second = clusterTask("long-b");
  await openCase(page, [first, second]);
  await clusterButton(page, 2).click();
  const panel = groupPanel(page, 2);
  await expect(panel).toBeVisible();
  const name = panel.locator("tbody tr").first().getByRole("button", { name: longName, exact: true });
  await expect(name).toHaveText(longName);
  await expect(name).toHaveAttribute("title", longName);
  const nameMetrics = await name.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, rects: element.getClientRects().length }));
  expect(nameMetrics.scrollWidth).toBeGreaterThan(nameMetrics.clientWidth);
  expect(nameMetrics.rects).toBe(1);
  const firstRow = panel.locator("tbody tr").first();
  await expect(firstRow.locator("td").nth(3)).toContainText("확인 후 진행");
  await expect(firstRow.locator(".ax-gate-dot")).toHaveAttribute("data-gate", "conditional");
  await expect(firstRow.locator("td").nth(4)).not.toBeEmpty();
  // 표 행 클릭은 같은 업무를 선택하고 표를 유지한다.
  await name.click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(first.id);
  await expect(selectedListRow(page, longName)).toHaveAttribute("aria-pressed", "true");
});

for (const [registered, diagnosed] of [[0, 0], [1, 0], [5, 3], [5, 5]]) test(`Matrix status counts ${registered}/${diagnosed}`, async ({ page }) => {
  const tasks = Array.from({ length: registered }, (_, index) => index < diagnosed ? clusterTask(`status-${index}`) : taskFixture(`pending-${index}`));
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0]?.id ?? null, step: 3 });
  await ax(page);
  const status = page.locator(".ax-matrix-counts");
  await expect(status).toContainText(`진단 완료 ${diagnosed}/${registered}`);
  await expect(status).not.toContainText("미진단");
  await expect(status).not.toContainText("등록 ");
  if (!diagnosed) await expect(page.locator(".ax-empty")).toBeVisible();
});
