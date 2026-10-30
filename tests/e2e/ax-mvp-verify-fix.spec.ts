import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTask, type VerificationResult } from "../../src/lib/ax/types";

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
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, value);
}

async function openPlan(page: Page, task: AxTask) {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(plan).toBeVisible();
  return plan;
}

async function storedRounds(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const request = tx.objectStore("state").get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const tasks = (record as { tasks?: Array<{ verificationResults?: unknown[] }> } | undefined)?.tasks ?? [];
    return tasks.flatMap(task => task.verificationResults ?? []);
  });
}

test("fix prompt section is absent from the default result screen but saved rounds data is preserved", async ({ page }) => {
  const round: VerificationResult = {
    reportedAt: new Date().toISOString(),
    failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
  };
  const task = { ...taskFixture("fix-a", { ...diagnosisFixture, planCodex: planFixture }), name: "수정 지시문 확인 업무", verificationResults: [round] };
  const plan = await openPlan(page, task);
  // 기본 화면에서는 검증 입력 양식·미리보기·라운드 목록이 렌더링되지 않는다.
  await expect(plan.getByRole("region", { name: "검증 결과와 수정·보완 지시문", exact: true })).toHaveCount(0);
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
  await expect(plan.getByRole("button", { name: "검증 결과 저장", exact: true })).toHaveCount(0);
  // 저장된 라운드 데이터는 그대로 유지되고, 새로고침 후에도 사라지지 않는다.
  // 저장은 300ms 디바운스 후 IndexedDB에 기록되므로, 실제 기록을 확인한 뒤 새로고침한다.
  await expect.poll(() => storedRounds(page)).toHaveLength(1);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect.poll(() => storedRounds(page)).toHaveLength(1);
});

test("fix prompt section is absent from the default result screen even when the gate is blocked", async ({ page }) => {
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture, decisionGate: { verdict: "no-go" as const, reasons: ["권한 확인"] } };
  const task: AxTask = { ...taskFixture("fix-blocked", diagnosis), name: "차단 업무" };
  const plan = await openPlan(page, task);
  await expect(plan.getByRole("region", { name: "검증 결과와 수정·보완 지시문", exact: true })).toHaveCount(0);
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
  // 올인원 차단 문구는 그대로 하나만 존재한다 (기존 allinone-integrity 단언과 충돌하지 않음).
  await expect(plan.getByText("현재 진단에서는 구현 계획 생성 불가")).toHaveCount(1);
});
