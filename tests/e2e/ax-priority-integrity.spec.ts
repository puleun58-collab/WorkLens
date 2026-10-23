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
  { name: "one ready excludes two conditional even with only three total", tasks: [task("conditional-a", 3, "conditional"), task("ready", 2, "ready"), task("conditional-b", 3, "conditional")], ids: ["ready"], heading: "자동화 우선순위 TOP 1", top: true },
  { name: "two ready exclude three blocked", tasks: [task("blocked-a", 3, "blocked"), task("ready-a", 2, "ready"), task("blocked-b", 3, "blocked"), task("ready-b", 2, "ready"), task("blocked-c", 3, "blocked")], ids: ["ready-a", "ready-b"], heading: "자동화 우선순위 TOP 2", top: true },
  { name: "conditional review excludes blocked and level zero", tasks: [task("blocked", 3, "blocked"), task("conditional", 2, "conditional"), task("manual", 0, "ready")], ids: ["conditional"], heading: "확인 후 진행 업무", top: false },
  { name: "all blocked remain neutral review", tasks: [task("blocked-a", 3, "blocked"), task("blocked-b", 3, "blocked")], ids: ["blocked-a", "blocked-b"], heading: "현재 검토 업무", top: false },
  { name: "level zero is review rather than execution", tasks: [task("manual", 0, "ready")], ids: ["manual"], heading: "업무 진단 결과", top: false },
  { name: "equal ready scores preserve original rank and cap at three", tasks: [task("first", 2, "ready"), task("second", 2, "ready"), task("third", 2, "ready"), task("fourth", 2, "ready")], ids: ["first", "second", "third"], heading: "자동화 우선순위 TOP 3", top: true },
];
for (const scenario of scenarios) {
  test(`AX overview ${scenario.name}`, async ({ page }) => {
    await openState(page, scenario.tasks);
    await expect(page.getByRole("heading", { name: scenario.heading, exact: true })).toBeVisible();
    const overview = page.getByRole("list", { name: scenario.top ? "자동화 우선순위 TOP 목록" : "우선 확인 업무 목록", exact: true });
    await expect(overview.locator(".ax-task-name")).toHaveText(scenario.ids.map(id => `업무 ${id}`));
    const ranked = priority(scenario.tasks);
    await expect(overview.locator(".ax-rank")).toHaveText(scenario.ids.map(id => `#${ranked.findIndex(row => row.task.id === id) + 1}`));
    if (!scenario.top) await expect(page.getByRole("list", { name: "자동화 우선순위 TOP 목록", exact: true })).toHaveCount(0);
    const all = page.getByRole("button", { name: "전체 업무 보기", exact: true });
    if (scenario.tasks.length > scenario.ids.length) {
      await expect(all).toBeVisible();
      await all.click();
      const full = page.getByRole("list", { name: "전체 진단 업무 목록", exact: true });
      await expect(full.getByRole("listitem")).toHaveCount(scenario.tasks.length);
      for (const row of ranked) await expect(full.locator(".ax-task-name").filter({ hasText: new RegExp(`^${row.task.name}$`) })).toHaveCount(1);
      const excluded = scenario.tasks.find(task => !scenario.ids.includes(task.id))!;
      await full.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${excluded.name}$`) }) }).getByRole("button").click();
      await expect(page.locator(".ax-report-intro h2")).toHaveText(excluded.name);
    } else await expect(all).toHaveCount(0);
    await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
    // 매트릭스 하단 TOP 3는 제거됨 — 좌측 목록 전체가 종합 점수 순위 순으로 표시되는지 확인한다.
    const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
    await expect(matrixList.getByRole("listitem")).toHaveCount(scenario.tasks.length);
    await expect(matrixList.locator(".ax-task-name")).toHaveText(ranked.map((row, index) => `${index + 1}. ${row.task.name}`));
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
  await expect(kpi).toContainText("진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 1건");
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-header")).toContainText("진단 완료 2/3 · 진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 1건");
  await expect(page.getByLabel("매트릭스 업무 목록", { exact: true }).getByRole("listitem")).toHaveCount(2);
  // 좌측 매트릭스 목록에서 정보 확인 필요 업무만 구분 표시되고, 상단 바로가기로 업무 진단 단계의 추가 질문 영역까지 이동한다.
  const matrixList = page.getByLabel("매트릭스 업무 목록", { exact: true });
  await expect(matrixList.getByRole("listitem").filter({ hasText: needsInfo.name }).locator(".ax-needs-check-badge")).toHaveText("정보 확인 필요");
  await expect(matrixList.getByRole("listitem").filter({ hasText: completed.name }).locator(".ax-needs-check-badge")).toHaveCount(0);
  await page.locator(".ax-matrix-counts").getByRole("button", { name: "정보 확인 필요 1건", exact: true }).click();
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
  await expect(kpi).toContainText("진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 1건");
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(page.locator(".ax-matrix-header")).toContainText("진단 완료 2/2 · 진행 가능 1 · 확인 후 진행 1 · 정보 확인 필요 1건");
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await expect(page.locator(".ax-task-rows").getByRole("listitem").filter({ hasText: adjusted.name })).toContainText("사용자 보정 완료");
});
