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
  await expect(section.getByRole("region", { name: "구현 전 확인", exact: true })).toBeVisible();
  return section;
}

test("① 구현 전 확인: 요약 배지만 표시 + 상세 목록·이동 버튼 없음", async ({ page }) => {
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='구현 전 확인']");
  // Gate conditional: 전체 진행 보류 배지는 표시되지 않고 미해결 건수만 표시된다.
  const head = block.locator(".ax-precheck-head");
  await expect(head).not.toContainText("진행 보류");
  // 7건 = #371 예시 체계 제거 후 기준('업무 처리 예시 확인 필요' 1건 제외), 배지 문구는 #373 레퍼런스 기준 "미해결"
  await expect(head).toContainText("미해결 7건");
  // 요약 전용: 상세 목록·차단 블록·항목별 이동 버튼은 기본 화면에 없다.
  // 추가 확인 사항 박스(제목·표·미확정 배지)는 제거됐다.
  await expect(block.getByRole("heading", { name: "추가 확인 사항" })).toHaveCount(0);
  await expect(block.locator(".ax-precheck-item, .ax-precheck-blocked, .ax-prereq-extra, .ax-prereq-table")).toHaveCount(0);
  // 제거된 박스의 '미확정' 배지는 없어야 한다. 예시 항목이 사라져 '미확정' 문구도 남지 않는다.
  await expect(block.getByText("미확정", { exact: true })).toHaveCount(0);
  // 반복 문구 "업무 진단에서 확인"은 쓰지 않는다. 이전 항목별 버튼도 없다.
  await expect(block.getByRole("button", { name: "업무 진단에서 확인", exact: true })).toHaveCount(0);
  await expect(block.getByRole("button", { name: "확인 사항 보기", exact: true })).toHaveCount(0);
  await expect(block.getByRole("button", { name: "규칙 확인", exact: true })).toHaveCount(0);
  // 상세 항목 문구는 기본 화면에 반복되지 않는다 (상세는 업무 진단 단계에 있다).
  for (const text of ["데이터 형식", "파일 시스템 접근 권한", "사내 시스템 UI 연동 여부", "데이터 구조·검증 규칙 정의", "업무 처리 예시 확인 필요"]) {
    await expect(block).not.toContainText(text);
  }
  const overflow = await block.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-desktop-1440x900.png") });
});

test("① 구현 전 확인: 모바일 390px 요약 배지 + 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='구현 전 확인']");
  // 데스크톱과 같은 7건 (예시 체계 제거 후 기준), 배지 문구는 #373 레퍼런스 기준 "미해결"
  await expect(block.locator(".ax-precheck-head")).toContainText("미해결 7건");
  // 요약 전용: 상세 목록은 모바일에서도 존재하지 않는다
  await expect(block.locator(".ax-precheck-item, .ax-prereq-table")).toHaveCount(0);
  await expect(block).not.toContainText("데이터 형식");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-mobile-390x844.png") });
});

test("① 구현 전 확인: 차단 시 진행 보류 배지만 표시되고 차단 사유 상세는 기본 화면에 없다", async ({ page }) => {
  const diagnosis: AxDiagnosis = { ...diagnosisFixture, decisionGate: { verdict: "no-go", reasons: ["승인권자 미지정"] } };
  const task = taskFixture("prereq-blocked", { ...diagnosis, planCodex: planFixture });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const block = page.locator("section[aria-label='구현 전 확인']");
  // Gate blocked인 경우에만 ① 헤더에 전체 진행 보류 배지가 표시된다.
  await expect(block.locator(".ax-precheck-head")).toContainText("진행 보류");
  await expect(block.locator(".ax-precheck-head")).toContainText(/진행 보류 \d+건/);
  // 차단 사유 상세 문구는 기본 화면에 반복되지 않는다 (상세는 업무 진단 단계에 있다).
  await expect(block).not.toContainText("승인권자 미지정");
  await expect(block.locator(".ax-precheck-blocked")).toHaveCount(0);
});
