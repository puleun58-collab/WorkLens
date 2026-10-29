import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxTask } from "../../src/lib/ax/types";
import { taskStatus } from "../../src/lib/ax/policy";

type Gate = "ready" | "conditional" | "blocked";
const LEVELS = { 2: [3, 3, 3, 3, 2, 2], 3: [4, 4, 4, 4, 2, 2] } as const;
function makeDiagnosis(level: keyof typeof LEVELS, gate: Gate, sufficiency: "sufficient" | "needs-check", adjust = false): AxDiagnosis {
  const diagnosis: AxDiagnosis = structuredClone(diagnosisFixture);
  diagnosis.factors = diagnosis.factors.map((factor, index) => {
    const aiValue = LEVELS[level][index];
    return adjust ? { ...factor, aiValue, finalValue: aiValue + 1 } : { ...factor, aiValue };
  });
  diagnosis.informationSufficiency = sufficiency;
  diagnosis.followUpQuestions = sufficiency === "needs-check" ? ["입력 자료 형식을 확인해 주세요"] : [];
  diagnosis.decisionGate = gate === "ready" ? { verdict: "go", reasons: [] } : gate === "conditional" ? { verdict: "conditional", reasons: ["권한 확인 후 진행"] } : { verdict: "no-go", reasons: ["필수 시스템 접근 불가"] };
  diagnosis.technicalChecks = gate === "ready" ? [{ topic: "시스템 접근", status: "확인됨", note: "권한 확인 완료" }] : [{ topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" }];
  return diagnosis;
}
function makeTask(id: string, name: string, diagnosis: AxDiagnosis): AxTask {
  const base = taskFixture(id, diagnosis);
  const withName = { ...base, name };
  return { ...withName, status: taskStatus(diagnosis) };
}
async function seedAndOpen(page: Page, tasks: AxTask[], step: number) {
  await page.goto("/");
  const state = { ...emptyAxState(), tasks, step, selectedTaskId: tasks[0]?.id ?? null };
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
}

test("scenario A: adjusted + needs-check shows both badges", async ({ page }) => {
  const task = makeTask("t1", "월간 정산", makeDiagnosis(3, "conditional", "needs-check", true));
  expect(task.status).toBe("adjusted");
  await seedAndOpen(page, [task], 2);
  const badges = page.locator(".ax-diag-card .ax-diag-badges");
  await expect(badges.locator(".ax-status-badge", { hasText: "사용자 보정 완료" })).toBeVisible();
  await expect(badges.locator(".ax-status-badge", { hasText: "정보 확인 필요" })).toBeVisible();
  const row = page.locator(".ax-task-rows .ax-task-meta").first();
  await expect(row).toContainText("사용자 보정 완료 · 추가 질문 필요");
});

test("scenario B: KPI and unified list for ready 1 + conditional 2", async ({ page }) => {
  const tasks = [
    makeTask("r1", "업무 A", makeDiagnosis(3, "ready", "sufficient")),
    makeTask("c1", "업무 B", makeDiagnosis(3, "conditional", "sufficient")),
  ];
  await seedAndOpen(page, tasks, 4);
  // 상단 통계는 등록 업무·진단 완료 2개만 표시한다.
  await expect(page.locator(".ax-kpi")).toHaveCount(2);
  await expect(page.locator(".ax-kpi", { hasText: "등록 업무" }).locator("strong")).toHaveText("2개");
  await expect(page.locator(".ax-kpi", { hasText: "진단 완료" }).locator("strong")).toHaveText("2개");
  await expect(page.getByRole("heading", { name: "업무 목록 (2)", exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "업무 목록", exact: true });
  await expect(list.locator(".ax-task-name")).toHaveText(["업무 A", "업무 B"]);
});

test("scenario C: no-change registration edit preserves diagnosis", async ({ page }) => {
  const diagnosis = makeDiagnosis(3, "ready", "sufficient", true);
  const task = makeTask("t1", "월간 정산", diagnosis);
  await seedAndOpen(page, [{ ...task, cycle: "매월", minutesPerRun: 240 }], 2);
  await page.getByRole("button", { name: "등록 정보 수정", exact: true }).click();
  await page.getByRole("button", { name: "수정 등록", exact: true }).click();
  await expect(page.getByText("변경된 내용이 없습니다.")).toBeVisible();
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await page.waitForTimeout(500);
  const badges = page.locator(".ax-diag-card .ax-diag-badges");
  await expect(badges.locator(".ax-status-badge", { hasText: "사용자 보정 완료" })).toBeVisible();
  await expect(badges.locator(".ax-status-badge", { hasText: "정보 확인 필요" })).toHaveCount(0);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  const badges2 = page.locator(".ax-diag-card .ax-diag-badges");
  await expect(badges2.locator(".ax-status-badge", { hasText: "사용자 보정 완료" })).toBeVisible();
});

test("scenario E: long task names keep badge alignment without overflow", async ({ page }) => {
  if (process.env.E2E_MOBILE === "1") await page.setViewportSize({ width: 390, height: 844 });
  const long = "월간 정산 업무를 위한 엑셀 데이터 정리 및 보고서 작성 자동화 절차 검토";
  const noSpace = "월간정산업무를위한엑셀데이터정리및보고서작성자동화절차검토";
  await seedAndOpen(page, [makeTask("t1", long, makeDiagnosis(3, "conditional", "needs-check", true)), makeTask("t2", noSpace, makeDiagnosis(2, "ready", "sufficient", true))], 4);
  const full = page.getByRole("list", { name: "업무 목록", exact: true });
  for (const prefix of [long.slice(0, 6), noSpace.slice(0, 6)]) {
    await full.locator(".ax-task-name", { hasText: prefix }).click();
    const title = page.locator(".ax-report-intro .ax-title-group h2");
    const badge = page.locator(".ax-report-intro .ax-title-group .ax-status-badge");
    await expect(title).toContainText(prefix);
    // Wait for layout to stabilize: poll until badge is positioned without overlapping the title.
    // A single boundingBox() right after click can catch the layout mid-transition (flaky).
    await expect.poll(async () => {
      const t = await title.boundingBox(), b = await badge.boundingBox();
      if (!t || !b) return "missing";
      if (!(b.x >= t.x - 1 && b.y >= t.y - 1)) return "overlap";
      if (!(Math.abs(b.y - t.y) < 200)) return "far";
      return "ok";
    }, { timeout: 10000 }).toBe("ok");
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
