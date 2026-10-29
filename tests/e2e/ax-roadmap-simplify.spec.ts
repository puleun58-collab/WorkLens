import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis } from "../../src/lib/ax/types";

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
}
async function seed(page: Page, value: unknown) {
  await page.evaluate(async record => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(record, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, value);
}
async function openStep4(page: Page, tasks: ReturnType<typeof taskFixture>[], selectedId: string) {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: selectedId, step: 4 });
  await ax(page);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  return page.getByRole("region", { name: "자동화 구현 계획", exact: true });
}
function mockPlan(page: Page) {
  return page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: diagnosisFixture } }) });
  });
}

test("AX roadmap simplify: KPI 2개 · 통합 목록 · 제거 영역 부재 · ①/②/④", async ({ page }) => {
  await mockPlan(page);
  const task = taskFixture("simplify-main", diagnosisFixture);
  const plan = await openStep4(page, [task], task.id);
  // 상단 통계는 등록 업무·진단 완료 2개만 표시한다.
  await expect(page.locator(".ax-kpi")).toHaveCount(2);
  await expect(page.locator(".ax-kpi", { hasText: "등록 업무" }).locator("strong")).toHaveText("1개");
  await expect(page.locator(".ax-kpi", { hasText: "진단 완료" }).locator("strong")).toHaveText("1개");
  // 업무 목록은 통합됐고 '전체 업무 보기'는 없다.
  await expect(page.getByRole("button", { name: "전체 업무 보기", exact: true })).toHaveCount(0);
  const list = page.getByRole("list", { name: "업무 목록", exact: true });
  await expect(list.locator("li .ax-task-name")).toHaveCount(1);
  // 제거된 영역은 표시되지 않는다.
  await expect(page.getByRole("region", { name: "진단 요약", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "실행 로드맵", exact: true })).toHaveCount(0);
  await expect(page.getByText("업무 단계 상세", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "01 구현 범위", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "02 구현 전 확인사항", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "03 완료 기준", exact: true })).toHaveCount(0);
  // 한 줄 요약 헤더: 업무명·Level·상태가 함께 보인다.
  const intro = page.locator(".ax-selected-report .ax-report-intro");
  await expect(intro).toContainText(task.name);
  // ① 미완료 항목만 표시되고, ② 범위·기준 요약이 보인다.
  const pre = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(pre).toBeVisible();
  await expect(pre.getByRole("button", { name: "업무 진단에서 확인", exact: true }).first()).toBeVisible();
  const summary = plan.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
  await expect(summary).toBeVisible();
  await expect(summary.locator('[data-scope-group="criteria"]')).toBeVisible();
  // ④ 생성·보기·복사 버튼이 동작한다.
  await expect(plan.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
  await plan.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(plan.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  await plan.getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect(plan.locator(".ax-prompt")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("AX roadmap simplify: 필수 확인 0건이면 짧은 안내만 표시", async ({ page }) => {
  // D1·D2·D3·D7 전부 '해당 없음'이면 업무 처리 예시는 권장 대상이 되어 ① 항목이 붙지 않는다.
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    decisionGate: { verdict: "go", reasons: [] },
    technicalChecks: [{ topic: "시스템 접근", status: "확인됨", note: "API 확인" }],
    decisionPoints: (["D1", "D2", "D3", "D7"] as const).map(id => ({ id, status: "해당 없음" as const })),
  };
  const task = taskFixture("simplify-empty", diagnosis);
  const plan = await openStep4(page, [task], task.id);
  const pre = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(pre).toContainText("현재 필수 확인 사항 없음");
  await expect(pre.getByText("시스템 접근", { exact: true })).toHaveCount(0);
});

test("AX roadmap simplify: 전체 Gate 차단이면 차단 사유만 표시하고 생성 불가", async ({ page }) => {
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    decisionGate: { verdict: "no-go", reasons: ["필수 시스템 접근 불가"] },
  };
  const task = taskFixture("simplify-blocked", diagnosis);
  const plan = await openStep4(page, [task], task.id);
  const pre = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(pre).toContainText("진행 보류");
  await expect(pre.getByText("필수 시스템 접근 불가", { exact: true })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeDisabled();
  await expect(plan.locator(".ax-prompt")).toHaveCount(0);
});

test("AX roadmap simplify: ① 이동 버튼은 업무 진단으로 이동하고 다른 업무 상태가 섞이지 않는다", async ({ page }) => {
  const diagnosisA: AxDiagnosis = { ...diagnosisFixture, technicalChecks: [{ topic: "A 전용 확인", status: "확인 필요", note: "A 확인" }] };
  const diagnosisB: AxDiagnosis = { ...diagnosisFixture, technicalChecks: [{ topic: "B 전용 확인", status: "확인 필요", note: "B 확인" }] };
  const taskA = taskFixture("simplify-a", diagnosisA);
  const taskB = taskFixture("simplify-b", diagnosisB);
  const plan = await openStep4(page, [taskA, taskB], taskA.id);
  const list = page.getByRole("list", { name: "업무 목록", exact: true });
  await list.getByRole("listitem").filter({ hasText: taskB.name }).getByRole("button").click();
  await expect(page.locator(".ax-report-intro h2")).toHaveText(taskB.name);
  const pre = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  await expect(pre).toContainText("B 전용 확인");
  await expect(pre).not.toContainText("A 전용 확인");
  // 이동 버튼은 업무 진단 탭으로 이동한다.
  await pre.getByRole("button", { name: "업무 진단에서 확인", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("AX roadmap simplify: 검토 표와 도구 동기화는 유지된다", async ({ page }) => {
  const diagnosis: AxDiagnosis = {
    ...diagnosisFixture,
    planCodex: { ...planFixture, implementation: ["Codex 전용 항목"] },
    planClaude: { ...planFixture, implementation: ["Claude 전용 항목"] },
  };
  const task = taskFixture("simplify-review", diagnosis);
  const plan = await openStep4(page, [task], task.id);
  const review = plan.getByRole("region", { name: "구현 계획 검토", exact: true });
  await expect(review).toBeVisible();
  await plan.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(plan.locator(".ax-prompt")).toContainText("Claude 전용 항목");
  await expect(plan.locator(".ax-prompt")).not.toContainText("Codex 전용 항목");
  await plan.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(plan.locator(".ax-prompt")).toContainText("Codex 전용 항목");
});

test("AX roadmap simplify: 모바일 390px 구조", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const task = taskFixture("simplify-mobile", diagnosisFixture);
  const plan = await openStep4(page, [task], task.id);
  await expect(page.locator(".ax-kpi")).toHaveCount(2);
  await expect(page.getByRole("list", { name: "업무 목록", exact: true })).toBeVisible();
  await expect(plan.getByRole("region", { name: "구현 전 확인", exact: true })).toBeVisible();
  await expect(plan.getByRole("region", { name: "구현 범위·완료 기준", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
