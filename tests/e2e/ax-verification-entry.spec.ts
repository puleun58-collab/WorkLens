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

test("verification entry is collapsed by default and only renders the form after opening", async ({ page }) => {
  const round: VerificationResult = {
    reportedAt: new Date().toISOString(),
    failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
  };
  const task = { ...taskFixture("verify-entry", { ...diagnosisFixture, planCodex: planFixture }), name: "검증 진입 확인 업무", verificationResults: [round] };
  const plan = await openPlan(page, task);
  // P1 전달 검사 한 줄 요약이 지시문 아래에 표시된다 (규칙 없음 → 0건).
  await expect(plan.getByText("전달 검사: 확정 0건 중 전달 0건 · 문제 0건")).toBeVisible();
  // P3 기본 상태: 접힘 상태의 한 줄 요약만 있고, 대형 폼 입력란은 렌더링되지 않는다.
  const entry = plan.getByRole("region", { name: "검증 결과 기록", exact: true });
  await expect(entry.getByRole("button", { name: "검증 결과 기록 · 수정·보완 지시문 — 기록 1건", exact: true })).toBeVisible();
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
  await expect(plan.getByRole("button", { name: "검증 결과 저장", exact: true })).toHaveCount(0);
  await expect(plan.getByRole("region", { name: "검증 결과와 수정·보완 지시문", exact: true })).toHaveCount(0);
  // 펼치면 라운드 목록·안내·버튼 1개만 보이고, 폼은 여전히 없다.
  await entry.getByRole("button", { name: "검증 결과 기록 · 수정·보완 지시문 — 기록 1건", exact: true }).click();
  await expect(entry.getByText("저장된 검증 라운드")).toBeVisible();
  await expect(entry.getByText("자료 수집")).toBeVisible();
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
  // 버튼을 눌렀을 때만 기존 폼이 그 자리에 렌더링되고, 저장하면 라운드가 추가된다.
  await entry.getByRole("button", { name: "검증 결과 입력 열기", exact: true }).click();
  await expect(plan.getByLabel("실패 기능")).toBeVisible();
  await plan.getByLabel("실패 기능").fill("형식 검증");
  await plan.getByRole("button", { name: "검증 결과 저장", exact: true }).click();
  await expect(plan.getByText("검증 결과를 저장했습니다.")).toBeVisible();
  await expect.poll(() => storedRounds(page)).toHaveLength(2);
});

test("verification entry shows no records state and no form until opened", async ({ page }) => {
  const task = { ...taskFixture("verify-empty", { ...diagnosisFixture, planCodex: planFixture }), name: "기록 없음 업무" };
  const plan = await openPlan(page, task);
  const entry = plan.getByRole("region", { name: "검증 결과 기록", exact: true });
  await expect(entry.getByRole("button", { name: "검증 결과 기록 · 수정·보완 지시문 — 기록 없음", exact: true })).toBeVisible();
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
  await entry.getByRole("button", { name: "검증 결과 기록 · 수정·보완 지시문 — 기록 없음", exact: true }).click();
  await expect(entry.getByText("저장된 검증 라운드가 없습니다.")).toBeVisible();
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
});

test("verification entry shows only the blocked notice when the gate is blocked", async ({ page }) => {
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture, decisionGate: { verdict: "no-go" as const, reasons: ["권한 확인"] } };
  const task: AxTask = { ...taskFixture("verify-blocked", diagnosis), name: "차단 업무" };
  const plan = await openPlan(page, task);
  const entry = plan.getByRole("region", { name: "검증 결과 기록", exact: true });
  await expect(entry.getByText("현재 진단에서는 검증 결과 기록 불가")).toBeVisible();
  await expect(entry.getByRole("button", { name: "검증 결과 입력 열기", exact: true })).toHaveCount(0);
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
});
