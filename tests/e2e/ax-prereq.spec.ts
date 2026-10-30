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
  await expect(section.getByRole("heading", { name: "구현 전 확인", exact: true })).toBeVisible();
  return section;
}

test("① 구현 전 확인: 미완료 항목 목록 + 중복 제거", async ({ page }) => {
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='구현 전 확인']");
  // Gate conditional: 전체 진행 보류 배지는 표시되지 않고 확인 필요 건수만 표시된다.
  const head = block.locator(".ax-precheck-head");
  await expect(head).not.toContainText("진행 보류");
  // 7건 = 기존 7건 (예시 체계 제거로 '업무 처리 예시 확인 필요' 1건이 사라진다)
  await expect(head).toContainText("확인 필요 7건");
  // ①은 항상 표시된다 (접힘 아코디언 없음).
  // 추가 확인 사항 박스(제목·표·미확정 배지)는 제거됐다.
  await expect(block.getByRole("heading", { name: "추가 확인 사항" })).toHaveCount(0);
  await expect(block.locator(".ax-prereq-extra, .ax-prereq-table")).toHaveCount(0);
  // 제거된 박스의 '미확정' 배지는 없어야 한다. 예시 항목이 사라져 '미확정' 문구도 남지 않는다.
  await expect(block.getByText("미확정", { exact: true })).toHaveCount(0);
  await expect(block.locator(".ax-precheck-item").filter({ hasText: "업무 처리 예시 확인 필요" })).toHaveCount(0);
  // Items: one per technical check + card-duplicate가 아닌 조건도 같은 목록 영역에 유지된다
  // (3 technical checks + 3 plan integrations + plan prerequisite = 7)
  // 결정 지점 D1~D7은 ① 목록에 들어가지 않는다. 중복 항목이 아님을 아래에서 1건으로 확인한다.
  const items = block.locator(".ax-precheck-item");
  await expect(items).toHaveCount(7);
  await expect(items.first()).toContainText("데이터 형식");
  await expect(items.first().locator(".ax-check-badge").first()).toHaveText("확인 필요");
  await expect(items.first()).not.toContainText("적용 단계 확인 필요");
  // "시스템 연동" 항목이 API 확인을 포함하고, 독립 조건들도 목록에 그대로 보인다.
  for (const text of ["파일 시스템 접근 권한", "사내 시스템 UI 연동 여부", "데이터 구조·검증 규칙 정의"]) {
    await expect(block.locator(".ax-precheck-item").filter({ hasText: text }).first()).toBeVisible();
  }
  // 각 항목에는 실제 확인·수정 위치로 이동하는 버튼이 있다.
  // 반복 문구 "업무 진단에서 확인"은 쓰지 않는다 (예시 항목 제거 후 7건 모두 확인 사항).
  await expect(block.getByRole("button", { name: "업무 진단에서 확인", exact: true })).toHaveCount(0);
  await expect(block.getByRole("button", { name: "확인 사항 보기", exact: true })).toHaveCount(7);
  await expect(block.getByRole("button", { name: "규칙 확인", exact: true })).toHaveCount(0);
  const overflow = await block.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-desktop-1440x900.png") });
});

test("① 구현 전 확인: 모바일 390px 세로 배치 + 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='구현 전 확인']");
  const items = block.locator(".ax-precheck-item");
  // 데스크톱과 같은 7건 (예시 체계 제거로 예시 항목 1건이 사라진다)
  await expect(items).toHaveCount(7);
  // Items stack vertically (기술 점검 항목 + 추가 조건 항목 모두)
  const boxes = await items.evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]).toBeGreaterThan(boxes[i - 1]);
  // 추가 확인 사항 표는 모바일에서도 존재하지 않는다
  await expect(block.locator(".ax-prereq-table")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-mobile-390x844.png") });
});

test("① 구현 전 확인: 차단 사유는 별도로 유지된다", async ({ page }) => {
  const diagnosis: AxDiagnosis = { ...diagnosisFixture, decisionGate: { verdict: "no-go", reasons: ["승인권자 미지정"] } };
  const task = taskFixture("prereq-blocked", { ...diagnosis, planCodex: planFixture });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const block = page.locator("section[aria-label='구현 전 확인']");
  // Gate blocked인 경우에만 ① 헤더에 전체 진행 보류 배지가 표시된다.
  await expect(block.locator(".ax-precheck-head")).toContainText("진행 보류");
  const blocked = block.locator(".ax-precheck-blocked");
  await expect(blocked).toContainText("차단 사유");
  await expect(blocked).toContainText("승인권자 미지정");
});
