import { expect, test, type Locator, type Page } from "@playwright/test";
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

/** 올인원 지시문 하단의 검증 결과 기록 진입 버튼·입력 양식·미리보기가 없는지 확인한다. */
async function expectNoVerificationUi(plan: Locator) {
  await expect(plan.getByRole("region", { name: "검증 결과 기록", exact: true })).toHaveCount(0);
  await expect(plan.getByRole("button", { name: /검증 결과 기록/ })).toHaveCount(0);
  await expect(plan.getByRole("button", { name: "검증 결과 입력 열기", exact: true })).toHaveCount(0);
  await expect(plan.getByRole("region", { name: "검증 결과와 수정·보완 지시문", exact: true })).toHaveCount(0);
  await expect(plan.getByLabel("실패 기능")).toHaveCount(0);
  await expect(plan.getByRole("button", { name: "검증 결과 저장", exact: true })).toHaveCount(0);
  await expect(plan).not.toContainText("저장된 검증 라운드");
}

test("verification record UI is removed below the all-in-one instruction for both tools, but saved rounds are preserved", async ({ page }) => {
  const round: VerificationResult = {
    reportedAt: new Date().toISOString(),
    failures: [{ feature: "자료 수집", expected: "합계 1,000", actual: "합계 950" }],
  };
  const task = { ...taskFixture("fix-a", { ...diagnosisFixture, planCodex: planFixture, planClaude: planFixture }), name: "수정 지시문 확인 업무", verificationResults: [round] };
  const plan = await openPlan(page, task);
  // 올인원 지시문·전달 검사는 그대로 표시되고, 그 아래 검증 기록 UI만 없다.
  await expect(plan.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  await expect(plan.getByText("전달 검사: 확정 0건 중 전달 0건 · 문제 0건")).toBeVisible();
  await expectNoVerificationUi(plan);
  await plan.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(plan.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true })).toBeVisible();
  await expectNoVerificationUi(plan);
  // 저장된 라운드 데이터는 그대로 유지되고, 새로고침 후에도 사라지지 않는다.
  // 저장은 300ms 디바운스 후 IndexedDB에 기록되므로, 실제 기록을 확인한 뒤 새로고침한다.
  await expect.poll(() => storedRounds(page)).toHaveLength(1);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await expectNoVerificationUi(page.getByRole("region", { name: "자동화 구현 계획", exact: true }));
  await expect.poll(() => storedRounds(page)).toEqual([round]);
});

test("verification record UI is absent when no rounds are saved", async ({ page }) => {
  const task = { ...taskFixture("fix-empty", { ...diagnosisFixture, planCodex: planFixture }), name: "기록 없음 업무" };
  const plan = await openPlan(page, task);
  await expect(plan.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  await expectNoVerificationUi(plan);
});

test("fix prompt section is absent from the default result screen even when the gate is blocked", async ({ page }) => {
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture, decisionGate: { verdict: "no-go" as const, reasons: ["권한 확인"] } };
  const task: AxTask = { ...taskFixture("fix-blocked", diagnosis), name: "차단 업무" };
  const plan = await openPlan(page, task);
  await expectNoVerificationUi(plan);
  // 올인원 차단 문구는 그대로 하나만 존재한다 (기존 allinone-integrity 단언과 충돌하지 않음).
  await expect(plan.getByText("현재 진단에서는 구현 계획 생성 불가")).toHaveCount(1);
});
