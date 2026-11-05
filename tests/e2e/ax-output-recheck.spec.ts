import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxStateV2, type AxTaskV2 } from "../../src/lib/ax/types";
import { axDiagnosisOutputSchema, axTaskV2Schema, confirmedAxDiagnosis } from "../../src/lib/ax/schema";
import { applyCheckConfirmations, checkConfirmationState, upsertCheckConfirmation } from "../../src/lib/ax/check-confirmations";
import { extractReviewableItems } from "../../src/lib/ax/hitl";
import { buildAllInOnePrompt, planSummary } from "../../src/lib/ax/guide";
import { navigateWorkspace } from "./navigation";

const QUESTION = "산출물의 형식과 필드 순서·타입을 알려주세요";
const ANSWER = "result.csv (컬럼: 거래일, 금액; 타입: 거래일=날짜, 금액=숫자; 순서: 거래일 다음 금액)";
async function stored(page: Page): Promise<AxStateV2> {
  return page.evaluate(async () => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("worklens-ax", 1);
    request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    try {
      const loaded = Promise.withResolvers<AxStateV2>();
      const read = db.transaction("state").objectStore("state").get("current");
      read.onsuccess = () => loaded.resolve(read.result); read.onerror = () => loaded.reject(read.error);
      return await loaded.promise;
    } finally { db.close(); }
  });
}
async function seed(page: Page, task: AxTaskV2) {
  axTaskV2Schema.parse(task);
  await page.goto("/");
  await page.evaluate(async state => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("worklens-ax", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    const saved = Promise.withResolvers<void>();
    const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(state, "current");
    tx.oncomplete = () => saved.resolve(); tx.onerror = () => saved.reject(tx.error);
    await saved.promise; db.close();
  }, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
}
function initial(): AxTaskV2 {
  const diagnosis: AxDiagnosis = { ...structuredClone(diagnosisFixture),
    followUpQuestions: [QUESTION], informationSufficiency: "needs-check",
    asIs: { ...diagnosisFixture.asIs, outputs: ["result.csv"] },
    poc: { ...diagnosisFixture.poc, outputs: ["result.csv"] },
    technicalChecks: [
      { topic: "출력 컬럼", status: "확인 필요", note: "컬럼명·순서·타입 미확정", required: true },
      { topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인", required: true },
    ],
  };
  const item = extractReviewableItems(diagnosis).find(item => item.type === "step")!;
  return { ...taskFixture("output-recheck", diagnosis), status: "needs-info", checkConfirmations: upsertCheckConfirmation(undefined, diagnosis.technicalChecks[1], { result: "확인 완료", note: "확인" }, "2026-11-01T00:00:00.000Z"),
    reviews: [{ id: "saved-hitl", target: { key: item.key, type: item.type, source: item.source, sourceText: item.text, sourceHash: item.sourceHash }, action: "keep", status: "confirmed", comment: "기존 검토 기록", reviewedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }] };
}
for (const width of [1440, 390]) test(`출력 답변은 재진단 전 확인을 해소하지 않고 실패·부분·무관 응답과 기존 기록을 보존한다 ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  const before = initial();
  let response = structuredClone(before.diagnosis!);
  let fail = false;
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/ai", async route => {
    const request = route.request().postDataJSON(); requests.push(request);
    if (fail) { await route.fulfill({ status: 503, json: { error: "재진단 일시 중단" } }); return; }
    await route.fulfill({ json: { data: request.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: axDiagnosisOutputSchema.parse(confirmedAxDiagnosis(response)) } } });
  });
  await seed(page, before);
  const input = page.getByLabel(QUESTION, { exact: true });
  const pending = page.locator(".ax-diag-checks > ul > li");
  await expect(pending).toHaveCount(1);
  await expect(page.locator(".ax-diag-checks-head")).toContainText("1건");
  await expect(input).toBeVisible();
  // F: automatic pre-request save is durable, but failed AI must not mutate diagnosis or confirmations.
  await input.fill(ANSWER); fail = true;
  await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
  await expect(page.getByText(/진단 실패/)).toBeVisible();
  await expect(input).toHaveValue(ANSWER);
  let task = (await stored(page)).tasks[0];
  expect(task.followUpResponses?.[0].answer).toBe(ANSWER);
  expect(task.diagnosis).toEqual(before.diagnosis);
  expect(task.checkConfirmations).toEqual(before.checkConfirmations);
  expect(task.reviews).toEqual(before.reviews);
  expect(String(requests[0].description)).toContain(ANSWER);
  await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
  await expect(input).toHaveValue(ANSWER);
  // B/C: saved text, including irrelevant text, never auto-confirms technical checks.
  fail = false;
  for (const answer of ["파일명은 result.csv입니다. 순서와 타입은 아직 미정입니다.", "오늘 점심은 김밥입니다."]) {
    await input.fill(answer);
    await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
    await expect(page.getByRole("button", { name: "답변 반영 후 재진단", exact: true })).toBeEnabled();
    await expect.poll(async () => (await stored(page)).tasks[0].followUpDiagnosis?.description).toContain(answer);
    expect(String(requests.at(-1)?.description)).toContain(answer);
    await expect(pending).toHaveCount(1);
    await expect(page.locator(".ax-diag-checks-head")).toContainText("1건");
    await expect(input).toBeVisible();
    task = (await stored(page)).tasks[0];
    expect(task.diagnosis?.technicalChecks[0].status).toBe("확인 필요");
    expect(task.checkConfirmations).toEqual(before.checkConfirmations);
    expect(task.reviews).toEqual(before.reviews);
    const effective = applyCheckConfirmations(task.diagnosis!, task.checkConfirmations);
    // The technical check and derived CSV specification warning have separate provenance.
    expect(planSummary(effective).checks.filter(check => check.status !== "확인됨")).toHaveLength(2);
    await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
    await expect(page.getByRole("region", { name: "구현 전 확인", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
    await page.getByRole("region", { name: "올인원 지시문", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).click();
    await expect(page.locator(".ax-prompt")).toContainText("출력 컬럼 미확정");
    await expect(page.locator(".ax-prompt")).toContainText("컬럼명·순서·타입 미확정");
    await expect(page.getByRole("region", { name: "완료 기준", exact: true })).toContainText("대조 통과");
    await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  }
  // A/E: only the fixed new diagnosis resolves the output check; unchanged records remain unique.
  response = { ...response, informationSufficiency: "sufficient", followUpQuestions: [], asIs: { ...response.asIs, outputs: [ANSWER] }, poc: { ...response.poc, outputs: [ANSWER] }, technicalChecks: response.technicalChecks.map((check, index) => index === 0 ? { ...check, status: "확인됨", note: "사용자 지정 컬럼명·순서·타입 확인" } : check) };
  await input.fill(ANSWER);
  await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
  await expect.poll(async () => (await stored(page)).tasks[0].diagnosis?.informationSufficiency).toBe("sufficient");
  await expect(pending).toHaveCount(0);
  await expect(page.locator(".ax-diag-checks-head")).toContainText("0건");
  await expect(page.getByRole("button", { name: "확인 완료 항목 보기 (2건)" })).toBeVisible();
  task = (await stored(page)).tasks[0];
  expect(task.checkConfirmations).toEqual(before.checkConfirmations);
  expect(task.reviews).toEqual(before.reviews);
  expect(checkConfirmationState(task.diagnosis!.technicalChecks[1], task.checkConfirmations).kind).toBe("applied");
  await page.getByRole("region", { name: "단계별 자동화 판단", exact: true }).locator('[data-slot="accordion-trigger"]').click();
  await expect(page.locator('#ax-step-review [data-status="confirmed"]')).toHaveCount(1);
  await mkdir("D:/hageon/ax-recheck-shots", { recursive: true });
  await page.screenshot({ path: `D:/hageon/ax-recheck-shots/diagnosis-${width}.png`, fullPage: true });
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.getByRole("region", { name: "구현 전 확인", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  const promptRegion = page.getByRole("region", { name: "올인원 지시문", exact: true });
  await promptRegion.getByRole("button", { name: "전체 보기", exact: true }).click();
  task = (await stored(page)).tasks[0];
  const effective = applyCheckConfirmations(task.diagnosis!, task.checkConfirmations);
  expect(planSummary(effective, task.diagnosis!.planCodex).checks.filter(check => check.status !== "확인됨")).toHaveLength(0);
  const prompt = buildAllInOnePrompt(task.diagnosis!.planCodex, "codex", { diagnosis: effective, taskName: task.name, context: task.followUpDiagnosis?.context, hitlReviews: task.reviews, hitlTool: "codex", genericRules: task.genericRules });
  await expect(page.locator(".ax-prompt")).toContainText("실제 데이터로 검증");
  expect(prompt).not.toContain("출력 컬럼 미확정");
  expect(prompt).toContain("실행하지 않은 테스트나 배포를 완료로 표시하지 마세요");
  await expect(page.getByRole("region", { name: "완료 기준", exact: true })).toContainText("대조 통과");
  await page.screenshot({ path: `D:/hageon/ax-recheck-shots/roadmap-${width}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
