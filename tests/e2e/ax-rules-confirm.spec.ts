import type { Page } from "@playwright/test";
import type { AxStateV2, AxTaskV2, GenericRule } from "../../src/lib/ax/types";
import { expect, test } from "@playwright/test";
import { emptyAxState } from "../../src/lib/ax/types";
import { buildAllInOnePrompt } from "../../src/lib/ax/guide";
import { diagnosisFixture, outputFixture, planFixture, taskFixture } from "../fixtures/ax";
import { navigateWorkspace } from "./navigation";
import { chooseOption } from "./ax-rules";

async function stored(page: Page): Promise<AxStateV2> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise<AxStateV2>(resolve => { const req = db.transaction("state").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
    db.close(); return value;
  });
}
async function seed(page: Page, task: AxTaskV2) {
  await page.goto("/");
  await page.evaluate(async state => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onupgradeneeded = () => req.result.createObjectStore("state"); req.onsuccess = () => resolve(req.result); });
    await new Promise<void>(resolve => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(state, "current"); tx.oncomplete = () => resolve(); });
    db.close();
  }, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
}
const rule: GenericRule = { id: "R1", name: "확인 기준", category: "처리·판단 기준", applicability: "적용", status: "확정", detail: "식별표 ABC에 따라 승인한다", linkedDecisionId: "D1", source: "기존 근거 ABC", step: "기존 단계 ABC" };
const prompt = (task: AxTaskV2) => buildAllInOnePrompt(planFixture, "codex", { diagnosis: task.diagnosis, genericRules: task.genericRules });
async function save(page: Page) {
  const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
  await section.getByRole("button", { name: "저장", exact: true }).click();
  await expect(section.getByText("업무 규칙을 저장했습니다", { exact: true })).toBeVisible();
}
async function report(page: Page) {
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-report-intro")).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
}

for (const width of [1440, 390]) test(`범용 확정 버튼: 기존 기록·재확정·메타데이터·지시문 ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const task: AxTaskV2 = { ...taskFixture("confirm", { ...diagnosisFixture, planCodex: planFixture, decisionPoints: [{ id: "D1", status: "확정", detail: "기존 D 비교 기준" }] }), genericRules: [rule, { ...rule, id: "R2", name: "과거 빈 확정", detail: undefined }] };
  await seed(page, task);
  const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
  const row = section.locator("#ax-rule-R1");
  await row.locator(".ax-decision-row-head").click();
  await expect(row.getByRole("combobox", { name: "확정 상태" })).toHaveCount(0);
  await expect(row.getByText("추가 정보 (선택)")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "확정 취소", exact: true })).toBeEnabled();
  await save(page);
  await expect.poll(async () => (await stored(page)).tasks[0].genericRules).toEqual(task.genericRules);
  expect(prompt((await stored(page)).tasks[0])).toBe(prompt(task));
  await row.getByRole("textbox", { name: "추가 기준 (선택)", exact: true }).fill("수정 기준 XYZ로 승인한다");
  await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
  await save(page);
  await expect.poll(async () => (await stored(page)).tasks[0].genericRules?.[0].status).toBe("미확정");
  expect(prompt((await stored(page)).tasks[0])).not.toContain("수정 기준 XYZ로 승인한다");
  await row.getByRole("button", { name: "확정", exact: true }).click();
  // Clicking confirm changes only the draft until the existing bottom save is used.
  expect((await stored(page)).tasks[0].genericRules?.[0].status).toBe("미확정");
  const geometry = await row.evaluate(element => {
    // COSS paints the input border on its wrapper; the native textarea is inset by 1px.
    const textarea = element.querySelector('[data-slot="textarea-control"]')!.getBoundingClientRect();
    const button = element.querySelector(".ax-rule-confirm button")!.getBoundingClientRect();
    return { right: Math.abs(textarea.right - button.right), gap: button.top - textarea.bottom };
  });
  expect(geometry.right).toBeLessThanOrEqual(0.1);
  expect(geometry.gap).toBeGreaterThanOrEqual(8);
  expect(geometry.gap).toBeLessThanOrEqual(12);
  await row.screenshot({ path: `artifacts/rulesui/confirm-${width}.png` });
  await chooseOption(row, "적용 여부", "미적용");
  await expect(row.getByRole("textbox", { name: "추가 기준 (선택)", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "확정 취소", exact: true })).toHaveCount(0);
  await save(page);
  await expect.poll(async () => (await stored(page)).tasks[0].genericRules?.[0].applicability).toBe("해당 없음");
  expect((await stored(page)).tasks[0].genericRules?.[0]).toMatchObject({ status: "확정", detail: "수정 기준 XYZ로 승인한다", source: rule.source, step: rule.step, linkedDecisionId: rule.linkedDecisionId });
  expect(prompt((await stored(page)).tasks[0])).not.toContain("수정 기준 XYZ로 승인한다");
  await chooseOption(row, "적용 여부", "적용");
  await expect(row.getByRole("textbox", { name: "추가 기준 (선택)", exact: true })).toHaveValue("수정 기준 XYZ로 승인한다");
  await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
  await row.getByRole("button", { name: "확정", exact: true }).click();
  await save(page);
  await expect.poll(async () => (await stored(page)).tasks[0].genericRules?.[0].status).toBe("확정");
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await section.locator("#ax-rule-R2 .ax-decision-row-head").click();
  await expect(section.locator("#ax-rule-R2").getByRole("button", { name: "확정 취소", exact: true })).toBeEnabled();
  await section.locator("#ax-rule-R2").getByRole("button", { name: "확정 취소", exact: true }).click();
  // 추가 기준은 선택 입력이므로 과거의 빈 확정 기록도 취소 후 재확정할 수 있다.
  await expect(section.locator("#ax-rule-R2").getByRole("button", { name: "확정", exact: true })).toBeEnabled();
  await section.locator("#ax-rule-R2").getByRole("button", { name: "확정", exact: true }).click();
  await expect(section.locator("#ax-rule-R2 .ax-decision-badge")).toHaveText("확정");
  await report(page);
  const completion = page.getByRole("region", { name: "완료 기준", exact: true });
  await completion.getByRole("button", { name: /^완료 기준/ }).click();
  const criterion = completion.locator(".ax-plan-step").first();
  await criterion.getByRole("button", { name: "보기", exact: true }).click();
  const reviewPanel = criterion.locator(".ax-plan-review-panel");
  await reviewPanel.getByRole("radio", { name: /유지/ }).check();
  await reviewPanel.getByRole("button", { name: "확정", exact: true }).click();
  await expect(criterion.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
  const output = page.locator(".ax-prompt");
  await expect(output).toContainText("수정 기준 XYZ로 승인한다");
  await expect(output).toContainText("[관련 단계: 기존 단계 ABC] [근거: 기존 근거 ABC] [연계: D1]");
  expect(errors).toEqual([]);
});

test("신규 등록·진단 제안을 적용하고 명시적 확정 후 저장하여 지시문에 전달", async ({ page }) => {
  await page.route("**/api/ai", route => route.fulfill({ json: { data: route.request().postDataJSON().kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: outputFixture() } } }));
  await page.goto("/");
  await navigateWorkspace(page, "업무 자동화 진단");
  await page.getByLabel("업무명", { exact: true }).fill("신규 확인 업무");
  await page.getByLabel("업무 설명", { exact: true }).fill("입력 표를 취합하고 담당자가 최종 승인합니다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
  const row = section.locator(".ax-decision-row").filter({ hasText: "최종 승인" });
  await row.locator(".ax-decision-row-head").click();
  await expect(row.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
  await chooseOption(row, "적용 여부", "적용");
  const confirm = row.getByRole("button", { name: "확정", exact: true });
  // 요청된 선택 입력 계약: 빈 값과 공백만 있는 추가 기준 모두 확정을 막지 않는다.
  await expect(confirm).toBeEnabled();
  await row.getByLabel("추가 기준 (선택)", { exact: true }).fill("   ");
  await expect(confirm).toBeEnabled();
  await row.getByLabel("추가 기준 (선택)", { exact: true }).fill("신규 식별표 NEW를 담당자가 확인한다");
  await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
  await confirm.click();
  await expect(row.locator(".ax-decision-badge")).toHaveText("확정");
  await save(page);
  await expect.poll(async () => (await stored(page)).tasks[0].genericRules?.find(item => item.name === "최종 승인")?.status).toBe("확정");
  const saved = (await stored(page)).tasks[0];
  expect(saved.genericRules?.find(item => item.name === "최종 승인")?.linkedDecisionId).toBeUndefined();
  expect(prompt(saved)).toContain("신규 식별표 NEW를 담당자가 확인한다");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  const completion = page.getByRole("region", { name: "완료 기준", exact: true });
  await completion.getByRole("button", { name: /^완료 기준/ }).click();
  const criterion = completion.locator(".ax-plan-step").first();
  await criterion.getByRole("button", { name: "보기", exact: true }).click();
  const reviewPanel = criterion.locator(".ax-plan-review-panel");
  await reviewPanel.getByRole("radio", { name: /유지/ }).check();
  await reviewPanel.getByRole("button", { name: "확정", exact: true }).click();
  await expect(page.locator(".ax-prompt")).toContainText("신규 식별표 NEW를 담당자가 확인한다");
});

test("범용 규칙 저장 실패는 기존 데이터와 확정 초안을 보존한다", async ({ page }) => {
  await seed(page, { ...taskFixture("failed-confirm", diagnosisFixture), genericRules: [rule] });
  const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
  const row = section.locator("#ax-rule-R1");
  await row.locator(".ax-decision-row-head").click();
  const original = (await stored(page)).tasks[0].genericRules;
  await row.getByRole("textbox", { name: "추가 기준 (선택)", exact: true }).fill("저장 실패에도 보존할 편집 기준");
  await row.getByRole("button", { name: "확정", exact: true }).click();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "state") throw new DOMException("Test quota exhausted", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await section.getByRole("button", { name: "저장", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("입력 내용은 유지됩니다");
  await expect(row.getByRole("textbox", { name: "추가 기준 (선택)", exact: true })).toHaveValue("저장 실패에도 보존할 편집 기준");
  await expect(row.getByRole("button", { name: "확정 취소", exact: true })).toBeEnabled();
  expect((await stored(page)).tasks[0].genericRules).toEqual(original);
});

for (const width of [1440, 390]) test(`추가 기준 선택 입력: 제안·저장·신규 규칙의 빈 확정·취소·재확정 ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const task: AxTaskV2 = {
    ...taskFixture("optional-detail", { ...diagnosisFixture, decisionPoints: [{ id: "D1", status: "확정", detail: "기존 D 비교 기준" }] }),
    genericRules: [rule, { id: "R2", name: "저장된 빈 규칙", category: "처리·판단 기준", applicability: "적용 여부 미확정", status: "미확정" }],
  };
  await seed(page, task);
  const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
  const candidate = section.locator(".ax-decision-row").filter({ has: page.locator(".ax-decision-no-new", { hasText: "제안" }) }).filter({ hasText: "최종 승인" });
  const candidateTitle = await candidate.locator(".ax-decision-title strong").innerText();
  const initialProgress = await section.locator(".ax-decision-progress strong").innerText();
  const [initialDone, total] = initialProgress.match(/\d+/g)!.map(Number);
  await candidate.locator(".ax-decision-row-head").click();
  await expect(candidate.getByRole("combobox", { name: "적용 여부", exact: true })).toHaveText("선택하세요");
  await expect(candidate.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
  await chooseOption(candidate, "적용 여부", "적용");
  const detail = candidate.getByRole("textbox", { name: "추가 기준 (선택)", exact: true });
  await expect(detail).toHaveValue("");
  await expect(detail).toHaveAttribute("placeholder", "추가로 명확히 할 조건이 있을 때만 입력하세요");
  await expect(candidate.getByRole("button", { name: "확정", exact: true })).toBeEnabled();
  await candidate.getByRole("button", { name: "확정", exact: true }).click();
  await expect(candidate.locator(".ax-decision-badge")).toHaveText("확정");
  await expect(section.locator(".ax-decision-progress strong")).toHaveText(`${initialDone + 1}/${total} 완료`);
  await candidate.getByRole("button", { name: "확정 취소", exact: true }).click();
  await expect(candidate.locator(".ax-decision-badge")).toHaveText("미확정");
  await expect(section.locator(".ax-decision-progress strong")).toHaveText(initialProgress);
  await candidate.getByRole("button", { name: "확정", exact: true }).click();
  await save(page);
  let saved = (await stored(page)).tasks[0];
  const savedCandidate = saved.genericRules!.find(item => item.name === candidateTitle)!;
  expect(savedCandidate).toMatchObject({ applicability: "적용", status: "확정" });
  expect(savedCandidate.detail ?? "").toBe("");
  expect(prompt(saved)).toContain(`${savedCandidate.id} ${candidateTitle} (${savedCandidate.category}) — 확정`);
  expect(saved.genericRules!.find(item => item.id === "R1")).toEqual(rule);
  expect(saved.diagnosis!.decisionPoints).toEqual(task.diagnosis!.decisionPoints);

  const savedRow = section.locator(`#ax-rule-${savedCandidate.id}`);
  await savedRow.locator(".ax-decision-row-head").click();
  const savedDetail = savedRow.getByRole("textbox", { name: "추가 기준 (선택)", exact: true });
  await savedDetail.fill("선택적으로 작성한 담당자 검토 조건");
  await expect(savedRow.locator(".ax-decision-badge")).toHaveText("미확정");
  await savedRow.getByRole("button", { name: "확정", exact: true }).click();
  await save(page);
  saved = (await stored(page)).tasks[0];
  expect(saved.genericRules!.find(item => item.id === savedCandidate.id)).toMatchObject({ name: candidateTitle, detail: "선택적으로 작성한 담당자 검토 조건", status: "확정" });
  expect(prompt(saved)).toContain("선택적으로 작성한 담당자 검토 조건");

  const existing = section.locator("#ax-rule-R2");
  await existing.locator(".ax-decision-row-head").click();
  await expect(existing.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
  await chooseOption(existing, "적용 여부", "적용");
  await expect(existing.getByRole("textbox", { name: "추가 기준 (선택)", exact: true })).toHaveValue("");
  await existing.getByRole("button", { name: "확정", exact: true }).click();
  await expect(existing.locator(".ax-decision-badge")).toHaveText("확정");
  await existing.getByRole("button", { name: "확정 취소", exact: true }).click();
  await existing.getByRole("button", { name: "확정", exact: true }).click();

  await section.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const newRow = section.locator("#ax-rule-new");
  await newRow.getByLabel("규칙명", { exact: true }).fill("추가 기준 없는 신규 규칙");
  await chooseOption(newRow, "분류", "처리·판단 기준");
  await expect(newRow.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
  await chooseOption(newRow, "적용 여부", "적용");
  await expect(newRow.getByRole("textbox", { name: "추가 기준 (선택)", exact: true })).toHaveValue("");
  await newRow.getByRole("button", { name: "확정", exact: true }).click();
  await expect(newRow.getByRole("button", { name: "확정 취소", exact: true })).toBeEnabled();
  await newRow.getByRole("button", { name: "확정 취소", exact: true }).click();
  await newRow.getByRole("button", { name: "확정", exact: true }).click();
  await newRow.getByRole("button", { name: "추가", exact: true }).click();
  await save(page);
  saved = (await stored(page)).tasks[0];
  expect(saved.genericRules!.find(item => item.id === "R2")).toMatchObject({ applicability: "적용", status: "확정" });
  expect(saved.genericRules!.find(item => item.name === "추가 기준 없는 신규 규칙")).toMatchObject({ applicability: "적용", status: "확정" });
  expect(saved.genericRules!.find(item => item.id === "R1")).toEqual(rule);
  expect(saved.diagnosis!.decisionPoints).toEqual(task.diagnosis!.decisionPoints);
  expect(prompt(saved)).toContain("추가 기준 없는 신규 규칙 (처리·판단 기준) — 확정");
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  expect((await stored(page)).tasks[0].genericRules).toEqual(saved.genericRules);
  await expect(section.locator(".ax-decision-progress strong")).toHaveText(`${initialDone + 3}/${total + 1} 완료`);
});
