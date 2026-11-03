import { expect, test, type Page } from "@playwright/test";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxStateV2 } from "../../src/lib/ax/types";
import { axDiagnosisOutputSchema, confirmedAxDiagnosis } from "../../src/lib/ax/schema";
import { navigateWorkspace } from "./navigation";

async function stored(page: Page): Promise<AxStateV2> {
  return page.evaluate(async () => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const open = indexedDB.open("worklens-ax", 1);
    open.onsuccess = () => opened.resolve(open.result);
    open.onerror = () => opened.reject(open.error);
    const db = await opened.promise;
    const loaded = Promise.withResolvers<AxStateV2>();
    const request = db.transaction("state").objectStore("state").get("current");
    request.onsuccess = () => loaded.resolve(request.result);
    request.onerror = () => loaded.reject(request.error);
    const value = await loaded.promise;
    db.close(); return value;
  });
}

for (const width of [1440, 390]) test(`출력 조건의 편집·저장·재진단과 업무 격리 ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const diagnosis: AxDiagnosis = {
    ...structuredClone(diagnosisFixture),
    asIs: { ...diagnosisFixture.asIs, outputs: ["result.csv"] },
    poc: { ...diagnosisFixture.poc, outputs: ["result.csv"] },
    technicalChecks: [
      { topic: "시스템 접근", status: "확인 필요", note: "권한 확인" },
      { topic: "D4 결과 상태", status: "확인 필요", note: "상태 확인" },
      { topic: "HITL 검토", status: "확인 필요", note: "담당자 검토" },
      { topic: "구현 계획 검토", status: "확인 필요", note: "계획 검토" },
      { topic: "업무 정보 보완", status: "확인 필요", note: "설명 확인" },
      { topic: "원본 보존", status: "확인 필요", note: "원본 확인" },
      { topic: "오류 복구", status: "확인 필요", note: "복구 확인" },
    ],
    decisionGate: { verdict: "go", reasons: [] },
    decisionPoints: (["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const).map(id => ({ id, status: "해당 없음" as const })),
    planCodex: { ...planFixture, prerequisites: [] },
  };
  const task = { ...taskFixture("output-current", diagnosis), outputs: "result.csv" };
  const other = taskFixture("other-task", diagnosis);
  await page.goto("/");
  await page.evaluate(async state => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const open = indexedDB.open("worklens-ax", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("state");
    open.onsuccess = () => opened.resolve(open.result);
    open.onerror = () => opened.reject(open.error);
    const db = await opened.promise;
    const saved = Promise.withResolvers<void>();
    const transaction = db.transaction("state", "readwrite");
    transaction.objectStore("state").put(state, "current");
    transaction.oncomplete = () => saved.resolve();
    transaction.onerror = () => saved.reject(transaction.error);
    await saved.promise;
    db.close();
  }, { ...emptyAxState(), tasks: [task, other], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("region", { name: "구현 전 확인", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "등록 정보 수정", exact: true }).click();
  await expect(page.getByRole("heading", { name: "등록 정보 수정", exact: true })).toBeVisible();
  expect((await stored(page)).selectedTaskId).toBe(task.id);
  await page.getByRole("button", { name: "추가 정보", exact: true }).click();
  const output = "result.csv (컬럼: 거래일, 금액; 타입·형식: 거래일=날짜, 금액=숫자)";
  await page.locator("#ax-registration-outputs").fill(output);
  await page.getByRole("button", { name: "수정 등록", exact: true }).click();
  await expect.poll(async () => (await stored(page)).tasks[0].outputs).toBe(output);
  const edited = await stored(page);
  expect(edited.tasks[0].diagnosis).toEqual(task.diagnosis);
  expect(edited.tasks[1]).toEqual(other);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  expect((await stored(page)).tasks[0].outputs).toBe(output);
  await page.route("**/api/ai", async route => {
    const request = route.request().postDataJSON();
    expect(request.details.outputs).toBe(output);
    const incoming = { ...diagnosisFixture, technicalChecks: diagnosis.technicalChecks, decisionGate: diagnosis.decisionGate, asIs: { ...diagnosis.asIs, outputs: [output] }, poc: { ...diagnosis.poc, outputs: [output] } };
    await route.fulfill({ json: { data: { kind: "ax-diagnosis", diagnosis: axDiagnosisOutputSchema.parse(confirmedAxDiagnosis(incoming)) } } });
  });
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: "업무 다시 진단", exact: true }).click();
  await expect.poll(async () => (await stored(page)).tasks[0].diagnosis?.poc.outputs).toEqual([output]);
  expect((await stored(page)).tasks[0].diagnosisRegistration).toBeUndefined();
  const savedDiagnosis = (await stored(page)).tasks[0].diagnosis;
  expect(savedDiagnosis?.technicalChecks).toEqual(diagnosis.technicalChecks);
  expect((await stored(page)).tasks[1]).toEqual(other);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
