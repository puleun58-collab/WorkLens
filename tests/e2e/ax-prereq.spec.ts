import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";
import type { AxDiagnosis } from "../../src/lib/ax/types";

// Review screenshots go to a local dir when available (dev machine),
// otherwise to Playwright's test output dir (CI).
function reviewShotPath(name: string): string {
  const preferred = `/home/hatch/workspace/prereq-review/${name}`;
  try {
    mkdirSync(dirname(preferred), { recursive: true });
    return preferred;
  } catch {
    const fallback = test.info().outputPath(name);
    mkdirSync(dirname(fallback), { recursive: true });
    return fallback;
  }
}

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
}
async function seed(page: Page, value: unknown) {
  await page.evaluate(async record => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(record, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, value);
}
const prereqDiagnosis = (): AxDiagnosis => ({
  ...diagnosisFixture,
  decisionGate: { verdict: "conditional", reasons: [] },
  technicalChecks: [
    { topic: "데이터 형식", status: "확인 필요", note: "컬럼명·형식 및 필수값 정의 확인 필요" },
    { topic: "시스템 연동", status: "확인 필요", note: "사내 시스템 API 존재 여부, 접근 권한과 인증 방식 확인 필요" },
    { topic: "인증 방식", status: "확인 필요", note: "적용 가능한 인증 방식과 권한 범위 확인 필요" },
  ],
});
const prereqPlan = () => ({
  ...planFixture,
  integrations: ["파일 시스템 접근 권한 확인", "사내 시스템 UI 연동 여부 확인", "데이터 구조·검증 규칙 정의 확인"],
});
async function openStep4(page: Page) {
  const task = taskFixture("prereq-redesign", { ...prereqDiagnosis(), planCodex: prereqPlan() });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(section.getByRole("heading", { name: "진단 결과 요약", exact: true })).toBeVisible();
  return section;
}

test("구현 전 확인: 독립 영역 없이 미확정 조건은 실행 상태·올인원 지시문에 남는다", async ({ page }) => {
  const section = await openStep4(page);
  // 결과·로드맵의 독립 '구현 전 확인' 영역과 노란 확인 필요 카드는 표시하지 않는다.
  await expect(page.getByRole("region", { name: "구현 전 확인", exact: true })).toHaveCount(0);
  await expect(section.locator(".ax-verdict-card")).toHaveCount(3);
  await expect(section.locator(".ax-verdict-card dt")).toHaveText(["자동화 적합", "AI 보조 적합", "담당자 수행"]);
  // 미확정 필수 조건은 실행 상태에서 확정으로 바뀌지 않는다.
  await expect(page.locator(".ax-report-intro .ax-gate-badge")).toHaveText("확인 후 진행");
  // 화면에서 제거된 조건도 지시문에는 확인 대상으로 그대로 남는다.
  await section.getByRole("region", { name: "올인원 지시문", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).click();
  const prompt = section.locator(".ax-prompt");
  for (const text of ["데이터 형식", "시스템 연동", "인증 방식"]) await expect(prompt).toContainText(text);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await section.screenshot({ path: reviewShotPath("prereq-desktop-1440x900.png") });
});

test("구현 전 확인: 모바일 390px에서도 독립 영역 없이 가로 스크롤이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await openStep4(page);
  await expect(page.getByRole("region", { name: "구현 전 확인", exact: true })).toHaveCount(0);
  await expect(section.locator(".ax-verdict-card")).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await section.screenshot({ path: reviewShotPath("prereq-mobile-390x844.png") });
});

test("구현 전 확인: 차단 시 선택 업무 헤더에 진행 보류가 표시되고 차단 사유 상세는 반복하지 않는다", async ({ page }) => {
  const diagnosis: AxDiagnosis = { ...diagnosisFixture, decisionGate: { verdict: "no-go", reasons: ["승인권자 미지정"] } };
  const task = taskFixture("prereq-blocked", { ...diagnosis, planCodex: planFixture });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  await expect(page.getByRole("region", { name: "구현 전 확인", exact: true })).toHaveCount(0);
  await expect(page.locator(".ax-report-intro .ax-gate-badge")).toHaveText("진행 보류");
  // 차단 사유 상세 문구는 기본 화면에 반복되지 않는다 (상세는 업무 진단 단계에 있다).
  await expect(page.locator(".ax-selected-report")).not.toContainText("승인권자 미지정");
});
