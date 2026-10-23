import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTask } from "../../src/lib/ax/types";
import { taskStatus } from "../../src/lib/ax/policy";

// 매트릭스 상단 집계와 결과·로드맵 KPI 보조 설명이 공통 집계·표시 함수를 공유하는지 검증한다.
// 시드·기록 헬퍼는 ax-matrix-nav.spec.ts와 같은 방식(IndexedDB worklens-ax)을 쓴다.
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
function withDiagnosis(id: string, name: string, mutate: (d: typeof diagnosisFixture) => void): AxTask {
  const diagnosis = structuredClone(diagnosisFixture);
  mutate(diagnosis);
  return { ...taskFixture(id, diagnosis), name, status: taskStatus(diagnosis) };
}
const readyTask = (id: string, name: string) => withDiagnosis(id, name, d => {
  d.decisionGate = { verdict: "go", reasons: [] };
  d.technicalChecks = [{ topic: "시스템 접근", status: "확인됨", note: "API 확인 완료" }];
});
const conditionalTask = (id: string, name: string) => withDiagnosis(id, name, () => {});
const blockedTask = (id: string, name: string) => withDiagnosis(id, name, d => {
  d.decisionGate = { verdict: "no-go", reasons: ["개인정보 처리 정책상 자동화 불가"] };
});
const needsCheckTask = (id: string, name: string, questions: string[]) => withDiagnosis(id, name, d => {
  d.informationSufficiency = "needs-check";
  d.followUpQuestions = questions;
});
const registeredTask = (id: string, name: string): AxTask => ({ ...taskFixture(id), name });

async function openAt(page: Page, tasks: AxTask[], step: number) {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step });
  await ax(page);
}
const matrixCounts = (page: Page) => page.locator(".ax-matrix-counts");
const resultKpi = (page: Page) => page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) });

test("혼합 상태: 매트릭스 상단과 결과·로드맵 KPI의 상태 문구가 완전히 일치한다", async ({ page }) => {
  const tasks = [
    readyTask("ready", "진행 가능 업무"),
    conditionalTask("cond", "확인 후 진행 업무"),
    blockedTask("blocked", "진행 보류 업무"),
    needsCheckTask("need", "정보 확인 업무", ["입력 자료 형식을 알려 주세요"]),
    registeredTask("reg", "등록만 된 업무"),
  ];
  await openAt(page, tasks, 3);
  // needs-check 업무는 Gate로는 확인 후 진행이면서 정보 확인 필요 축에도 별도 집계된다.
  await expect(matrixCounts(page)).toHaveText("진단 완료 4/5 · 진행 가능 1 · 확인 후 진행 2 · 진행 보류 1 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(resultKpi(page).locator("strong")).toHaveText("4개");
  // KPI 보조 설명은 매트릭스에서 "진단 완료 4/5 · " 접두만 제외한 것과 동일해야 한다.
  await expect(resultKpi(page).locator("small")).toHaveText("진행 가능 1 · 확인 후 진행 2 · 진행 보류 1 · 정보 확인 필요 업무 1개");
});

test("0건인 상태는 두 화면 모두 표시하지 않는다", async ({ page }) => {
  await openAt(page, [conditionalTask("c1", "업무 c1"), conditionalTask("c2", "업무 c2")], 3);
  await expect(matrixCounts(page)).toHaveText("진단 완료 2/2 · 확인 후 진행 2");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(resultKpi(page).locator("small")).toHaveText("확인 후 진행 2");
  await expect(resultKpi(page).locator("small")).not.toContainText("진행 가능");
  await expect(resultKpi(page).locator("small")).not.toContainText("정보 확인 필요");
});

test("진단 완료 0건이면 로드맵은 빈 상태를 표시하고 매트릭스는 완료 건수만 표시한다", async ({ page }) => {
  // 진단 0건에서는 결과·로드맵이 KPI 대신 기존 빈 상태 문구를 표시한다(제품 동작 유지).
  await openAt(page, [registeredTask("r1", "업무 r1"), registeredTask("r2", "업무 r2")], 4);
  await expect(page.getByText("완료된 진단 결과 없음")).toBeVisible();
  await expect(page.locator(".ax-kpi")).toHaveCount(0);
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await expect(matrixCounts(page)).toHaveText("진단 완료 0/2");
});

test("결과·로드맵 KPI 바로가기 1건: 클릭하면 업무 진단 단계의 추가 질문 영역으로 이동한다", async ({ page }) => {
  const target = needsCheckTask("need", "확인 필요한 업무", ["입력 자료 형식을 알려 주세요"]);
  await openAt(page, [readyTask("ok", "일반 업무"), target], 4);
  await resultKpi(page).locator("small").getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(target.name);
  await expect(page.locator("#ax-answer-section")).toBeVisible();
  await expect.poll(async () => (await page.locator("#ax-answer-section").boundingBox())?.y ?? 9999).toBeLessThan(200);
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(target.id);
});

test("결과·로드맵 KPI 바로가기 다건: 선택 목록에서 고른 업무로 이동한다 (키보드)", async ({ page }) => {
  const first = needsCheckTask("need-1", "첫 번째 확인 업무", ["질문 1"]);
  const second = needsCheckTask("need-2", "두 번째 확인 업무", ["질문 2"]);
  await openAt(page, [first, second, readyTask("ok", "일반 업무")], 4);
  const trigger = resultKpi(page).locator("small").getByRole("button", { name: "정보 확인 필요 업무 2개", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "정보 확인 필요 업무 2개", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(second.name);
  await expect.poll(async () => (await record(page))?.selectedTaskId).toBe(second.id);
});

test("모바일 390px에서도 두 화면 문구가 일치하고 KPI 바로가기가 동작한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const target = needsCheckTask("need", "모바일 확인 업무", ["질문"]);
  await openAt(page, [conditionalTask("cond", "조건부 업무"), target], 3);
  await expect(matrixCounts(page)).toHaveText("진단 완료 2/2 · 확인 후 진행 2 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(resultKpi(page).locator("small")).toHaveText("확인 후 진행 2 · 정보 확인 필요 업무 1개");
  await resultKpi(page).locator("small").getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(target.name);
});
