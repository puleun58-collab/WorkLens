import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTask } from "../../src/lib/ax/types";
import { taskStatus } from "../../src/lib/ax/policy";

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
function diagnosedTask(id: string, name: string): AxTask {
  const diagnosis = structuredClone(diagnosisFixture);
  return { ...taskFixture(id, diagnosis), name, status: taskStatus(diagnosis) };
}
function needsCheckTask(id: string, name: string, questions: string[]): AxTask {
  const diagnosis = structuredClone(diagnosisFixture);
  diagnosis.informationSufficiency = "needs-check";
  diagnosis.followUpQuestions = questions;
  return { ...taskFixture(id, diagnosis), name, status: taskStatus(diagnosis) };
}
async function openMatrix(page: Page, tasks: AxTask[]) {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step: 3 });
  await ax(page);
}
const counts = (page: Page) => page.locator(".ax-matrix-counts");
const matrixList = (page: Page) => page.getByLabel("매트릭스 업무 목록", { exact: true });

test("정보 확인 필요 0건이면 상단 집계에 바로가기가 표시되지 않는다", async ({ page }) => {
  await openMatrix(page, [diagnosedTask("ok-a", "업무 ok-a"), diagnosedTask("ok-b", "업무 ok-b")]);
  await expect(counts(page)).toContainText("진단 완료 2/2");
  await expect(counts(page)).not.toContainText("정보 확인 필요");
  await expect(counts(page).getByRole("button")).toHaveCount(0);
  await expect(matrixList(page).locator(".ax-needs-check-badge")).toHaveCount(0);
});

test("정보 확인 필요 업무 1개: 목록에 구분 표시되고 클릭하면 추가 질문 영역으로 이동한다", async ({ page }) => {
  const target = needsCheckTask("need-a", "확인 필요한 업무", ["입력 자료 형식을 알려 주세요"]);
  const other = diagnosedTask("ok-a", "일반 업무");
  await openMatrix(page, [other, target]);
  await expect(counts(page).getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true })).toBeVisible();
  // 좌측 목록: 정보 확인 필요 업무만 별도 배지로 구분되고, Gate 배지는 그대로 유지된다.
  const targetRow = matrixList(page).getByRole("listitem").filter({ hasText: target.name });
  await expect(targetRow.locator(".ax-needs-check-badge")).toHaveText("정보 확인 필요");
  await expect(targetRow.locator(".ax-gate-badge")).toHaveCount(1);
  await expect(matrixList(page).getByRole("listitem").filter({ hasText: other.name }).locator(".ax-needs-check-badge")).toHaveCount(0);

  await counts(page).getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(target.name);
  await expect(page.locator("#ax-answer-section")).toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(target.id);
  // 스크롤이 추가 질문 영역까지 실제로 이동한다.
  await expect.poll(async () => (await page.locator("#ax-answer-section").boundingBox())?.y ?? 9999).toBeLessThan(200);
});

test("정보 확인 필요 업무 1개(추가 질문 없음): 확인할 사항 영역으로 이동한다", async ({ page }) => {
  const target = needsCheckTask("need-b", "확인 사항만 있는 업무", []);
  await openMatrix(page, [target]);
  await counts(page).getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(target.name);
  await expect(page.locator("#ax-answer-section")).toHaveCount(0);
  const checks = page.locator(".ax-diag-checks");
  await expect(checks).toBeVisible();
  await expect(checks).toContainText("확인할 사항");
  await expect.poll(async () => (await checks.boundingBox())?.y ?? 9999).toBeLessThan(200);
});

test("정보 확인 필요 업무 2개: 선택 목록에서 고른 업무의 확인 영역으로 이동한다", async ({ page }) => {
  const first = needsCheckTask("need-1", "첫 번째 확인 업무", ["질문 1"]);
  const second = needsCheckTask("need-2", "두 번째 확인 업무", ["질문 2"]);
  const other = diagnosedTask("ok-1", "일반 업무");
  await openMatrix(page, [other, first, second]);
  await counts(page).getByRole("button", { name: "정보 확인 필요 업무 2개", exact: true }).click();
  // base-ui Menu는 팝업의 접근성 이름을 트리거에서 가져온다(클러스터 팝업과 같은 방식).
  const menu = page.getByRole("menu", { name: "정보 확인 필요 업무 2개", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(menu.getByRole("menuitem").nth(0)).toHaveText(first.name);
  await expect(menu.getByRole("menuitem").nth(1)).toHaveText(second.name);
  await menu.getByRole("menuitem").nth(1).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(second.name);
  await expect(page.locator("#ax-answer-section")).toBeVisible();
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(second.id);
});

test("재진단으로 확인 필요 상태가 해제되면 상단 바로가기가 사라진다", async ({ page }) => {
  const target = needsCheckTask("need-c", "재진단 대상 업무", ["입력 자료 형식을 알려 주세요"]);
  await page.route("**/api/ai", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
  });
  await openMatrix(page, [target]);
  await counts(page).getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true }).click();
  await expect(page.locator("#ax-answer-section")).toBeVisible();
  await page.locator("#ax-answer-section textarea").first().fill("형식을 확인했습니다");
  await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
  await expect.poll(async () => (await record(page))?.tasks[0].diagnosis?.informationSufficiency).toBe("sufficient");
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(counts(page)).not.toContainText("정보 확인 필요");
  await expect(counts(page).getByRole("button")).toHaveCount(0);
});
