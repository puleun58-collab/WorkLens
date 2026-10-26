import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";

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
// 계획이 없는 진단: 02 블록 문구 검증용 (04 탭은 렌더링되지 않는다).
async function openStep4NoPlan(page: Page) {
  const task = taskFixture("step04-spacing", diagnosisFixture);
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(section.getByRole("heading", { name: "02 구현 전 확인사항" })).toBeVisible();
  return section;
}
// 한쪽 도구에 계획이 있을 때만 반대쪽 탭에 안내 문구 + 생성 버튼이 표시된다.
// (양쪽 계획이 없으면 탭 UI 대신 안내 문단만 표시된다.)
async function openStep4WithPlan(page: Page, existing: "codex" | "claude") {
  const diagnosis = existing === "codex"
    ? { ...diagnosisFixture, planCodex: planFixture }
    : { ...diagnosisFixture, planClaude: planFixture };
  const task = taskFixture(`step04-spacing-${existing}`, diagnosis);
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await ax(page);
  const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(section.getByRole("heading", { name: "02 구현 전 확인사항" })).toBeVisible();
  return section;
}
async function hintButtonGap(page: Page, tab: "Codex" | "Claude Code") {
  const section = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await section.getByRole("tab", { name: tab, exact: true }).click();
  const hint = section.locator(".ax-plan-generate-hint");
  const button = section.locator(".ax-plan-generate");
  await expect(hint).toBeVisible();
  await expect(button).toBeVisible();
  // 두 박스를 한 번의 evaluate 안에서 읽는다. html에 scroll-behavior: smooth가
  // 있어 탭 클릭 후 스크롤 애니메이션이 진행 중일 때, boundingBox를 두 번
  // 나누어 호출하면 스크롤 위치가 달라져 간격이 왜곡된다(CI Firefox에서
  // 219~229px로 측정된 것이 이 경합이다). 한 프레임 안에서는 일관된다.
  const gap = await section.evaluate(root => {
    const upper = root.querySelector(".ax-plan-generate-hint");
    const lower = root.querySelector(".ax-plan-generate");
    if (!upper || !lower) return null;
    const u = upper.getBoundingClientRect();
    const l = lower.getBoundingClientRect();
    return Math.round(l.top - (u.top + u.height));
  });
  expect(gap).not.toBeNull();
  // 렌더링 기준 간격: 버튼 상단 - 안내 문구 하단
  return gap!;
}

test("02 구현 전 확인사항: 제목·보조 설명 변경 + 기존 확인사항 유지", async ({ page }) => {
  const section = await openStep4NoPlan(page);
  const block = section.locator("section[aria-label='02 구현 전 확인사항']");
  await expect(section.getByRole("heading", { name: "02 시작 전 확인" })).toHaveCount(0);
  await block.getByRole("button", { name: /구현 전 확인사항/ }).click();
  await expect(block.getByText("아래 항목은 자동화 구현 전에 확인해야 할 조건입니다. 실제 업무 환경과 자료를 기준으로 확인해 주세요.", { exact: true })).toBeVisible();
  await expect(block.getByText("구현 전에 필요한 조건과 적용 범위를 확인합니다.", { exact: true })).toHaveCount(0);
  // 기존 확인사항 유지: 기술 점검 카드와 확인 필요 배지
  await expect(block.locator(".ax-prereq-card").filter({ hasText: "시스템 접근" }).first()).toBeVisible();
  await expect(block.locator(".ax-prereq-card").first().locator(".ax-check-badge")).toHaveText("확인 필요");
  // 제목·설명·카드 사이 간격이 자연스럽다(설명 하단 여백 존재, 겹침 없음).
  // 위쪽·아래쪽 박스를 한 번의 evaluate 안에서 읽는다(스크롤 경합 방지).
  const descCardsGap = await block.evaluate(root => {
    const upper = root.querySelector(".ax-plan-desc");
    const lower = root.querySelector(".ax-prereq-cards");
    if (!upper || !lower) return null;
    const u = upper.getBoundingClientRect();
    const l = lower.getBoundingClientRect();
    return Math.round(l.top - (u.top + u.height));
  });
  expect(descCardsGap).not.toBeNull();
  expect(descCardsGap!).toBeGreaterThanOrEqual(12);
});

test("04 올인원 지시문: 안내 문구와 생성 버튼 간격 12~16px (Codex·Claude 동일)", async ({ page }) => {
  // Claude 계획만 있을 때 Codex 탭에 힌트 + 생성 버튼이 표시된다.
  let section = await openStep4WithPlan(page, "claude");
  const codexGap = await hintButtonGap(page, "Codex");
  expect(codexGap).toBeGreaterThanOrEqual(12);
  expect(codexGap).toBeLessThanOrEqual(16);
  await expect(section.locator(".ax-plan-generate-hint")).toHaveText("Codex용 구현 계획 생성 후 올인원 지시문 확인");
  await expect(section.locator(".ax-plan-generate")).toHaveText(/Codex용 구현 계획 생성/);
  // Codex 계획만 있을 때 Claude 탭에 힌트 + 생성 버튼이 표시된다.
  section = await openStep4WithPlan(page, "codex");
  const claudeGap = await hintButtonGap(page, "Claude Code");
  expect(claudeGap).toBeGreaterThanOrEqual(12);
  expect(claudeGap).toBeLessThanOrEqual(16);
  expect(Math.abs(codexGap - claudeGap)).toBeLessThanOrEqual(1);
  await expect(section.locator(".ax-plan-generate-hint")).toHaveText("Claude Code용 구현 계획 생성 후 올인원 지시문 확인");
  await expect(section.locator(".ax-plan-generate")).toHaveText(/Claude Code용 구현 계획 생성/);
  // 탭 전환 후 레이아웃 겹침 없음(한 번의 evaluate로 원자 측정)
  const overlapGap = await section.evaluate(root => {
    const upper = root.querySelector(".ax-plan-generate-hint");
    const lower = root.querySelector(".ax-plan-generate");
    if (!upper || !lower) return null;
    const u = upper.getBoundingClientRect();
    const l = lower.getBoundingClientRect();
    return Math.round(l.top - (u.top + u.height));
  });
  expect(overlapGap).not.toBeNull();
  expect(overlapGap!).toBeGreaterThan(0);
});

test("04 올인원 지시문: 모바일 390px 간격·줄바꿈·가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStep4WithPlan(page, "claude");
  const codexGap = await hintButtonGap(page, "Codex");
  expect(codexGap).toBeGreaterThanOrEqual(12);
  expect(codexGap).toBeLessThanOrEqual(16);
  await openStep4WithPlan(page, "codex");
  const claudeGap = await hintButtonGap(page, "Claude Code");
  expect(claudeGap).toBeGreaterThanOrEqual(12);
  expect(claudeGap).toBeLessThanOrEqual(16);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
