import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxTask } from "../../src/lib/ax/types";
import { automationLevel, executionGate, priority, taskStatus } from "../../src/lib/ax/policy";

type Gate = "ready" | "conditional" | "blocked";
const LEVELS = { 0: [2, 2, 2, 5, 1, 1], 2: [3, 3, 3, 3, 2, 2], 3: [4, 4, 4, 4, 2, 2] } as const;
function task(id: string, level: keyof typeof LEVELS, gate: Gate): AxTask {
  const diagnosis: AxDiagnosis = structuredClone(diagnosisFixture);
  diagnosis.factors = diagnosis.factors.map((factor, index) => ({ ...factor, aiValue: LEVELS[level][index] }));
  diagnosis.decisionGate = gate === "ready" ? { verdict: "go", reasons: [] } : gate === "conditional" ? { verdict: "conditional", reasons: ["권한 확인 후 진행"] } : { verdict: "no-go", reasons: ["필수 시스템 접근 불가"] };
  diagnosis.technicalChecks = gate === "ready" ? [{ topic: "시스템 접근", status: "확인됨", note: "권한 확인 완료" }] : [{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }];
  expect(automationLevel(diagnosis).level).toBe(level);
  expect(executionGate(diagnosis)).toBe(gate);
  return { ...taskFixture(id, diagnosis), status: taskStatus(diagnosis) };
}
async function openState(page: Page, tasks: AxTask[]) {
  await page.goto("/");
  const state = { ...emptyAxState(), tasks, step: 4, selectedTaskId: tasks[0]?.id ?? null };
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
  }, state);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tab", { name: "결과·로드맵", exact: true })).toHaveAttribute("data-active", "");
}
const scenarios = [
  { name: "one ready excludes two conditional even with only three total", tasks: [task("conditional-a", 3, "conditional"), task("ready", 2, "ready"), task("conditional-b", 3, "conditional")] },
  { name: "two ready exclude three blocked", tasks: [task("blocked-a", 3, "blocked"), task("ready-a", 2, "ready"), task("blocked-b", 3, "blocked"), task("ready-b", 2, "ready"), task("blocked-c", 3, "blocked")] },
  { name: "conditional review excludes blocked and level zero", tasks: [task("blocked", 3, "blocked"), task("conditional", 2, "conditional"), task("manual", 0, "ready")] },
  { name: "all blocked remain neutral review", tasks: [task("blocked-a", 3, "blocked"), task("blocked-b", 3, "blocked")] },
  { name: "level zero is review rather than execution", tasks: [task("manual", 0, "ready")] },
  { name: "equal ready scores preserve original rank and cap at three", tasks: [task("first", 2, "ready"), task("second", 2, "ready"), task("third", 2, "ready"), task("fourth", 2, "ready")] },
];
for (const scenario of scenarios) {
  test(`AX overview ${scenario.name}`, async ({ page }) => {
    await openState(page, scenario.tasks);
    // 통합 목록에는 전체 업무가 한 번씩 표시되고, 우선순위 번호가 유지된다.
    await expect(page.getByRole("heading", { name: `업무 목록 (${scenario.tasks.length})`, exact: true })).toBeVisible();
    const list = page.getByRole("list", { name: "업무 목록", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(scenario.tasks.length);
    const ranked = priority(scenario.tasks);
    for (const row of ranked) {
      const item = list.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${row.task.name}$`) }) });
      await expect(item).toHaveCount(1);
      await expect(item.locator(".ax-rank")).toHaveText(`#${ranked.findIndex(entry => entry.task.id === row.task.id) + 1}`);
    }
    await expect(page.getByRole("button", { name: "전체 업무 보기", exact: true })).toHaveCount(0);
    const target = ranked[ranked.length - 1];
    await list.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${target.task.name}$`) }) }).getByRole("button").click();
    await expect(page.locator(".ax-report-intro h2")).toHaveText(target.task.name);
    await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
    // 매트릭스 하단 TOP 3는 제거됨 — 좌측 목록 전체가 종합 점수 순위 순으로 표시되는지 확인한다.
    const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
    await expect(matrixList.getByRole("listitem")).toHaveCount(scenario.tasks.length);
    // §6 우측 목록: 순번은 별도 열, 업무명은 순번 없이 표시한다.
    await expect(matrixList.locator(".ax-matrix-rank")).toHaveText(ranked.map((_, index) => `${index + 1}`));
    await expect(matrixList.locator(".ax-task-name")).toHaveText(ranked.map(row => row.task.name));
  });
}
test("AX result count distinguishes needs-info from completed diagnosis with the same matrix definition", async ({ page }) => {
  const completed = task("completed", 2, "ready");
  const needsInfo = task("needs-info", 2, "conditional");
  needsInfo.diagnosis!.informationSufficiency = "needs-check";
  needsInfo.diagnosis!.followUpQuestions = ["입력 자료와 권한을 확인해 주세요"];
  needsInfo.status = taskStatus(needsInfo.diagnosis);
  expect(needsInfo.status).toBe("needs-info");
  await openState(page, [completed, needsInfo, taskFixture("registered")]);
  const kpi = page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) });
  await expect(kpi.locator("strong")).toHaveText("2개");
  await expect(kpi).toContainText("진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-header")).toContainText("진단 완료 2/3 · 진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 업무 1개");
  await expect(page.getByLabel("매트릭스 업무 목록", { exact: true }).getByRole("listitem")).toHaveCount(2);
  // 우측 매트릭스 목록에서는 정보 확인 필요 배지를 표시하지 않고(§6), 상단 바로가기로
  // 업무 진단 단계의 추가 질문 영역까지 이동한다. 정보 확인 필요 여부는 상단 집계에서 확인한다.
  const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
  const needsRow = matrixList.getByRole("listitem").filter({ hasText: needsInfo.name });
  await expect(needsRow.locator(".ax-needs-check-badge")).toHaveCount(0);
  await expect(needsRow.locator(".ax-gate-badge")).toHaveCount(0);
  await expect(needsRow.locator(".ax-gate-dot")).toHaveAttribute("data-gate", "conditional");
  await expect(matrixList.getByRole("listitem").filter({ hasText: completed.name }).locator(".ax-needs-check-badge")).toHaveCount(0);
  await page.locator(".ax-matrix-counts").getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(needsInfo.name);
  await expect(page.locator("#ax-answer-section")).toBeVisible();
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await expect(page.locator(".ax-task-rows").getByRole("listitem").filter({ hasText: needsInfo.name })).toContainText("정보 확인 필요");
});

test("AX adjusted diagnosis still counts as needing information when core information is missing", async ({ page }) => {
  const adjusted = task("adjusted-needs-check", 2, "conditional");
  adjusted.diagnosis!.informationSufficiency = "needs-check";
  adjusted.diagnosis!.followUpQuestions = ["입력 자료와 권한을 확인해 주세요"];
  adjusted.diagnosis!.factors[0].finalValue = 4;
  adjusted.status = taskStatus(adjusted.diagnosis);
  expect(adjusted.status).toBe("adjusted");
  await openState(page, [task("completed", 2, "ready"), adjusted]);
  const kpi = page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) });
  await expect(kpi.locator("strong")).toHaveText("2개");
  await expect(kpi).toContainText("진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-header")).toContainText("진단 완료 2/2 · 진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await expect(page.locator(".ax-task-rows").getByRole("listitem").filter({ hasText: adjusted.name })).toContainText("사용자 보정 완료");
});
