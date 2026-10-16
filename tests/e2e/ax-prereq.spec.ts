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
  await expect(section.getByRole("heading", { name: "02 시작 전 확인" })).toBeVisible();
  return section;
}

test("02 시작 전 확인: 상단 카드 3열 + 추가 확인 표 + 중복 제거", async ({ page }) => {
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='02 시작 전 확인']");
  await expect(block.getByText("구현 전에 필요한 조건과 적용 범위를 확인합니다.", { exact: true })).toBeVisible();
  // Top cards: one per technical check, badge shown once, no repeated 안내
  const cards = block.locator(".ax-prereq-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toContainText("데이터 형식");
  await expect(cards.first().locator(".ax-check-badge")).toHaveText("확인 필요");
  await expect(cards.first()).not.toContainText("적용 단계 확인 필요");
  // Additional checks table: only non-duplicate conditions, full width
  const extra = block.locator(".ax-prereq-extra");
  await expect(extra.getByRole("heading", { name: "추가 확인 사항" })).toBeVisible();
  for (const header of ["확인 항목", "확인 필요 내용", "적용 단계", "상태"]) {
    await expect(extra.locator("thead").getByText(header, { exact: true })).toBeVisible();
  }
  // "시스템 연동" card covers the API check; the independent conditions stay as rows
  // (3 plan integrations + the plan's own prerequisite)
  const rows = extra.locator(".ax-prereq-table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(extra.getByText("파일 시스템 접근 권한", { exact: true })).toBeVisible();
  await expect(extra.getByText("사내 시스템 UI 연동 여부", { exact: true })).toBeVisible();
  await expect(extra.getByText("데이터 구조·검증 규칙 정의", { exact: true })).toBeVisible();
  await expect(extra.getByText("미확정", { exact: false }).first()).toBeVisible();
  // No horizontal overflow from the redesigned section
  const overflow = await block.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-desktop-1440x900.png") });
});

test("02 시작 전 확인: 모바일 390px 세로 배치 + 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='02 시작 전 확인']");
  const cards = block.locator(".ax-prereq-card");
  await expect(cards).toHaveCount(3);
  // Cards stack vertically
  const boxes = await cards.evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
  expect(boxes[1]).toBeGreaterThan(boxes[0]);
  expect(boxes[2]).toBeGreaterThan(boxes[1]);
  // Table rows become vertical info blocks; badge and title do not overlap
  const firstRow = block.locator(".ax-prereq-table tbody tr").first();
  await expect(firstRow).toBeVisible();
  const overlap = await firstRow.evaluate(row => {
    const badge = row.querySelector(".ax-check-badge")!.getBoundingClientRect();
    const item = row.querySelector(".ax-prereq-item")!.getBoundingClientRect();
    return badge.left < item.right && badge.right > item.left && badge.top < item.bottom && badge.bottom > item.top;
  });
  expect(overlap).toBe(false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-mobile-390x844.png") });
});

test("02 시작 전 확인: 차단 사유 카드는 별도로 유지된다", async ({ page }) => {
  const diagnosis: AxDiagnosis = { ...diagnosisFixture, decisionGate: { verdict: "no-go", reasons: ["승인권자 미지정"] } };
  const task = taskFixture("prereq-blocked", { ...diagnosis, planCodex: planFixture });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const block = page.locator("section[aria-label='02 시작 전 확인']");
  const blocked = block.locator(".ax-prereq-blocked");
  await expect(blocked).toContainText("차단 사유");
  await expect(blocked).toContainText("승인권자 미지정");
  await expect(blocked.locator(".ax-check-badge")).toHaveText("진행 보류");
});
