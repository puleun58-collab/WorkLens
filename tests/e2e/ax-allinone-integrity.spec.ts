import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxTask } from "../../src/lib/ax/types";
import { taskStatus } from "../../src/lib/ax/policy";
import { REPOSITORY_FIRST } from "../../src/lib/ax/schema";

function makeDiagnosis(): AxDiagnosis {
  const diagnosis: AxDiagnosis = structuredClone(diagnosisFixture);
  diagnosis.factors = diagnosis.factors.map((factor, index) => ({ ...factor, aiValue: [4, 4, 3, 2, 4, 3][index] }));
  diagnosis.informationSufficiency = "partial";
  diagnosis.asIs = {
    purpose: "월간 운임 정산 검토", trigger: "매월 말 담당자 실행", inputs: ["운송 실적 Excel", "운임표"],
    steps: ["실적 파일 병합", "누락·중복 검증", "정산표 생성", "정산 승인"], outputs: ["정산표 생성 결과"],
    exceptions: ["운임표 미매칭"], humanDecisions: ["정산 승인"], systems: ["Excel", "ERP"],
  };
  diagnosis.stepAssessments = [
    { step: "실적 파일 병합", verdict: "AI 보조", owner: "AI", note: "로컬 스크립트로 Excel 파일을 병합하고 담당자가 결과를 확인" },
    { step: "누락·중복 검증", verdict: "AI 보조", owner: "AI", note: "필수 항목 누락과 운송장 번호 중복 여부를 검사하는 규칙 기반 알고리즘" },
    { step: "정산표 생성", verdict: "자동화", owner: "시스템", note: "확정 운임표에 따라 금액 계산 후 정산표 생성" },
    { step: "정산 승인", verdict: "사람 유지", owner: "사용자", note: "담당자가 금액 검토 후 승인" },
  ];
  diagnosis.humanInLoop = ["정산 승인"];
  diagnosis.technicalChecks = [
    { topic: "실적 파일 병합", status: "확인 필요", note: "Excel 샘플 확보" },
    { topic: "ERP 읽기 권한", status: "확인 필요", note: "향후 ERP 반영 단계에서만 필요" },
  ];
  diagnosis.poc = { hypothesis: "검토할 누락·중복을 표시할 수 있다", inScope: [], outOfScope: ["정산 자동 승인"], inputs: ["운송 실적 샘플"], outputs: ["실적 파일 병합 — 병합 검토 파일"], evaluation: ["누락·중복 검증 — 샘플 누락·중복 검사"], success: ["누락·중복 검증 — 누락 건이 모두 검토 대상으로 표시"], failure: ["누락 건이 정상 결과로 표시"] };
  diagnosis.decisionGate = { verdict: "conditional", reasons: ["Excel 샘플과 운임표 확인 후 진행"] };
  diagnosis.operation = { owner: "업무 담당", failureOwner: "운영 담당", maintenanceBurden: "medium", fallback: "기존 수동 절차로 처리", notes: [] };
  return diagnosis;
}
const linkedPlan = {
  repositoryFirst: REPOSITORY_FIRST,
  goal: ["월간 운임 정산 검토 지원"], asIs: [], toBe: [],
  inScope: ["실적 파일 병합", "누락·중복 검증"],
  outOfScope: ["정산 자동 승인", "ERP 자동 전송"],
  prerequisites: ["실적 파일 병합 — Excel 샘플 확보", "정산표 생성 — 운임표 확정", "ERP 읽기 권한 확인"],
  humanInLoop: ["정산 승인"],
  poc: [],
  implementation: ["실적 파일 병합 — Excel 샘플의 컬럼 구조 확인", "누락·중복 검증 — 운송장 번호 중복 검사", "정산 승인 — 자동 승인 로직"],
  dataFlow: ["운송 실적 Excel → 병합 검토 파일 → 담당자 확인"],
  integrations: ["ERP 읽기 API 연동"],
  exceptions: ["운임표 미매칭 건 분리"], fallback: ["기존 수동 절차로 처리"],
  security: ["실적 파일 외부 전송 전 보안 조건 확인"], operation: [],
  tests: ["누락·중복 검증 — 샘플 누락·중복 검사"],
  acceptance: ["누락·중복 검증 — 누락 건이 모두 검토 대상으로 표시", "계약서상 정산 오차율 0.5% 이내 확인"],
};
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
async function openPlanSection(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/ai", async route => {
    const input = route.request().postDataJSON();
    if (input.kind === "ax-plan") { await route.fulfill({ json: { data: { kind: "ax-plan", plan: linkedPlan } } }); return; }
    await route.fulfill({ json: { data: { kind: "ax-diagnosis", diagnosis: input } } });
  });
  const task = { ...taskFixture("t1", makeDiagnosis()), name: "월간 운임 정산" };
  const withStatus: AxTask = { ...task, status: taskStatus(makeDiagnosis()) };
  await seedAndOpen(page, [withStatus], 4);
  const packageSection = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await packageSection.scrollIntoViewIfNeeded();
  await expect(packageSection.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  return packageSection;
}
test("allinone: linked plan renders composite processing and step-linked scope", async ({ page }) => {
  if (process.env.MOBILE_EMU === "1") await page.setViewportSize({ width: 390, height: 844 });
  const packageSection = await openPlanSection(page);
  const prompt = packageSection.locator(".ax-prompt");
  await expect(prompt).toContainText("복합 처리 (확인된 순서): 일반 시스템·스크립트 처리 → 담당자 확인");
  await expect(prompt).toContainText("실적 파일 병합 — Excel 샘플의 컬럼 구조 확인");
  await expect(prompt).toContainText("계약서상 정산 오차율 0.5% 이내 확인");
  await expect(prompt).toContainText("현재 자동화 제외");
  const scope = packageSection.getByRole("region", { name: "구현 범위·완료 기준", exact: true });
  await expect(scope).not.toContainText("정산 승인 — 자동 승인 로직");
  // 범위 행은 건수만 표시한다 (합본 간소화): 항목 본문은 01~04 지시문에 유지된다.
  await expect(scope.locator('[data-scope-group="scope"]')).toContainText(/구현 대상 \d+개 · 담당자 수행 \d+개 · 보류·제외 \d+개/);
  await expect(scope.locator('[data-scope-group="scope"]')).not.toContainText("복합 처리 (확인된 순서)");
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(noOverflow).toBe(true);
  await page.screenshot({ path: `artifacts/ax/allinone-${process.env.MOBILE_EMU === "1" ? "mobile" : test.info().project.name}.png`, fullPage: true });
});
test("allinone: tool tab switch keeps the same policy scope", async ({ page }) => {
  const packageSection = await openPlanSection(page);
  const codexText = await packageSection.locator(".ax-prompt").textContent();
  await packageSection.getByRole("tab", { name: /Claude/ }).first().click();
  await expect(page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true })).toBeVisible();
  const claudeText = await packageSection.locator(".ax-prompt").textContent();
  for (const marker of ["담당자가 요청할 때 후보·초안을 제안", "해당 조건에 의존하는 단계만 구현하세요", "복합 처리 (확인된 순서)", "정산 승인"]) {
    expect(codexText).toContain(marker);
    expect(claudeText).toContain(marker);
  }
});
test("allinone: blocked task shows review-only restriction", async ({ page }) => {
  const diagnosis = makeDiagnosis();
  diagnosis.decisionGate = { verdict: "no-go", reasons: ["안전 승인은 담당자의 법적 책임"] };
  diagnosis.factors = diagnosis.factors.map(factor => ({ ...factor, aiValue: factor.key === "humanJudgment" || factor.key === "operationalRisk" ? 5 : 2 }));
  const task = { ...taskFixture("t2", diagnosis), name: "작업 허가 승인", status: taskStatus(diagnosis) as AxTask["status"] };
  await seedAndOpen(page, [task], 4);
  const packageSection = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await packageSection.scrollIntoViewIfNeeded();
  await expect(packageSection.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true })).toBeDisabled();
  await expect(packageSection.getByText("현재 진단에서는 구현 계획 생성 불가", { exact: false })).toBeVisible();
});
