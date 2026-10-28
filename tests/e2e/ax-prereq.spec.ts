import { expect, test, type Locator, type Page } from "@playwright/test";
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
  await expect(section.getByRole("heading", { name: "02 구현 전 확인사항" })).toBeVisible();
  return section;
}

// Wait for the 02 accordion transition (200ms) to finish before measuring
// horizontal overflow. While the chevron is still rotating, its transient
// bounding box grows from 16px to 22.63px and exceeds the section's right edge
// by up to 3.31px, which would be misread as steady-state overflow. The
// transition is considered finished only when the chevron width (2 decimals)
// and the block overflow stay identical for 3 consecutive observations spaced
// 50ms apart; the spacing rules out three accidental ties inside a single
// animation frame. This follows the observation-based stable-wait pattern of
// ax-ready-state.ts (no arbitrary sleep, no timeout inflation). The threshold
// (≤ 1) and the assertion itself are unchanged.
async function waitForPrereqAccordionSettled(trigger: Locator, block: Locator): Promise<void> {
  const snapshots: string[] = [];
  await expect.poll(async () => {
    const chevronWidth = await trigger.locator('[data-slot="accordion-indicator"]').evaluate(el => Math.round(el.getBoundingClientRect().width * 100) / 100);
    const overflow = await block.evaluate(el => el.scrollWidth - el.clientWidth);
    snapshots.push(`${chevronWidth}|${overflow}`);
    if (snapshots.length > 3) snapshots.shift();
    if (snapshots.length < 3) return false;
    const [a, b, c] = snapshots;
    return a === b && b === c;
  }, { intervals: [50] }).toBe(true);
}

test("02 구현 전 확인사항: 확인 카드 통합 + 추가 확인 사항 박스 제거 + 중복 제거", async ({ page }) => {
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='02 구현 전 확인사항']");
  // Gate conditional: 전체 진행 보류 배지는 표시되지 않고 확인 필요 건수만 표시된다.
  const trigger = block.getByRole("button", { name: /구현 전 확인사항/ });
  await expect(trigger).not.toContainText("진행 보류");
  await expect(trigger).toContainText("확인 필요 7건");
  // 01~03은 기본 접힘 — 확인이 필요한 블록을 펼쳐서 검증한다.
  await trigger.click();
  await expect(block.getByText("아래 항목은 자동화 구현 전에 확인해야 할 조건입니다. 실제 업무 환경과 자료를 기준으로 확인해 주세요.", { exact: true })).toBeVisible();
  // 추가 확인 사항 박스(제목·표·미확정 배지)는 제거됐다.
  await expect(block.getByRole("heading", { name: "추가 확인 사항" })).toHaveCount(0);
  await expect(block.locator(".ax-prereq-extra, .ax-prereq-table")).toHaveCount(0);
  await expect(block.getByText("미확정", { exact: false })).toHaveCount(0);
  // Cards: one per technical check + card-duplicate가 아닌 조건도 같은 카드 영역에 유지된다
  // (3 technical checks + 3 plan integrations + plan prerequisite = 7)
  const cards = block.locator(".ax-prereq-card");
  await expect(cards).toHaveCount(7);
  await expect(cards.first()).toContainText("데이터 형식");
  await expect(cards.first().locator(".ax-check-badge")).toHaveText("확인 필요");
  await expect(cards.first()).not.toContainText("적용 단계 확인 필요");
  // "시스템 연동" card covers the API check; the independent conditions stay visible as cards
  for (const text of ["파일 시스템 접근 권한", "사내 시스템 UI 연동 여부", "데이터 구조·검증 규칙 정의"]) {
    await expect(block.locator(".ax-prereq-card").filter({ hasText: text }).first()).toBeVisible();
  }
  // No horizontal overflow from the redesigned section. Measure only after
  // the accordion transition ends (see waitForPrereqAccordionSettled).
  await waitForPrereqAccordionSettled(trigger, block);
  const overflow = await block.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-desktop-1440x900.png") });
});

test("02 구현 전 확인사항: 모바일 390px 세로 배치 + 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await openStep4(page);
  const block = section.locator("section[aria-label='02 구현 전 확인사항']");
  await block.getByRole("button", { name: /구현 전 확인사항/ }).click();
  const cards = block.locator(".ax-prereq-card");
  await expect(cards).toHaveCount(7);
  // Cards stack vertically (기술 점검 카드 + 추가 조건 카드 모두)
  const boxes = await cards.evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]).toBeGreaterThan(boxes[i - 1]);
  // 추가 확인 사항 표는 모바일에서도 존재하지 않는다
  await expect(block.locator(".ax-prereq-table")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await block.screenshot({ path: reviewShotPath("prereq-mobile-390x844.png") });
});

test("02 구현 전 확인사항: 차단 사유 카드는 별도로 유지된다", async ({ page }) => {
  const diagnosis: AxDiagnosis = { ...diagnosisFixture, decisionGate: { verdict: "no-go", reasons: ["승인권자 미지정"] } };
  const task = taskFixture("prereq-blocked", { ...diagnosis, planCodex: planFixture });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const block = page.locator("section[aria-label='02 구현 전 확인사항']");
  // Gate blocked인 경우에만 02 헤더에 전체 진행 보류 배지가 표시된다.
  await expect(block.getByRole("button", { name: /구현 전 확인사항/ })).toContainText("진행 보류");
  const blocked = block.locator(".ax-prereq-blocked");
  await expect(blocked).toContainText("차단 사유");
  await expect(blocked).toContainText("승인권자 미지정");
  await expect(blocked.locator(".ax-check-badge")).toHaveText("진행 보류");
});
